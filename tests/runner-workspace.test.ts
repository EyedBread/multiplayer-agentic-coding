import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../server/git.js';
import { repositoryRemote, type RunnerProject } from '../shared/runner.js';
import { boundedFiles, publicEvent } from '../runner/index.js';
import { loadState, normalizeServer, saveState, type RunnerState } from '../runner/state.js';
import { prepareAgentWorktree, prepareRepository } from '../runner/workspace.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-runner-workspace-'));
  await git(root, 'init', '-b', 'main');
  await writeFile(path.join(root, 'README.md'), 'Pinned project\n');
  await git(root, 'add', '.');
  await git(
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'Initial',
  );
  const project: RunnerProject = {
    remoteUrl: null,
    identity: null,
    baseCommit: (await git(root, 'rev-parse', 'HEAD')).trim(),
  };
  return { root, project };
}

test('runner worktrees pin the room commit, isolate changes, and preserve edits across reconnects', async () => {
  const { root, project } = await fixture();
  try {
    await writeFile(path.join(root, 'README.md'), 'User changes outside the agent\n');
    const repository = await prepareRepository({ repo: root, project });
    const first = await prepareAgentWorktree(repository, 'room-1', {
      id: 'agent-1',
      branch: 'codex/room-1-agent-1',
    });
    const second = await prepareAgentWorktree(repository, 'room-1', {
      id: 'agent-2',
      branch: 'codex/room-1-agent-2',
    });
    assert.equal(await readFile(path.join(first.cwd, 'README.md'), 'utf8'), 'Pinned project\n');
    await writeFile(path.join(first.cwd, 'feature.ts'), 'export const kept = true;\n');
    await git(first.cwd, 'add', 'feature.ts');
    await git(
      first.cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'Agent work',
    );
    await writeFile(
      path.join(first.cwd, 'feature.ts'),
      'export const kept = "with uncommitted changes";\n',
    );
    const resumed = await prepareAgentWorktree(repository, 'room-1', {
      id: 'agent-1',
      branch: 'codex/room-1-agent-1',
    });
    assert.deepEqual(resumed, first);
    assert.match(await readFile(path.join(first.cwd, 'feature.ts'), 'utf8'), /uncommitted changes/);
    await assert.rejects(readFile(path.join(second.cwd, 'feature.ts')), /ENOENT/);
    assert.equal(
      await readFile(path.join(root, 'README.md'), 'utf8'),
      'User changes outside the agent\n',
    );
    assert.equal((await git(root, 'status', '--porcelain')).trim(), 'M README.md');
    await assert.rejects(
      prepareAgentWorktree(repository, 'room-1', { id: 'agent-1', branch: 'codex/wrong-branch' }),
      /does not match/,
    );
    await git(first.cwd, 'switch', '-c', 'codex/changed-locally');
    await assert.rejects(
      prepareAgentWorktree(repository, 'room-1', { id: 'agent-1', branch: 'codex/room-1-agent-1' }),
      /expected repository and branch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runner rejects wrong remotes, unavailable pinned commits and unsafe clone destinations', async () => {
  const { root, project } = await fixture();
  try {
    await git(root, 'remote', 'add', 'origin', 'git@github.com:team/project.git');
    const remote = repositoryRemote('https://github.com/team/project.git')!;
    assert.equal(
      (await prepareRepository({ repo: root, project: { ...project, ...remote } })).identity,
      remote.identity,
    );
    await assert.rejects(
      prepareRepository({
        repo: root,
        project: { ...project, ...repositoryRemote('https://github.com/another/project.git')! },
      }),
      /different repository/,
    );
    await assert.rejects(
      prepareRepository({ repo: root, project: { ...project, baseCommit: '0'.repeat(40) } }),
      /valid HTTPS or SSH/,
    );
    await assert.rejects(
      prepareRepository({ clone: root, project: { ...project, ...remote } }),
      /already exists/,
    );
    for (const remoteUrl of [
      'file:///tmp/project',
      '/tmp/project',
      'ext::sh -c dangerous',
      'https://-oProxyCommand=bad/project',
    ]) {
      await assert.rejects(
        prepareRepository({
          clone: path.join(root, 'new-checkout'),
          project: { ...project, remoteUrl, identity: 'unsafe' },
        }),
        /valid HTTPS or SSH/,
      );
    }
    await mkdir(path.join(root, 'subdirectory'));
    await assert.rejects(
      prepareRepository({ repo: path.join(root, 'subdirectory'), project }),
      /repository root/,
    );
    await assert.rejects(prepareRepository({ repo: root, clone: 'other', project }), /exactly one/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worktree identifiers and directories cannot escape the chosen repository', async () => {
  const { root, project } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-outside-'));
  try {
    const repository = await prepareRepository({ repo: root, project });
    for (const id of ['../escape', '/absolute', 'agent/path', 'agent\\path'])
      await assert.rejects(
        prepareAgentWorktree(repository, 'room', { id, branch: 'codex/valid' }),
        /identifier/,
      );
    await assert.rejects(
      prepareAgentWorktree(repository, 'room', { id: 'agent', branch: 'main' }),
      /dedicated codex/,
    );
    await symlink(outside, path.join(root, '.multiplayer'), 'dir');
    await assert.rejects(
      prepareAgentWorktree(repository, 'room', { id: 'agent', branch: 'codex/valid' }),
      /not a symlink/,
    );
    await assert.rejects(readFile(path.join(outside, '.gitignore')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('runner credentials are private, survive atomic replacement and reject state symlinks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-runner-state-'));
  const file = path.join(directory, 'nested', 'state.json');
  const state: RunnerState = {
    version: 1,
    server: 'http://127.0.0.1:3000',
    token: 'private-runner-token',
    roomId: 'room',
    runner: {
      id: 'runner',
      ownerId: 'member',
      name: 'My computer',
      harness: 'codex',
      status: 'online',
    },
    project: { identity: null, remoteUrl: null, baseCommit: 'a'.repeat(40) },
    repo: directory,
  };
  try {
    await saveState(file, state);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await loadState(file), state);
    await saveState(file, { ...state, runner: { ...state.runner, status: 'offline' } });
    assert.equal((await loadState(file)).runner.status, 'offline');
    const alias = path.join(directory, 'alias.json');
    await symlink(file, alias);
    await assert.rejects(saveState(alias, state), /not a symlink/);
    await assert.rejects(loadState(alias), /not a symlink/);
    await writeFile(file, '{broken');
    await assert.rejects(loadState(file), /not valid JSON/);
    assert.equal(normalizeServer('http://localhost:3000/'), 'http://localhost:3000');
    for (const url of [
      'file:///tmp',
      'http://user:password@localhost',
      'http://localhost/room',
      'http://localhost?token=secret',
    ])
      assert.throws(() => normalizeServer(url));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public runner events omit private events and secrets, bound output, and normalize file paths', () => {
  const cwd = path.resolve('/workspace/agent');
  assert.equal(publicEvent({ method: 'account/updated', params: { token: 'private' } }, cwd), null);
  assert.equal(
    publicEvent(
      {
        method: 'item/completed',
        params: { item: { type: 'reasoning', text: 'private reasoning' } },
      },
      cwd,
    ),
    null,
  );
  const event = publicEvent(
    {
      method: 'item/completed',
      params: {
        item: {
          id: 'item',
          type: 'fileChange',
          changes: [
            { path: path.join(cwd, 'src', 'app.ts') },
            { path: path.resolve('/outside/secret') },
          ],
          env: { KEY: 'private environment' },
          accessToken: 'private credential',
          text: 'x'.repeat(30_000),
        },
      },
    },
    cwd,
  )!;
  assert.equal(event.params.item.changes[0].path, 'src/app.ts');
  assert.equal(event.params.item.changes[1].path, '[outside worktree]');
  assert.equal(event.params.item.text.length, 24_000);
  assert.ok(!JSON.stringify(event).includes('private'));
  assert.equal(
    publicEvent(
      {
        id: 'request',
        method: 'item/tool/call',
        params: { values: Array(20).fill('x'.repeat(24_000)) },
      },
      cwd,
    ),
    null,
  );
});

test('large changed-file reports fit the transport and omit unsafe paths', () => {
  const paths = [
    '../escape',
    '/outside',
    'C:outside',
    '.git/config',
    'folder\\file',
    'nul\0file',
    ...Array.from({ length: 1000 }, (_, index) => `src/${index}/${'é'.repeat(480)}.ts`),
  ];
  const result = boundedFiles(paths);
  assert.equal(result.truncated, true);
  assert.ok(result.files.length > 0 && result.files.length < 1000);
  assert.ok(result.files.every((file) => file.startsWith('src/')));
  assert.ok(Buffer.byteLength(JSON.stringify(result.files)) <= 96 * 1024);
  assert.deepEqual(boundedFiles(['src/app.ts', 'README.md']), {
    files: ['src/app.ts', 'README.md'],
    truncated: false,
  });
});
