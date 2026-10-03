import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
const exec = promisify(execFile);
export async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 2 * 1024 * 1024, timeout: 15000 });
  return stdout;
}
export async function repoInfo(cwd: string) {
  const [root, branch, dirty] = await Promise.all([
    git(cwd, 'rev-parse', '--show-toplevel'),
    git(cwd, 'branch', '--show-current'),
    git(cwd, 'status', '--porcelain'),
  ]);
  return {
    root: root.trim(),
    name: path.basename(root.trim()),
    branch: branch.trim() || 'detached HEAD',
    dirty: !!dirty.trim(),
  };
}
export async function createWorktree(
  repo: string,
  roomId: string,
  agentId: string,
  branch: string,
) {
  const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
  const parent = path.join(repo, '.multiplayer', 'worktrees', roomId);
  await mkdir(parent, { recursive: true });
  const cwd = path.join(parent, agentId);
  await git(repo, 'worktree', 'add', '-b', branch, cwd, base);
  return { cwd, base };
}
export async function changedFiles(cwd: string, base: string) {
  const [tracked, untracked] = await Promise.all([
    git(cwd, 'diff', '--name-only', '-z', base, '--'),
    git(cwd, 'ls-files', '--others', '--exclude-standard', '-z'),
  ]);
  return [...new Set([...tracked.split('\0'), ...untracked.split('\0')])]
    .filter((p) => p && !p.startsWith('.multiplayer/'))
    .sort();
}
export async function fileDiff(cwd: string, base: string, file: string) {
  const files = await changedFiles(cwd, base);
  if (!files.includes(file)) throw new Error('This file is not in the agent’s changed files.');
  const diff = await git(cwd, 'diff', '--no-ext-diff', '--no-textconv', base, '--', file);
  if (diff) return diff.slice(0, 80000);
  const full = await realpath(path.join(cwd, file));
  if (!full.startsWith((await realpath(cwd)) + path.sep))
    throw new Error('Files outside the worktree cannot be previewed.');
  if ((await stat(full)).size > 200000) return 'This file is too large to preview.';
  const content = await readFile(full, 'utf8');
  if (content.includes('\0')) return 'Binary file — no text preview.';
  return (
    `New file: ${file}\n` +
    content
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n')
  );
}
