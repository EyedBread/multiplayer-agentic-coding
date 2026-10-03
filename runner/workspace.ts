import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { git } from '../server/git.js';
import { repositoryRemote, type RunnerProject } from '../shared/runner.js';

const exec = promisify(execFile);
export type PreparedRepository = { root: string; baseCommit: string; identity: string | null };
function validProject(project: RunnerProject) {
  if (!project || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(project.baseCommit))
    throw new Error(
      'The room has no valid pinned Git commit. Create a room from a committed project.',
    );
}
async function exists(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function safeDirectory(target: string) {
  const existing = await exists(target);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new Error(`Runner directory must be a real directory, not a symlink: ${target}`);
  if (!existing) await mkdir(target, { mode: 0o700 });
}
async function hasCommit(root: string, commit: string) {
  try {
    return (await git(root, 'rev-parse', '--verify', `${commit}^{commit}`)).trim() === commit;
  } catch {
    return false;
  }
}
function safeRemote(project: RunnerProject) {
  const remote = project.remoteUrl ? repositoryRemote(project.remoteUrl) : null;
  if (
    !remote ||
    remote.identity !== project.identity ||
    !/^[a-zA-Z0-9]/.test(new URL(remote.remoteUrl).hostname)
  )
    throw new Error(
      'The room must provide a valid HTTPS or SSH Git remote before cloning or fetching.',
    );
  return remote;
}

export async function prepareRepository(input: {
  repo?: string;
  clone?: string;
  project: RunnerProject;
}): Promise<PreparedRepository> {
  validProject(input.project);
  if (!!input.repo === !!input.clone) throw new Error('Choose exactly one of --repo or --clone.');
  const requested = path.resolve(input.repo || input.clone!);
  if (input.clone) {
    const remote = safeRemote(input.project);
    if (await exists(requested))
      throw new Error('The clone destination already exists. Use --repo for an existing checkout.');
    await mkdir(path.dirname(requested), { recursive: true });
    try {
      await exec(
        'git',
        [
          '-c',
          'protocol.file.allow=never',
          '-c',
          'protocol.ext.allow=never',
          'clone',
          '--no-recurse-submodules',
          '--',
          remote.remoteUrl,
          requested,
        ],
        {
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
    } catch {
      throw new Error(
        'Git clone failed. Check local Git credentials and access to the room repository. Any partial clone was kept for inspection; resume with --repo after repairing it.',
      );
    }
  }
  let root: string;
  try {
    root = await realpath((await git(requested, 'rev-parse', '--show-toplevel')).trim());
  } catch {
    throw new Error(
      `No Git checkout found at ${requested}. Use --repo with a checkout or --clone with a new folder.`,
    );
  }
  if (root !== (await realpath(requested)))
    throw new Error('--repo must point to the repository root, not a subdirectory.');
  const rawRemote = await git(root, 'remote', 'get-url', 'origin').catch(() => '');
  const identity = repositoryRemote(rawRemote)?.identity ?? null;
  if (input.project.identity && identity !== input.project.identity)
    throw new Error(
      'This checkout belongs to a different repository. Its origin must match the room project.',
    );
  if (!(await hasCommit(root, input.project.baseCommit))) {
    const remote = safeRemote(input.project);
    try {
      await exec(
        'git',
        [
          '-c',
          'protocol.file.allow=never',
          '-c',
          'protocol.ext.allow=never',
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--',
          remote.remoteUrl,
          input.project.baseCommit,
        ],
        {
          cwd: root,
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
    } catch {
      throw new Error(
        'Could not fetch the room’s exact starting commit. Push that commit to the shared remote, then resume this runner.',
      );
    }
    if (!(await hasCommit(root, input.project.baseCommit)))
      throw new Error('The room’s pinned commit is not available in this checkout.');
  }
  return {
    root,
    identity: input.project.identity ? identity : null,
    baseCommit: input.project.baseCommit,
  };
}

export async function prepareAgentWorktree(
  repository: PreparedRepository,
  roomId: string,
  agent: { id: string; branch: string },
) {
  if (![roomId, agent.id].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)))
    throw new Error('Invalid room or agent identifier.');
  if (!/^(?:codex|claude)\/[a-zA-Z0-9/_-]{1,180}$/.test(agent.branch))
    throw new Error('Agent branches must use a dedicated codex/ or claude/ name.');
  await git(repository.root, 'check-ref-format', '--branch', agent.branch);
  const base = repository.baseCommit;
  const privateRoot = path.join(repository.root, '.multiplayer');
  await safeDirectory(privateRoot);
  await writeFile(path.join(privateRoot, '.gitignore'), '*\n', { flag: 'wx', mode: 0o600 }).catch(
    (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    },
  );
  const worktrees = path.join(privateRoot, 'worktrees');
  const metadata = path.join(privateRoot, 'runner-state');
  await safeDirectory(worktrees);
  await safeDirectory(metadata);
  await safeDirectory(path.join(worktrees, roomId));
  await safeDirectory(path.join(metadata, roomId));
  const cwd = path.join(worktrees, roomId, agent.id);
  const manifestPath = path.join(metadata, roomId, `${agent.id}.json`);
  const expected = { roomId, agentId: agent.id, branch: agent.branch, base, cwd };
  if (await exists(cwd)) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error(
        'Existing agent worktree has no runner manifest. It was preserved; choose another agent instead of overwriting it.',
      );
    }
    if (JSON.stringify(manifest) !== JSON.stringify(expected))
      throw new Error(
        'Existing agent worktree does not match this room, branch, or starting commit.',
      );
    if ((await lstat(cwd)).isSymbolicLink() || (await realpath(cwd)) !== cwd)
      throw new Error('Agent worktrees cannot be symlinks.');
    const actualRoot = await realpath((await git(cwd, 'rev-parse', '--show-toplevel')).trim());
    const common = await realpath(
      path.resolve(cwd, (await git(cwd, 'rev-parse', '--git-common-dir')).trim()),
    );
    const expectedCommon = await realpath(
      path.resolve(
        repository.root,
        (await git(repository.root, 'rev-parse', '--git-common-dir')).trim(),
      ),
    );
    if (
      actualRoot !== cwd ||
      common !== expectedCommon ||
      (await git(cwd, 'branch', '--show-current')).trim() !== agent.branch
    )
      throw new Error(
        'Existing agent worktree no longer belongs to its expected repository and branch.',
      );
    try {
      await git(cwd, 'merge-base', '--is-ancestor', base, 'HEAD');
    } catch {
      throw new Error('Existing agent branch no longer descends from the room’s pinned commit.');
    }
  } else {
    if (await exists(manifestPath))
      throw new Error(
        'The saved agent worktree is missing. Restore it before reconnecting this agent.',
      );
    await git(repository.root, 'worktree', 'add', '-b', agent.branch, cwd, base);
    await writeFile(manifestPath, JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
  }
  return { cwd, base };
}
