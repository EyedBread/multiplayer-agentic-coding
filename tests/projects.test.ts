import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../server/git.js';
import { ProjectRegistry } from '../server/projects.js';
import type { Session } from '../shared/types.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function repository(root: string, name: string) {
  const dir = path.join(root, name);
  await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await writeFile(path.join(dir, 'README.md'), name);
  await writeFile(path.join(dir, '.gitignore'), '.multiplayer/\n');
  await git(dir, 'add', '.');
  await git(dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', name);
  await git(dir, 'remote', 'add', 'origin', `https://github.com/test/${name}.git`);
  return dir;
}

test('registered projects persist, deduplicate canonical paths and hide host paths remotely', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-projects-'));
  try {
    const first = await repository(root, 'first');
    const second = await repository(root, 'second');
    const state = path.join(root, 'state');
    const registry = new ProjectRegistry(first, state);
    await registry.load();
    assert.equal(await registry.add(first), 'default');
    await assert.rejects(registry.add('relative/path'), /absolute/);
    await assert.rejects(registry.add(root), /existing Git repository/);
    const ids = await Promise.all([registry.add(second), registry.add(second)]);
    assert.equal(ids[0], ids[1]);
    const restored = new ProjectRegistry(first, state);
    await restored.load();
    assert.equal(restored.resolve(ids[0]), await realpath(second));
    assert.equal((await restored.list(false)).length, 2);
    assert.ok((await restored.list(false)).every((project) => project.path === ''));
    assert.throws(() => restored.resolve(second), /registered/);
    await writeFile(path.join(second, 'README.md'), 'dirty');
    assert.equal((await restored.list(true)).find((project) => project.id === ids[0])?.dirty, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'rooms pin their selected repository for hosted agents and local runners',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-project-api-'));
    const first = await repository(root, 'first');
    const second = await repository(root, 'second');
    const state = path.join(root, 'state');
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: appRoot,
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        PORT: String(port),
        NODE_ENV: 'production',
        HOST_REPO_PATH: first,
        MULTIPLAYER_STATE_DIR: state,
        CODEX_BIN: path.join(appRoot, 'tests/fixtures/fake-codex.mjs'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    async function request(
      route: string,
      data?: unknown,
      session?: Session,
      status = 200,
      base = origin,
    ) {
      const response = await fetch(base + route, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const result = await response.json();
      assert.equal(response.status, status, result.error || route);
      return result;
    }
    try {
      const deadline = Date.now() + 10000;
      while (!output.includes('Multiplayer is ready') && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.match(output, /Multiplayer is ready/);
      const added = await request('/api/projects', { path: second });
      const body = { mode: 'live', memberName: 'Tester', name: 'Project room' };
      await request('/api/rooms', { ...body, projectId: second }, undefined, 400);
      await writeFile(path.join(second, 'README.md'), 'dirty');
      await request('/api/rooms', { ...body, projectId: added.id }, undefined, 400);
      await writeFile(path.join(second, 'README.md'), 'second');
      const a = await request('/api/rooms', body);
      const b = await request('/api/rooms', { ...body, projectId: added.id });
      assert.equal(a.room.repoName, 'first');
      assert.equal(b.room.repoName, 'second');
      assert.notEqual(a.room.project.baseCommit, b.room.project.baseCommit);
      const pinned = b.room.project.baseCommit;
      await writeFile(path.join(second, 'README.md'), 'newer commit');
      await git(second, 'add', '.');
      await git(
        second,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'newer',
      );
      const agentA = await request(
        '/api/agents',
        { name: 'First agent', task: 'Check repository' },
        a.session,
      );
      const agentB = await request(
        '/api/agents',
        { name: 'Second agent', task: 'Check repository' },
        b.session,
      );
      assert.equal(agentA.status, 'idle', agentA.error);
      assert.equal(agentB.status, 'idle', agentB.error);
      const cwdA = path.join(first, '.multiplayer/worktrees', a.room.id, agentA.id);
      const cwdB = path.join(state, 'worktrees', b.room.id, agentB.id);
      assert.equal(await readFile(path.join(cwdA, 'README.md'), 'utf8'), 'first');
      assert.equal(await readFile(path.join(cwdB, 'README.md'), 'utf8'), 'second');
      assert.equal((await git(cwdB, 'rev-parse', 'HEAD')).trim(), pinned);
      assert.equal((await git(second, 'status', '--porcelain')).trim(), '');
      for (const harness of ['codex', 'claude']) {
        const pairing = await request('/api/runners/pair', { harness }, b.session);
        assert.deepEqual(pairing.project, b.room.project);
        assert.equal(pairing.project.identity, 'github.com/test/second');
      }
      const lan = Object.values(os.networkInterfaces())
        .flat()
        .find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
      if (lan) {
        const remoteOrigin = `http://${lan}:${port}`;
        const config = await request('/api/config', undefined, undefined, 200, remoteOrigin);
        assert.equal(config.canManageProjects, false);
        assert.ok(config.projects.every((project: { path: string }) => project.path === ''));
        await request('/api/projects', { path: first }, undefined, 403, remoteOrigin);
        const teammateRoom = await request(
          '/api/rooms',
          { ...body, projectId: added.id },
          undefined,
          200,
          remoteOrigin,
        );
        assert.equal(teammateRoom.room.repoName, 'second');
      }
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit');
      await rm(root, { recursive: true, force: true });
    }
  },
);
