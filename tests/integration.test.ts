import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { git } from '../server/git.js';
import type { Agent, Decision, Room, Session } from '../shared/types.js';
import { VOTE_DURATION_MS } from '../shared/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(
  get: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 5000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await get();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error('Timed out waiting for the expected state');
}
test(
  'live collaboration: LAN rooms, isolated worktrees, vote discussion, owner approval, and Codex replies',
  { timeout: 95000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-integration-'));
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>((r) => portProbe.close(() => r()));
    const origin = `http://127.0.0.1:${port}`;
    const lanAddress = Object.values(os.networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    const lanOrigin = lanAddress ? `http://${lanAddress}:${port}` : origin;
    if (!lanAddress) t.diagnostic('No non-loopback IPv4 interface; LAN-address check unavailable.');
    const fake = path.join(root, 'tests/fixtures/fake-codex.mjs');
    await chmod(fake, 0o755);
    await git(dir, 'init', '-b', 'main');
    await writeFile(path.join(dir, 'README.md'), 'Disposable collaboration fixture\n');
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
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      cwd: root,
      env: {
        ...globalThis.process.env,
        HOST: '0.0.0.0',
        PORT: String(port),
        NODE_ENV: 'production',
        HOST_REPO_PATH: dir,
        CODEX_BIN: fake,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    process.stdout.on('data', (chunk) => {
      output += chunk;
    });
    process.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const sockets: WebSocket[] = [];
    async function request(
      url: string,
      session?: Session,
      data?: unknown,
      expected = 200,
      base = origin,
    ) {
      const response = await fetch(base + url, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const result = await response.json();
      assert.equal(response.status, expected, result.error || `Unexpected response for ${url}`);
      return result;
    }
    try {
      await until(
        async () => output,
        (value) => value.includes('Multiplayer is ready'),
      );
      await request('/api/room', undefined, undefined, 401);
      const config = await request('/api/config', undefined, undefined, 200, lanOrigin);
      assert.equal(config.canHost, true);
      if (lanAddress)
        assert.equal(config.repoPath, '', 'This request must exercise the remote path');
      const host = (await request(
        '/api/rooms',
        undefined,
        {
          name: 'Integration room',
          memberName: 'Host',
          mode: 'live',
        },
        200,
        lanOrigin,
      )) as { room: Room; session: Session };
      const peer = (await request('/api/join', undefined, {
        code: host.room.code,
        memberName: 'Peer',
      })) as { room: Room; session: Session };
      const guestRoom = (await request('/api/rooms', undefined, {
        name: 'Other room',
        memberName: 'Outsider',
        mode: 'demo',
      })) as { room: Room; session: Session };
      const states: Room[] = [];
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${peer.session.token}`, {
        origin,
      });
      sockets.push(socket);
      socket.on('message', (message) => states.push(JSON.parse(String(message)).room));
      await once(socket, 'open');
      await until(
        async () => states,
        (values) =>
          values.some((r) => r.members.some((m) => m.id === peer.session.memberId && m.online)),
      );
      const agent = (await request('/api/agents', host.session, {
        name: 'Interface',
        task: 'Build UI',
      })) as Agent;
      assert.equal(agent.status, 'idle', agent.error);
      const peerAgent = (await request('/api/agents', peer.session, {
        name: 'Server',
        task: 'Build server',
      })) as Agent;
      assert.equal(peerAgent.status, 'idle', peerAgent.error);
      await request(
        `/api/agents/${agent.id}/prompt`,
        peer.session,
        { prompt: 'Not my agent' },
        403,
      );
      await request(
        `/api/agents/${agent.id}/prompt`,
        guestRoom.session,
        { prompt: 'Not my room' },
        400,
      );
      const csrf = await fetch(origin + '/api/decisions', {
        method: 'POST',
        headers: {
          Origin: 'https://other.example',
          Authorization: `Bearer ${host.session.token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(csrf.status, 403);
      await request(`/api/agents/${peerAgent.id}/prompt`, peer.session, { prompt: 'ASK_OWNER' });
      const questionState = await until<Room>(
        () => request('/api/room', host.session),
        (r) => r.decisions.some((d) => d.scope === 'owner'),
      );
      const question = questionState.decisions[0];
      await request(
        `/api/decisions/${question.id}/resolve`,
        host.session,
        { answer: 'Typed' },
        403,
      );
      assert.equal(question.ownerId, peer.session.memberId);
      const beforePromote = Date.now();
      await request(`/api/decisions/${question.id}/promote`, host.session, {});
      const promotedState: Room = await request('/api/room', host.session);
      const promoted = promotedState.decisions.find((d) => d.id === question.id)!;
      assert.ok(promoted.closesAt! >= beforePromote + VOTE_DURATION_MS);
      assert.ok(promoted.closesAt! <= Date.now() + VOTE_DURATION_MS);
      await request(`/api/decisions/${question.id}/vote`, host.session, { option: 0 });
      await request(`/api/decisions/${question.id}/vote`, host.session, { option: 1 });
      await request(`/api/decisions/${question.id}/vote`, host.session, { option: 0 });
      await request(`/api/decisions/${question.id}/vote`, peer.session, { option: 0 });
      await request(
        `/api/decisions/${question.id}/resolve`,
        peer.session,
        { answer: 'Typed' },
        400,
      );
      // Each vote has its own authenticated discussion, shared with this room only.
      const secondVote = (await request('/api/decisions', host.session, {
        question: 'Which test strategy?',
        options: ['Protocol fixtures', 'Browser checks'],
      })) as Decision;
      assert.equal(secondVote.closesAt! - secondVote.createdAt, 60_000);
      await request(`/api/decisions/${question.id}/chat`, undefined, { text: 'Anonymous' }, 401);
      await request(
        `/api/decisions/${question.id}/chat`,
        guestRoom.session,
        { text: 'Outsider' },
        400,
      );
      await request(`/api/decisions/${question.id}/chat`, host.session, {
        text: 'Typed events are easier to validate.',
      });
      await request(`/api/decisions/${question.id}/chat`, host.session, { text: 'Too soon' }, 400);
      await request(`/api/decisions/${question.id}/chat`, peer.session, {
        text: 'Agreed, I will approve after voting.',
      });
      await request(`/api/decisions/${secondVote.id}/chat`, host.session, {
        text: 'Fixtures make the protocol deterministic.',
      });
      const discussionState: Room = await request('/api/room', peer.session);
      assert.equal(discussionState.decisions.find((d) => d.id === question.id)!.messages.length, 2);
      assert.equal(
        discussionState.decisions.find((d) => d.id === secondVote.id)!.messages.length,
        1,
      );
      const isolatedState: Room = await request('/api/room', guestRoom.session);
      assert.ok(
        !isolatedState.decisions.some((d) => d.id === question.id || d.id === secondVote.id),
      );
      const late = await request('/api/join', undefined, {
        code: host.room.code,
        memberName: 'Late',
      });
      await request(`/api/decisions/${question.id}/vote`, late.session, { option: 0 }, 400);
      await until(
        async () => states,
        (values) =>
          values.some(
            (r) =>
              Object.keys(r.decisions.find((d) => d.id === question.id)?.votes || {}).length === 2,
          ),
      );
      await until(
        async () => states,
        (values) =>
          values.some((r) => r.decisions.find((d) => d.id === question.id)?.messages.length === 2),
      );
      // The other agent can continue while the first waits for its team.
      await request(`/api/agents/${agent.id}/prompt`, host.session, { prompt: 'ASK_APPROVAL' });
      const approvalState = await until<Room>(
        () => request('/api/room', host.session),
        (r) => r.decisions.some((d) => d.scope === 'approval'),
      );
      const approval = approvalState.decisions.find((d) => d.scope === 'approval')!;
      await request(`/api/decisions/${approval.id}/promote`, peer.session, {}, 400);
      await request(
        `/api/decisions/${approval.id}/resolve`,
        peer.session,
        { answer: 'Allow once' },
        403,
      );
      await request(`/api/decisions/${approval.id}/resolve`, host.session, { answer: 'Decline' });
      const agentDir = path.join(dir, '.multiplayer', 'worktrees', host.room.id, agent.id);
      const peerDir = path.join(dir, '.multiplayer', 'worktrees', host.room.id, peerAgent.id);
      await until(
        async () => readFile(path.join(agentDir, 'answers.jsonl'), 'utf8').catch(() => ''),
        (value) => value.includes('decline'),
      );
      const overlap = await until<Room>(
        () => request('/api/room', host.session),
        (r) => r.overlaps.some((o) => o.path === 'shared.ts'),
      );
      assert.equal(overlap.overlaps.find((o) => o.path === 'shared.ts')!.agentIds.length, 2);
      const diff = await request(`/api/agents/${agent.id}/diff?file=shared.ts`, peer.session);
      assert.match(diff.diff, /\+export const eventType/);
      await request(
        `/api/agents/${agent.id}/diff?file=..%2FREADME.md`,
        peer.session,
        undefined,
        400,
      );
      await assert.rejects(readFile(path.join(dir, 'shared.ts')), /ENOENT/);
      const timedOut = await until<Room>(
        () => request('/api/room', host.session),
        (r) => r.decisions.find((d) => d.id === question.id)?.status === 'owner-needed',
        65000,
      );
      assert.equal(
        Object.keys(timedOut.decisions.find((d) => d.id === question.id)!.votes).length,
        2,
      );
      assert.equal(timedOut.agents.find((a) => a.id === peerAgent.id)!.status, 'waiting');
      assert.equal(timedOut.decisionVersion, 0);
      assert.equal(timedOut.decisions.find((d) => d.id === question.id)!.answer, undefined);
      await assert.rejects(readFile(path.join(peerDir, 'answers.jsonl')), /ENOENT/);
      // A unanimous result never resumes an agent. Even the host must wait for its owner.
      await request(
        `/api/decisions/${question.id}/resolve`,
        host.session,
        { answer: 'Typed' },
        403,
      );
      await request(`/api/decisions/${question.id}/chat`, peer.session, {
        text: 'Voting is done; ready to proceed.',
      });
      await request(`/api/decisions/${question.id}/vote`, host.session, { option: 0 }, 400);
      await request(`/api/decisions/${question.id}/resolve`, peer.session, { answer: 'Typed' });
      await request(
        `/api/decisions/${question.id}/chat`,
        peer.session,
        { text: 'After approval' },
        400,
      );
      const answers = await until(
        async () => readFile(path.join(peerDir, 'answers.jsonl'), 'utf8').catch(() => ''),
        (value) => value.includes('answers'),
      );
      assert.deepEqual(JSON.parse(answers.trim()), { answers: { q1: { answers: ['Typed'] } } });
      const settled = await until<Room>(
        () => request('/api/room', host.session),
        (r) => r.agents.find((a) => a.id === peerAgent.id)?.status === 'idle',
      );
      assert.equal(settled.decisionVersion, 1);
      assert.ok(
        settled.agents.every((a) => a.entries.some((e) => e.text === 'Team decided: Typed')),
      );
      // Dynamic team tool events must become votes; interrupting cancels stale requests.
      await request(`/api/agents/${agent.id}/prompt`, host.session, { prompt: 'ASK_TEAM' });
      await until<Room>(
        () => request('/api/room', host.session),
        (r) => r.decisions.some((d) => d.question === 'Which event format?' && d.status === 'open'),
      );
      await request(`/api/agents/${agent.id}/stop`, host.session, {});
      const stopped = await until<Room>(
        () => request('/api/room', host.session),
        (r) => r.agents.find((a) => a.id === agent.id)?.status === 'idle',
      );
      assert.equal(
        stopped.decisions.find((d) => d.question === 'Which event format?')!.status,
        'cancelled',
      );
      assert.equal((await git(dir, 'status', '--porcelain')).trim(), '');
    } finally {
      sockets.forEach((s) => s.terminate());
      process.kill('SIGTERM');
      await once(process, 'exit');
      await rm(dir, { recursive: true, force: true });
    }
  },
);
