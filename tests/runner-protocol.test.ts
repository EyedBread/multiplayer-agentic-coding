import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { git } from '../server/git.js';
import type { Room, Session } from '../shared/types.js';
import type { RunnerBootstrap, RunnerRequest } from '../shared/runner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test(
  'runner protocol rejects malformed questions atomically and confines approvals and events to their owner',
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-runner-protocol-'));
    await git(dir, 'init', '-b', 'main');
    await writeFile(path.join(dir, 'README.md'), 'Runner protocol fixture\n');
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
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: root,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        NODE_ENV: 'production',
        HOST_REPO_PATH: dir,
        CODEX_BIN: path.join(root, 'tests/fixtures/fake-codex.mjs'),
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
    const sockets: WebSocket[] = [];
    async function until<T>(get: () => Promise<T> | T, ready: (value: T) => boolean): Promise<T> {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const value = await get();
        if (ready(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Runner protocol condition timed out. ${output}`);
    }
    async function request(
      route: string,
      token?: string,
      body?: unknown,
      expected = 200,
    ): Promise<any> {
      const response = await fetch(origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await response.json();
      assert.equal(response.status, expected, value.error || route);
      return value;
    }
    async function runner(session: Session) {
      const pairing = await request('/api/runners/pair', session.token, { harness: 'claude' });
      const bootstrap: RunnerBootstrap = await request('/api/runners/claim', undefined, {
        code: pairing.code,
        name: 'Protocol fixture',
      });
      await request('/api/runners/claim', undefined, { code: pairing.code, name: 'Replay' }, 401);
      const socket = new WebSocket(`ws://127.0.0.1:${port}/runner-ws`, {
        headers: { Authorization: `Bearer ${bootstrap.token}` },
      });
      sockets.push(socket);
      const commands: RunnerRequest[] = [];
      socket.on('message', (raw) => {
        const command: RunnerRequest = JSON.parse(String(raw));
        commands.push(command);
        socket.send(
          JSON.stringify({
            type: 'result',
            id: command.id,
            result: command.method === 'start' ? { threadId: 'fixture-thread' } : {},
          }),
        );
      });
      await once(socket, 'open');
      socket.send(
        JSON.stringify({
          type: 'ready',
          protocol: 1,
          baseCommit: bootstrap.project.baseCommit,
          identity: bootstrap.project.identity,
        }),
      );
      await until(
        () => request('/api/room', session.token),
        (room: Room) =>
          room.runners.some((item) => item.id === bootstrap.runner.id && item.status === 'online'),
      );
      const agent = await request('/api/agents', session.token, {
        name: 'Protocol agent',
        task: 'Protocol checks only',
        runnerId: bootstrap.runner.id,
      });
      assert.equal(agent.status, 'idle');
      return { socket, commands, bootstrap, agent };
    }
    try {
      await until(
        () => output,
        (text) => text.includes('Multiplayer is ready'),
      );
      const host = await request('/api/rooms', undefined, {
        name: 'Protocol room',
        memberName: 'Host',
        mode: 'live',
      });
      const peer = await request('/api/join', undefined, {
        code: host.room.code,
        memberName: 'Runner owner',
      });
      const local = await runner(peer.session);
      await request('/api/runner', peer.session.token, undefined, 401);
      await request('/api/room', local.bootstrap.token, undefined, 401);
      await request(
        `/api/agents/${local.agent.id}/prompt`,
        host.session.token,
        { prompt: 'Not my runner' },
        403,
      );
      const good = {
        id: 'q0',
        question: 'Use types?',
        options: [{ label: 'Typed' }, { label: 'Snapshot' }],
      };
      const malformed = [
        [],
        [{ ...good, question: { invalid: true } }],
        [good, { ...good, id: 'q1', options: [{ label: { invalid: true } }] }],
        [good, { ...good }],
      ];
      for (let index = 0; index < malformed.length; index++) {
        const id = `malformed-${index}`;
        local.socket.send(
          JSON.stringify({
            type: 'event',
            agentId: local.agent.id,
            event: {
              id,
              method: 'item/tool/requestUserInput',
              params: { questions: malformed[index] },
            },
          }),
        );
        await until(
          () => local.commands,
          (commands) =>
            commands.some(
              (command) => command.method === 'reject' && command.params.requestId === id,
            ),
        );
        const room: Room = await request('/api/room', peer.session.token);
        assert.equal(
          room.decisions.length,
          0,
          'No partial decision may survive a malformed batch.',
        );
        assert.equal(room.agents[0].status, 'idle');
      }
      local.socket.send(
        JSON.stringify({
          type: 'event',
          agentId: local.agent.id,
          event: {
            id: 'reserved-key',
            method: 'item/tool/requestUserInput',
            params: { questions: [{ ...good, id: '__proto__' }] },
          },
        }),
      );
      let room: Room = await until(
        () => request('/api/room', peer.session.token),
        (value: Room) => value.decisions.length === 1,
      );
      await request(`/api/decisions/${room.decisions[0].id}/resolve`, peer.session.token, {
        answer: 'Typed',
      });
      const replies = await until(
        () => local.commands,
        (commands) =>
          commands.some(
            (command) => command.method === 'reply' && command.params.requestId === 'reserved-key',
          ),
      );
      const reply = replies.find(
        (command) => command.method === 'reply' && command.params.requestId === 'reserved-key',
      )!;
      assert.deepEqual(Object.keys(reply.params.result.answers), ['__proto__']);
      assert.deepEqual(reply.params.result.answers.__proto__, { answers: ['Typed'] });
      local.socket.send(
        JSON.stringify({
          type: 'event',
          agentId: local.agent.id,
          event: {
            id: 'permission',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'npm test', availableDecisions: ['accept', 'decline'] },
          },
        }),
      );
      room = await until(
        () => request('/api/room', peer.session.token),
        (value: Room) => value.decisions.some((decision) => decision.scope === 'approval'),
      );
      const approval = room.decisions.find((decision) => decision.scope === 'approval')!;
      assert.equal(approval.ownerId, peer.session.memberId);
      await request(
        `/api/decisions/${approval.id}/resolve`,
        host.session.token,
        { answer: 'Allow once' },
        403,
      );
      await request(`/api/decisions/${approval.id}/resolve`, peer.session.token, {
        answer: 'Decline',
      });
      await until(
        () => local.commands,
        (commands) =>
          commands.some(
            (command) =>
              command.method === 'reply' &&
              command.params.requestId === 'permission' &&
              command.params.result.decision === 'decline',
          ),
      );
      local.socket.send(
        JSON.stringify({
          type: 'agent-error',
          agentId: local.agent.id,
          error: 'Fixture harness disconnected.',
        }),
      );
      await until(
        () => request('/api/room', peer.session.token),
        (value: Room) =>
          value.agents.find((agent) => agent.id === local.agent.id)?.status === 'error',
      );
      await request(`/api/agents/${local.agent.id}/restart`, host.session.token, {}, 403);
      await request(`/api/agents/${local.agent.id}/restart`, peer.session.token, {});
      room = await until(
        () => request('/api/room', peer.session.token),
        (value: Room) =>
          value.agents.find((agent) => agent.id === local.agent.id)?.status === 'idle',
      );
      assert.equal(local.commands.filter((command) => command.method === 'start').length, 2);
      assert.equal(
        room.agents.find((agent) => agent.id === local.agent.id)?.branch,
        local.agent.branch,
        'A restart preserves the existing worktree branch.',
      );
      const other = await runner(host.session);
      const closed = once(local.socket, 'close');
      local.socket.send(
        JSON.stringify({
          type: 'event',
          agentId: other.agent.id,
          event: { method: 'turn/started', params: { turn: { id: 'spoofed' } } },
        }),
      );
      assert.equal((await closed)[0], 1008);
      room = await until(
        () => request('/api/room', peer.session.token),
        (value: Room) =>
          value.agents.find((agent) => agent.id === local.agent.id)?.status === 'offline',
      );
      assert.equal(room.agents.find((agent) => agent.id === other.agent.id)?.status, 'idle');
      await request(`/api/agents/${other.agent.id}/close`, host.session.token, {});
      other.socket.send(
        JSON.stringify({
          type: 'event',
          agentId: other.agent.id,
          event: { method: 'turn/started', params: { turn: { id: 'late-event' } } },
        }),
      );
      const replacement = await request('/api/agents', host.session.token, {
        name: 'Replacement',
        task: 'Remain connected',
        runnerId: other.bootstrap.runner.id,
      });
      assert.equal(replacement.status, 'idle');
      room = await request('/api/room', host.session.token);
      assert.equal(
        room.agents.some((agent) => agent.id === other.agent.id),
        false,
      );
      assert.equal(
        room.runners.find((runner) => runner.id === other.bootstrap.runner.id)?.status,
        'online',
      );
    } finally {
      for (const socket of sockets) socket.terminate();
      if (server.exitCode === null) {
        server.kill('SIGTERM');
        await once(server, 'exit');
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);
