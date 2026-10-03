import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '../server/git.js';
import type { Agent, Room, Session } from '../shared/types.js';
import type { RunnerState } from '../runner/state.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fake = path.join(root, 'tests/fixtures/fake-codex.mjs');
async function until<T>(
  get: () => Promise<T>,
  ready: (value: T) => boolean,
  timeout = 8000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await get();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('Timed out waiting for runner state');
}
type Child = { process: ChildProcess; output: () => string };
async function stop(child: Child) {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  const exited = once(child.process, 'exit');
  child.process.kill('SIGTERM');
  const forced = setTimeout(() => child.process.kill('SIGKILL'), 4000);
  await exited;
  clearTimeout(forced);
}

test(
  'actual local runner pairs, owns parallel sessions, resumes safely, and respects revocation',
  { timeout: 45000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-runner-integration-'));
    const hostRepo = path.join(directory, 'host');
    const localRepo = path.join(directory, 'teammate');
    await mkdir(hostRepo);
    await git(hostRepo, 'init', '-b', 'main');
    await writeFile(path.join(hostRepo, 'README.md'), 'Runner integration fixture\n');
    await writeFile(path.join(hostRepo, '.gitignore'), '.multiplayer/\n');
    await git(hostRepo, 'add', '.');
    await git(
      hostRepo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'Fixture',
    );
    await git(directory, 'clone', '--local', hostRepo, localRepo);
    const probe = createServer().listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const proxySockets = new Set<Socket>();
    const proxy = createServer((incoming) => {
      const outgoing = createConnection({ host: '127.0.0.1', port });
      proxySockets.add(incoming);
      proxySockets.add(outgoing);
      incoming.pipe(outgoing).pipe(incoming);
      incoming.on('error', () => outgoing.destroy());
      outgoing.on('error', () => incoming.destroy());
      incoming.on('close', () => {
        proxySockets.delete(incoming);
        outgoing.destroy();
      });
      outgoing.on('close', () => {
        proxySockets.delete(outgoing);
        incoming.destroy();
      });
    }).listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const runnerOrigin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const children: Child[] = [];
    function launch(
      file: string,
      args: string[] = [],
      extraEnv: Record<string, string> = {},
    ): Child {
      const child = spawn(process.execPath, ['--import', 'tsx', file, ...args], {
        cwd: root,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(port),
          NODE_ENV: 'production',
          HOST_REPO_PATH: hostRepo,
          CODEX_BIN: fake,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', (chunk) => {
        output = (output + chunk).slice(-100_000);
      });
      child.stderr!.on('data', (chunk) => {
        output = (output + chunk).slice(-100_000);
      });
      const tracked = { process: child, output: () => output };
      children.push(tracked);
      return tracked;
    }
    async function request(
      route: string,
      session?: Pick<Session, 'token'>,
      body?: unknown,
      status = 200,
    ) {
      const response = await fetch(origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json();
      assert.equal(response.status, status, `${route}: ${result.error || response.status}`);
      return result;
    }
    try {
      const server = launch('server/index.ts');
      await until(
        async () => server.output(),
        (output) => output.includes('Multiplayer is ready'),
      );
      const host: { room: Room; session: Session } = await request('/api/rooms', undefined, {
        name: 'Runner room',
        memberName: 'Host',
        mode: 'live',
      });
      const peer: { room: Room; session: Session } = await request('/api/join', undefined, {
        code: host.room.code,
        memberName: 'Peer',
      });
      const pairing = await request('/api/runners/pair', peer.session, { harness: 'codex' });
      const stateFile = path.join(directory, 'codex-state.json');
      let runner = launch('runner/index.ts', [
        '--server',
        runnerOrigin,
        '--pair',
        pairing.code,
        '--repo',
        localRepo,
        '--state-file',
        stateFile,
        '--name',
        'Peer laptop',
      ]);
      let current: Room = await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.runners.some((r) => r.status === 'online'),
      );
      const connected = current.runners.find((r) => r.status === 'online')!;
      assert.equal(connected.ownerId, peer.session.memberId);
      assert.equal(connected.harness, 'codex');
      const saved: RunnerState = JSON.parse(await readFile(stateFile, 'utf8'));
      assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
      assert.ok(!runner.output().includes(saved.token));
      await request('/api/runners/claim', undefined, { code: pairing.code }, 401);
      await request(
        '/api/agents',
        host.session,
        { name: 'Hijack', task: 'Not mine', runnerId: connected.id },
        400,
      );
      const agents: Agent[] = [];
      for (const name of ['Interface', 'Server']) {
        const agent: Agent = await request('/api/agents', peer.session, {
          name,
          task: `Build ${name}`,
          runnerId: connected.id,
        });
        assert.equal(agent.status, 'idle', agent.error);
        assert.equal(agent.runnerId, connected.id);
        assert.equal(agent.ownerId, peer.session.memberId);
        agents.push(agent);
      }
      const worktree = (agent: Agent) =>
        path.join(localRepo, '.multiplayer', 'worktrees', host.room.id, agent.id);
      await request(
        `/api/agents/${agents[0].id}/prompt`,
        host.session,
        { prompt: 'Host cannot task this local agent' },
        403,
      );
      await request(`/api/agents/${agents[0].id}/stop`, host.session, {}, 403);
      // A quickly completed start response must not leave a stale turn ID behind.
      for (const prompt of ['First fast task', 'Second fast task']) {
        await request(`/api/agents/${agents[0].id}/prompt`, peer.session, { prompt });
        current = await until(
          () => request('/api/room', peer.session),
          (room: Room) => room.agents.find((a) => a.id === agents[0].id)?.status === 'idle',
        );
        assert.equal(current.agents.find((a) => a.id === agents[0].id)!.error, undefined);
      }
      await Promise.all([
        request(`/api/agents/${agents[0].id}/prompt`, peer.session, { prompt: 'ASK_APPROVAL' }),
        request(`/api/agents/${agents[1].id}/prompt`, peer.session, { prompt: 'ASK_TEAM' }),
      ]);
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.agents.every((agent) => agent.status === 'waiting'),
      );
      assert.ok(
        current.agents.every((agent) =>
          agent.entries.some(
            (entry) =>
              entry.kind === 'agent' && entry.text.includes('Checking the shared contract'),
          ),
        ),
      );
      const approval = current.decisions.find((decision) => decision.scope === 'approval')!;
      assert.equal(approval.ownerId, peer.session.memberId);
      await request(
        `/api/decisions/${approval.id}/resolve`,
        host.session,
        { answer: 'Decline' },
        403,
      );
      await request(`/api/decisions/${approval.id}/resolve`, peer.session, { answer: 'Decline' });
      await until(
        () => readFile(path.join(worktree(agents[0]), 'answers.jsonl'), 'utf8').catch(() => ''),
        (answer) => answer.includes('decline'),
      );
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) =>
          room.agents.find((agent) => agent.id === agents[0].id)?.status === 'idle' &&
          room.overlaps.some((overlap) => overlap.path === 'shared.ts'),
      );
      assert.equal(current.agents.find((agent) => agent.id === agents[1].id)!.status, 'waiting');
      assert.ok(current.agents.every((agent) => agent.files.includes('shared.ts')));
      assert.match(
        (await request(`/api/agents/${agents[0].id}/diff?file=shared.ts`, host.session)).diff,
        /\+export const eventType/,
      );
      await request(
        `/api/agents/${agents[0].id}/diff?file=..%2FREADME.md`,
        peer.session,
        undefined,
        400,
      );
      await assert.rejects(readFile(path.join(hostRepo, 'shared.ts')), /ENOENT/);
      await assert.rejects(readFile(path.join(localRepo, 'shared.ts')), /ENOENT/);
      assert.equal(
        (await git(hostRepo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)?.length,
        1,
      );
      await request(`/api/agents/${agents[0].id}/prompt`, peer.session, { prompt: 'ASK_TEAM' });
      await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.agents.every((agent) => agent.status === 'waiting'),
      );
      await request(`/api/agents/${agents[0].id}/stop`, peer.session, {});
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.agents.find((agent) => agent.id === agents[0].id)?.status === 'idle',
      );
      assert.equal(current.agents.find((agent) => agent.id === agents[1].id)!.status, 'waiting');
      assert.equal(
        current.decisions.find(
          (decision) => decision.agentId === agents[0].id && decision.scope === 'team',
        )!.status,
        'cancelled',
      );
      const memberCount = current.members.length;
      for (const agent of agents)
        await writeFile(
          path.join(worktree(agent), 'shared.ts'),
          `Preserve ${agent.id} across reconnect\n`,
        );
      // Drop the actual runner connection while keeping both processes alive.
      // Its adapter processes must stop and fresh conversations must await new prompts.
      for (const socket of proxySockets) socket.destroy();
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.runners.find((r) => r.id === connected.id)?.status === 'offline',
      );
      assert.ok(current.agents.every((agent) => agent.status === 'offline'));
      assert.ok(
        current.decisions.every((decision) => !['open', 'owner-needed'].includes(decision.status)),
      );
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) =>
          room.runners.find((r) => r.id === connected.id)?.status === 'online' &&
          room.agents.every((agent) => agent.status === 'idle'),
      );
      assert.match(runner.output(), /Local turns stopped; worktrees kept/);
      assert.equal(runner.process.exitCode, null);
      for (const agent of agents)
        assert.equal(
          await readFile(path.join(worktree(agent), 'shared.ts'), 'utf8'),
          `Preserve ${agent.id} across reconnect\n`,
        );
      await stop(runner);
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.runners.find((r) => r.id === connected.id)?.status === 'offline',
      );
      assert.ok(current.agents.every((agent) => agent.status === 'offline'));
      assert.ok(
        current.decisions.every((decision) => !['open', 'owner-needed'].includes(decision.status)),
      );
      const decisionCount = current.decisions.length;
      runner = launch('runner/index.ts', ['--resume', stateFile]);
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) =>
          room.runners.find((r) => r.id === connected.id)?.status === 'online' &&
          room.agents.every((agent) => agent.status === 'idle'),
      );
      assert.equal(current.members.length, memberCount);
      assert.equal(current.decisions.length, decisionCount);
      assert.deepEqual(
        current.agents.map((agent) => agent.id),
        agents.map((agent) => agent.id),
      );
      assert.ok(current.agents.every((agent) => agent.ownerId === peer.session.memberId));
      for (const agent of agents)
        assert.equal(
          await readFile(path.join(worktree(agent), 'shared.ts'), 'utf8'),
          `Preserve ${agent.id} across reconnect\n`,
        );
      assert.ok(!runner.output().includes(saved.token));
      await request(`/api/agents/${agents[0].id}/prompt`, peer.session, {
        prompt: 'Continue after reconnect',
      });
      await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.agents.find((agent) => agent.id === agents[0].id)?.status === 'idle',
      );
      assert.match(
        await readFile(path.join(worktree(agents[0]), 'shared.ts'), 'utf8'),
        /export const eventType/,
      );

      // Starting a Claude session initializes the adapter but makes no provider query.
      const claudePair = await request('/api/runners/pair', peer.session, { harness: 'claude' });
      const claude = launch(
        'runner/index.ts',
        [
          '--server',
          origin,
          '--pair',
          claudePair.code,
          '--repo',
          localRepo,
          '--state-file',
          path.join(directory, 'claude-state.json'),
        ],
        { ANTHROPIC_API_KEY: 'fixture-only-not-a-real-key' },
      );
      current = await until(
        () => request('/api/room', peer.session),
        (room: Room) => room.runners.some((r) => r.harness === 'claude' && r.status === 'online'),
      );
      const claudeRunner = current.runners.find((r) => r.harness === 'claude')!;
      const claudeAgent: Agent = await request('/api/agents', peer.session, {
        name: 'Claude reviewer',
        task: 'Review only when prompted',
        runnerId: claudeRunner.id,
      });
      assert.equal(claudeAgent.status, 'idle', claudeAgent.error);
      assert.equal(claudeAgent.harness, 'claude');
      assert.ok(!claude.output().includes('fixture-only-not-a-real-key'));
      await stop(claude);

      await request(`/api/runners/${connected.id}/revoke`, host.session, {}, 403);
      await request(`/api/runners/${connected.id}/revoke`, peer.session, {});
      await until(
        async () => runner.process.exitCode,
        (exitCode) => exitCode !== null,
      );
      assert.equal(runner.process.exitCode, 1);
      assert.match(runner.output(), /pair again/i);
      await request('/api/runner', { token: saved.token }, undefined, 401);
      assert.equal((await git(hostRepo, 'status', '--porcelain')).trim(), '');
      assert.equal((await git(localRepo, 'status', '--porcelain')).trim(), '');

      // A failed checkout check keeps the one-use claim so the user can repair and resume.
      const wrong = path.join(directory, 'wrong');
      await mkdir(wrong);
      await git(wrong, 'init', '-b', 'main');
      await writeFile(path.join(wrong, 'unrelated'), 'Different project');
      await git(wrong, 'add', '.');
      await git(
        wrong,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-m',
        'Different',
      );
      const wrongPair = await request('/api/runners/pair', peer.session, { harness: 'codex' });
      const failedStateFile = path.join(directory, 'failed-state.json');
      const failed = launch('runner/index.ts', [
        '--server',
        origin,
        '--pair',
        wrongPair.code,
        '--repo',
        wrong,
        '--state-file',
        failedStateFile,
      ]);
      await until(
        async () => failed.process.exitCode,
        (exitCode) => exitCode !== null,
      );
      assert.equal(failed.process.exitCode, 1);
      const failedState: RunnerState = JSON.parse(await readFile(failedStateFile, 'utf8'));
      await request('/api/runner', { token: failedState.token });
      assert.ok(!failed.output().includes(failedState.token));
      const repaired = launch('runner/index.ts', [
        '--resume',
        failedStateFile,
        '--repo',
        localRepo,
      ]);
      await until(
        () => request('/api/room', peer.session),
        (room: Room) =>
          room.runners.some((r) => r.id === failedState.runner.id && r.status === 'online'),
      );
      // A fresh coordinator has no in-memory credentials. Stop rather than retry forever.
      await stop(server);
      const restarted = launch('server/index.ts');
      await until(
        async () => restarted.output(),
        (output) => output.includes('Multiplayer is ready'),
      );
      await until(
        async () => repaired.process.exitCode,
        (exitCode) => exitCode !== null,
      );
      assert.equal(repaired.process.exitCode, 1);
      assert.match(repaired.output(), /pair again/i);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.stack : error}\nChild output:\n${children.map((child) => child.output()).join('\n--- child ---\n')}`,
      );
    } finally {
      for (const child of children.reverse()) await stop(child);
      for (const socket of proxySockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
