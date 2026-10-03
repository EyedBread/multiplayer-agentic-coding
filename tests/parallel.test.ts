import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../server/git.js';
import type { Agent, Room, Session } from '../shared/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test(
  'a teammate can resume ownership of two parallel live sessions with their saved membership',
  { timeout: 15000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-parallel-'));
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const fake = path.join(root, 'tests/fixtures/fake-codex.mjs');
    await chmod(fake, 0o755);
    await git(dir, 'init', '-b', 'main');
    await writeFile(path.join(dir, '.gitignore'), '.multiplayer/\n');
    await git(dir, 'add', '.');
    await git(
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'fixture',
    );
    const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        NODE_ENV: 'production',
        HOST_REPO_PATH: dir,
        CODEX_BIN: fake,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    server.stdout.on('data', (chunk) => {
      output += chunk;
    });
    server.stderr.on('data', (chunk) => {
      output += chunk;
    });
    async function until<T>(get: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const value = await get();
        if (ready(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`Parallel sessions did not reach expected state. Server output: ${output}`);
    }
    async function request(route: string, session?: Session, body?: unknown, status = 200) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, result.error);
      return result;
    }
    try {
      await until(
        async () => output,
        (value) => value.includes('Multiplayer is ready'),
      );
      const host = await request('/api/rooms', undefined, {
        name: 'Parallel room',
        memberName: 'Host',
        mode: 'live',
      });
      const peer = await request('/api/join', undefined, {
        code: host.room.code,
        memberName: 'Peer',
      });
      const agents: Agent[] = [];
      for (const name of ['Interface', 'Realtime']) {
        const agent: Agent = await request('/api/agents', peer.session, {
          name,
          task: `Build ${name}`,
        });
        assert.equal(agent.status, 'idle', agent.error);
        assert.equal(agent.ownerId, peer.session.memberId);
        agents.push(agent);
      }
      assert.notEqual(agents[0].branch, agents[1].branch);
      await Promise.all(
        agents.map((agent) =>
          request(`/api/agents/${agent.id}/prompt`, peer.session, { prompt: 'ASK_TEAM' }),
        ),
      );
      const running: Room = await until(
        () => request('/api/room', peer.session),
        (room: Room) =>
          room.agents.length === 2 && room.agents.every((agent) => agent.status === 'waiting'),
      );
      assert.equal(running.decisions.length, 2);
      assert.equal(new Set(running.decisions.map((decision) => decision.agentId)).size, 2);
      assert.ok(
        running.decisions.every(
          (decision) => decision.ownerId === peer.session.memberId && decision.status === 'open',
        ),
      );
      // Reopening with a persisted credential uses GET, without joining as a new member.
      const returningSession: Session = JSON.parse(JSON.stringify(peer.session));
      const returned: Room = await request('/api/room', returningSession);
      assert.equal(returned.id, running.id);
      assert.equal(returned.members.length, running.members.length);
      assert.equal(
        returned.members.filter((member) => member.id === returningSession.memberId).length,
        1,
      );
      assert.deepEqual(
        returned.agents.map((agent) => agent.id),
        agents.map((agent) => agent.id),
      );
      assert.ok(returned.agents.every((agent) => agent.ownerId === returningSession.memberId));
      assert.ok(returned.agents.every((agent) => agent.status === 'waiting'));
      await request(`/api/agents/${agents[0].id}/stop`, returningSession, {});
      const oneStopped: Room = await until(
        () => request('/api/room', returningSession),
        (room: Room) => room.agents.find((agent) => agent.id === agents[0].id)?.status === 'idle',
      );
      assert.equal(oneStopped.agents.find((agent) => agent.id === agents[1].id)!.status, 'waiting');
      assert.equal(
        oneStopped.decisions.find((decision) => decision.agentId === agents[0].id)!.status,
        'cancelled',
      );
      assert.equal(
        oneStopped.decisions.find((decision) => decision.agentId === agents[1].id)!.status,
        'open',
      );
      await request(`/api/agents/${agents[1].id}/stop`, returningSession, {});
      await until(
        () => request('/api/room', returningSession),
        (room: Room) => room.agents.every((agent) => agent.status === 'idle'),
      );
      assert.equal((await git(dir, 'status', '--porcelain')).trim(), '');
      const observer = await request('/api/join', undefined, {
        code: host.room.code,
        memberName: 'Observer',
      });
      await request(`/api/agents/${agents[0].id}/close`, observer.session, {}, 403);
      await request(`/api/agents/${agents[1].id}/prompt`, returningSession, { prompt: 'ASK_TEAM' });
      await until(
        () => request('/api/room', returningSession),
        (room: Room) =>
          room.agents.find((agent) => agent.id === agents[1].id)?.status === 'waiting',
      );
      await request(`/api/agents/${agents[1].id}/close`, host.session, {});
      await request(`/api/agents/${agents[0].id}/close`, returningSession, {});
      const empty: Room = await request('/api/room', returningSession);
      assert.equal(empty.agents.length, 0);
      assert.deepEqual(empty.overlaps, []);
      assert.ok(empty.decisions.every((decision) => decision.status === 'cancelled'));
      for (const agent of agents) {
        const cwd = path.join(dir, '.multiplayer', 'worktrees', host.room.id, agent.id);
        assert.match(await readFile(path.join(cwd, 'shared.ts'), 'utf8'), /eventType/);
        assert.equal((await git(cwd, 'branch', '--show-current')).trim(), agent.branch);
      }
    } finally {
      server.kill('SIGTERM');
      await once(server, 'exit');
      await rm(dir, { recursive: true, force: true });
    }
  },
);
