import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Agent, Decision, Room, Session } from '../shared/types.js';
import {
  activity,
  addDecision,
  castVote,
  createRoom,
  entry,
  makeAgent,
  overlaps,
  settleDecision,
  token,
  uid,
  voteOutcome,
} from './room.js';
import { changedFiles, createWorktree, fileDiff, repoInfo } from './git.js';
import { CODEX_BINARY, CodexClient } from './codex.js';
import { demoDiff, runDemoScenario, seedDemo } from './demo.js';

const exec = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoPath = path.resolve(process.env.HOST_REPO_PATH || appRoot);
const rooms = new Map<string, Room>();
const sessions = new Map<string, Session>();
const clients = new Map<string, Set<WebSocket>>();
type Runtime = {
  client?: CodexClient;
  cwd?: string;
  base?: string;
  polling?: boolean;
  demoTimer?: NodeJS.Timeout;
};
const runtimes = new Map<string, Runtime>();
const responders = new Map<string, (answer: string) => void>();
const requestDecisions = new Map<string, string[]>();
const broadcastTimers = new Map<string, NodeJS.Timeout>();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.origin && req.headers.origin !== `${req.protocol}://${req.headers.host}`)
    return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  next();
});
const local = (address?: string) =>
  ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address || '');
function text(value: unknown, label: string, max = 160) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new Error(`${label} must be between 1 and ${max} characters.`);
  return value.trim();
}
function options(value: unknown) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4)
    throw new Error('Provide two to four choices.');
  const result = value.map((v) => text(v, 'Choice', 300));
  if (new Set(result).size !== result.length) throw new Error('Choices must be distinct.');
  return result;
}
function auth(req: express.Request) {
  const bearer = req.headers.authorization?.replace(/^Bearer /, '');
  const session = bearer ? sessions.get(bearer) : undefined;
  if (!session) throw Object.assign(new Error('Join a room to continue.'), { status: 401 });
  const room = rooms.get(session.roomId);
  if (!room)
    throw Object.assign(new Error('This room has ended. Create or join another room.'), {
      status: 404,
    });
  return { session, room };
}
function getAgent(room: Room, id: string) {
  const agent = room.agents.find((a) => a.id === id);
  if (!agent) throw new Error('Agent not found.');
  return agent;
}
function requireOwner(room: Room, agent: Agent, session: Session) {
  if (agent.ownerId !== session.memberId && room.hostId !== session.memberId)
    throw Object.assign(new Error('Only this agent’s owner or the host can control it.'), {
      status: 403,
    });
}
function newSession(room: Room, memberId: string): Session {
  const session = { roomId: room.id, memberId, token: token() };
  sessions.set(session.token, session);
  return session;
}
function broadcast(room: Room) {
  if (broadcastTimers.has(room.id)) return;
  broadcastTimers.set(
    room.id,
    setTimeout(() => {
      broadcastTimers.delete(room.id);
      for (const member of room.members)
        for (const ws of clients.get(member.id) ?? [])
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'state', room }));
    }, 60),
  );
}
function cancelRequests(room: Room, agent: Agent) {
  for (const d of room.decisions)
    if (d.agentId === agent.id && ['open', 'owner-needed'].includes(d.status)) {
      d.status = 'cancelled';
      responders.delete(d.id);
    }
  for (const key of requestDecisions.keys())
    if (key.startsWith(`${agent.id}:`)) requestDecisions.delete(key);
}
async function resolve(room: Room, decision: Decision, answer: string) {
  settleDecision(room, decision, answer);
  const respond = responders.get(decision.id);
  responders.delete(decision.id);
  if (respond) {
    try {
      respond(answer);
    } catch (error) {
      activity(room, `Could not deliver answer: ${String(error)}`);
    }
  }
  if (decision.scope === 'team') {
    const version = room.decisionVersion;
    const message = `TEAM DECISION #${version}: ${decision.question}\nAgreed answer: ${answer}\nApply this decision to your work. Report any incompatibility to the team.`;
    for (const agent of room.agents) {
      entry(agent, 'system', `Team decided: ${answer}`);
      const runtime = runtimes.get(agent.id);
      if (room.mode === 'demo') {
        agent.contextVersion = version;
        if (agent.id === decision.agentId) {
          agent.status = 'idle';
          entry(
            agent,
            'agent',
            `Got it. I’ll use “${answer}” and keep the shared event contract consistent.`,
          );
        }
      } else if (runtime?.client && agent.status === 'working') {
        void runtime.client
          .steer(message)
          .then((sent) => {
            if (sent) agent.contextVersion = version;
            broadcast(room);
          })
          .catch(() => {
            entry(agent, 'system', 'The latest team decision will be included in the next prompt.');
            broadcast(room);
          });
      }
    }
  }
  broadcast(room);
}
function bindRequest(room: Room, agent: Agent, requestId: string | number, decisions: Decision[]) {
  requestDecisions.set(
    `${agent.id}:${requestId}`,
    decisions.map((d) => d.id),
  );
  agent.status = 'waiting';
  broadcast(room);
}
function codexEvent(
  room: Room,
  agent: Agent,
  message: { id?: string | number; method?: string; params?: any },
) {
  const p = message.params || {};
  const client = runtimes.get(agent.id)?.client;
  if (!client) return;
  if (message.id !== undefined && message.method) {
    const id = message.id;
    try {
      if (message.method === 'item/tool/call' && p.tool === 'team_decision') {
        const args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments;
        const d = addDecision(room, {
          agentId: agent.id,
          ownerId: agent.ownerId,
          question: text(args.question, 'Question', 1000),
          detail: text(args.context, 'Context', 3000),
          options: options(args.options),
          scope: 'team',
        });
        responders.set(d.id, (answer) => {
          client.reply(id, { contentItems: [{ type: 'inputText', text: answer }], success: true });
          agent.status = 'working';
        });
        bindRequest(room, agent, id, [d]);
        return;
      }
      if (
        message.method === 'item/tool/requestUserInput' ||
        message.method === 'tool/requestUserInput'
      ) {
        const questions = p.questions as any[];
        if (!Array.isArray(questions) || questions.some((q) => q.isSecret)) {
          client.reply(id, { answers: {} });
          entry(agent, 'system', 'Private input is not supported in a shared room.');
          return;
        }
        const answers: Record<string, { answers: string[] }> = {};
        const decisions = questions.map((q) => {
          const d = addDecision(room, {
            agentId: agent.id,
            ownerId: agent.ownerId,
            question: q.question,
            detail: q.header || 'A question from your agent',
            options: (q.options ?? []).map((o: any) => o.label),
            scope: 'owner',
          });
          responders.set(d.id, (answer) => {
            answers[q.id] = { answers: [answer] };
            if (Object.keys(answers).length === questions.length) {
              client.reply(id, { answers });
              agent.status = 'working';
            }
          });
          return d;
        });
        bindRequest(room, agent, id, decisions);
        return;
      }
      if (
        message.method === 'item/commandExecution/requestApproval' ||
        message.method === 'item/fileChange/requestApproval'
      ) {
        const allowed = Array.isArray(p.availableDecisions)
          ? p.availableDecisions
          : ['accept', 'decline'];
        const choices = ['accept', 'decline'].filter((choice) => allowed.includes(choice));
        if (!choices.length) {
          client.reply(id, { decision: 'cancel' });
          return;
        }
        const d = addDecision(room, {
          agentId: agent.id,
          ownerId: room.hostId,
          scope: 'approval',
          question: p.command ? 'Allow this command?' : 'Allow this file change?',
          detail: [p.command, p.reason, p.cwd].filter(Boolean).join('\n'),
          options: choices.map((c) => (c === 'accept' ? 'Allow once' : 'Decline')),
        });
        responders.set(d.id, (answer) => {
          client.reply(id, { decision: answer === 'Allow once' ? 'accept' : 'decline' });
          agent.status = 'working';
        });
        bindRequest(room, agent, id, [d]);
        return;
      }
      if (message.method === 'item/permissions/requestApproval') {
        const d = addDecision(room, {
          agentId: agent.id,
          ownerId: room.hostId,
          scope: 'approval',
          question: 'Allow additional permissions for this turn?',
          detail: `${p.reason || ''}\n${JSON.stringify(p.permissions, null, 2)}`,
          options: ['Allow once', 'Decline'],
        });
        responders.set(d.id, (answer) => {
          client.reply(id, {
            permissions: answer === 'Allow once' ? p.permissions : {},
            scope: 'turn',
          });
          agent.status = 'working';
        });
        bindRequest(room, agent, id, [d]);
        return;
      }
      if (message.method === 'mcpServer/elicitation/request') {
        client.reply(id, { action: 'decline', content: null });
        entry(
          agent,
          'system',
          'External sign-in and app forms must be handled outside this shared room.',
        );
        return;
      }
      client.reject(id, `Unsupported request: ${message.method}`);
    } catch (error) {
      client.reject(id, String(error));
    }
  } else if (message.method === 'turn/started') {
    client.turnId = p.turn.id;
    agent.status = 'working';
  } else if (message.method === 'turn/completed') {
    client.turnId = '';
    cancelRequests(room, agent);
    agent.status = p.turn.status === 'failed' ? 'error' : 'idle';
    if (p.turn.error) entry(agent, 'error', p.turn.error.message || JSON.stringify(p.turn.error));
    activity(
      room,
      `${agent.name} ${p.turn.status === 'failed' ? 'hit an error' : p.turn.status === 'interrupted' ? 'was stopped' : 'finished a turn'}`,
    );
  } else if (message.method === 'item/agentMessage/delta') {
    const current = agent.entries.find((e) => e.id === p.itemId)?.text ?? '';
    entry(agent, 'agent', current + p.delta, p.itemId);
  } else if (message.method === 'item/started' || message.method === 'item/completed') {
    const item = p.item;
    if (item?.type === 'agentMessage' && item.text) entry(agent, 'agent', item.text, item.id);
    if (item?.type === 'commandExecution')
      entry(
        agent,
        'command',
        `${item.command}${item.aggregatedOutput ? `\n${item.aggregatedOutput}` : ''}`,
        item.id,
      );
    if (item?.type === 'fileChange' && message.method === 'item/completed')
      entry(
        agent,
        'system',
        `Changed ${(item.changes || []).map((c: any) => path.relative(runtimes.get(agent.id)?.cwd || '', c.path)).join(', ')}`,
        item.id,
      );
  } else if (message.method === 'error')
    entry(agent, 'error', p.error?.message || 'Codex reported an error.');
  else if (message.method === 'serverRequest/resolved') {
    const key = `${agent.id}:${p.requestId}`;
    for (const decisionId of requestDecisions.get(key) ?? []) {
      const d = room.decisions.find((d) => d.id === decisionId);
      if (d && ['open', 'owner-needed'].includes(d.status)) {
        d.status = 'cancelled';
        responders.delete(d.id);
      }
    }
    requestDecisions.delete(key);
    if (
      agent.status === 'waiting' &&
      !room.decisions.some(
        (d) => d.agentId === agent.id && ['open', 'owner-needed'].includes(d.status),
      )
    )
      agent.status = client.turnId ? 'working' : 'idle';
  }
  broadcast(room);
}

app.get('/api/config', async (req, res) => {
  const info = await repoInfo(repoPath).catch(() => ({
    name: path.basename(repoPath),
    branch: 'No Git repository',
    dirty: false,
  }));
  const codexAvailable = await exec(CODEX_BINARY, ['--version'], { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  res.json({
    repoName: info.name,
    repoPath: local(req.socket.remoteAddress) ? repoPath : '',
    branch: info.branch,
    dirty: info.dirty,
    codexAvailable,
    canHost: local(req.socket.remoteAddress),
  });
});
app.post('/api/rooms', async (req, res) => {
  const mode = req.body.mode === 'live' ? 'live' : 'demo';
  if (mode === 'live' && !local(req.socket.remoteAddress))
    return res.status(403).json({ error: 'Live rooms must be created from the host computer.' });
  if (rooms.size >= 20)
    throw new Error(
      'This host has reached its room limit. Restart the server to clear inactive rooms.',
    );
  const info =
    mode === 'live'
      ? await repoInfo(repoPath)
      : { name: 'weekend-planner', branch: 'main', dirty: false };
  if (mode === 'live' && info.dirty)
    throw new Error(
      'Commit or stash the host project’s changes first. Agent worktrees start from the latest commit.',
    );
  const room = createRoom(
    text(req.body.name, 'Room name', 60),
    text(req.body.memberName, 'Your name', 32),
    mode,
    info.name,
    info.branch,
  );
  if (mode === 'demo') seedDemo(room);
  rooms.set(room.id, room);
  res.json({ room, session: newSession(room, room.hostId) });
});
const joinAttempts = new Map<string, { count: number; until: number }>();
app.post('/api/join', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  let attempts = joinAttempts.get(ip);
  if (!attempts || attempts.until < Date.now()) {
    attempts = { count: 0, until: Date.now() + 60000 };
    joinAttempts.set(ip, attempts);
  }
  if (++attempts.count > 20)
    return res.status(429).json({ error: 'Too many join attempts. Try again in a minute.' });
  const code = text(req.body.code, 'Room code', 32).toUpperCase().replace(/[\s-]/g, '');
  const room = [...rooms.values()].find((r) => r.code === code);
  if (!room)
    return res
      .status(404)
      .json({ error: 'Room not found. Check the code and make sure the host is running.' });
  if (room.members.length >= 12) throw new Error('This room is full (12 teammates maximum).');
  const member = {
    id: uid(),
    name: text(req.body.memberName, 'Your name', 32),
    color: room.members.length % 4,
    online: false,
  };
  room.members.push(member);
  activity(room, `${member.name} joined the room`, 'join');
  broadcast(room);
  res.json({ room, session: newSession(room, member.id) });
});
app.get('/api/room', (req, res) => res.json(auth(req).room));
app.post('/api/agents', async (req, res) => {
  const { room, session } = auth(req);
  if (room.agents.length >= 6) throw new Error('A room can have up to six agents.');
  const agent = makeAgent(
    room,
    session.memberId,
    text(req.body.name, 'Agent name', 32),
    text(req.body.task, 'Task', 300),
  );
  runtimes.set(agent.id, {});
  broadcast(room);
  try {
    if (room.mode === 'live') {
      const worktree = await createWorktree(repoPath, room.id, agent.id, agent.branch);
      const runtime: Runtime = { ...worktree };
      runtimes.set(agent.id, runtime);
      runtime.client = new CodexClient(
        worktree.cwd,
        (message) => codexEvent(room, agent, message),
        (message) => {
          agent.status = 'error';
          agent.error = message;
          entry(agent, 'error', message);
          cancelRequests(room, agent);
          broadcast(room);
        },
      );
      await runtime.client.init();
    }
    agent.status = 'idle';
    entry(
      agent,
      'system',
      room.mode === 'demo'
        ? 'Simulated agent ready. Prompts here do not execute code.'
        : 'Codex connected. Your isolated worktree is ready.',
    );
    activity(room, `${agent.name} joined the workspace`);
  } catch (error) {
    agent.status = 'error';
    agent.error = String(error);
    entry(agent, 'error', String(error));
    runtimes.get(agent.id)?.client?.close();
  }
  broadcast(room);
  res.json(agent);
});
app.post('/api/agents/:id/prompt', async (req, res) => {
  const { room, session } = auth(req);
  const agent = getAgent(room, String(req.params.id));
  requireOwner(room, agent, session);
  if (agent.status !== 'idle' && !(agent.status === 'error' && !agent.error))
    throw new Error('Wait for the agent to finish or resolve its pending question.');
  const prompt = text(req.body.prompt, 'Prompt', 12000);
  entry(agent, 'user', prompt);
  agent.status = 'working';
  broadcast(room);
  try {
    if (room.mode === 'demo') {
      agent.contextVersion = room.decisionVersion;
      const runtime = runtimes.get(agent.id) ?? {};
      runtimes.set(agent.id, runtime);
      runtime.demoTimer = setTimeout(() => {
        entry(
          agent,
          'agent',
          `Demo response: I’d start by checking the relevant files, then implement “${prompt.slice(0, 140)}”. Try the team scenario to see a shared decision and an overlap alert. Live rooms run this through Codex.`,
        );
        agent.status = 'idle';
        broadcast(room);
      }, 1500);
    } else {
      const client = runtimes.get(agent.id)?.client;
      if (!client) throw new Error('Codex is not connected.');
      const decisions = room.decisions
        .filter((d) => d.scope === 'team' && d.status === 'resolved')
        .reverse()
        .map((d) => `${d.question}\nDecision: ${d.answer}`)
        .join('\n\n');
      await client.prompt(
        `${decisions ? `SHARED TEAM DECISIONS:\n${decisions}\n\n` : ''}TASK: ${agent.task}\n\n${prompt}`,
      );
      agent.contextVersion = room.decisionVersion;
    }
  } catch (error) {
    agent.status = 'error';
    entry(agent, 'error', String(error));
  }
  broadcast(room);
  res.json({ ok: true });
});
app.post('/api/agents/:id/stop', async (req, res) => {
  const { room, session } = auth(req);
  const agent = getAgent(room, String(req.params.id));
  requireOwner(room, agent, session);
  const runtime = runtimes.get(agent.id);
  if (room.mode === 'demo') {
    clearTimeout(runtime?.demoTimer);
    agent.status = 'idle';
    cancelRequests(room, agent);
  } else await runtime?.client?.interrupt();
  broadcast(room);
  res.json({ ok: true });
});
app.get('/api/agents/:id/diff', async (req, res) => {
  const { room } = auth(req);
  const agent = getAgent(room, String(req.params.id));
  const file = text(req.query.file, 'File', 1000);
  if (!agent.files.includes(file)) throw new Error('Changed file not found.');
  const runtime = runtimes.get(agent.id);
  const diff =
    room.mode === 'demo'
      ? demoDiff(file, agent.name)
      : await fileDiff(runtime!.cwd!, runtime!.base!, file);
  res.json({ diff });
});
app.post('/api/decisions', (req, res) => {
  const { room, session } = auth(req);
  if (room.decisions.filter((d) => ['open', 'owner-needed'].includes(d.status)).length >= 10)
    throw new Error('Settle an existing decision first.');
  const d = addDecision(room, {
    ownerId: session.memberId,
    question: text(req.body.question, 'Question', 500),
    detail: typeof req.body.detail === 'string' ? req.body.detail.slice(0, 2000) : '',
    options: options(req.body.options),
    scope: 'team',
  });
  broadcast(room);
  res.json(d);
});
app.post('/api/decisions/:id/:action', async (req, res) => {
  const { room, session } = auth(req);
  const d = room.decisions.find((d) => d.id === req.params.id);
  if (!d) throw new Error('Decision not found.');
  if (!['open', 'owner-needed'].includes(d.status))
    throw new Error('This decision is already closed.');
  if (req.params.action === 'vote') castVote(room, d, session.memberId, req.body.option);
  else if (req.params.action === 'promote') {
    if (d.scope !== 'owner' || d.options.length < 2)
      throw new Error('Only questions with two or more choices can become team votes.');
    d.scope = 'team';
    d.closesAt = Date.now() + 30000;
    d.eligible = room.members.map((m) => m.id);
    activity(room, 'An agent question became a team vote', 'decision');
  } else if (req.params.action === 'resolve') {
    if (![d.ownerId, room.hostId].includes(session.memberId))
      return res
        .status(403)
        .json({ error: 'Only the decision owner or host can settle this question.' });
    if (d.scope === 'team' && d.status === 'open')
      throw new Error('Let the voting window finish first.');
    const answer = text(req.body.answer, 'Answer', 3000);
    if (d.options.length && !d.options.includes(answer))
      throw new Error('Choose one of the available answers.');
    await resolve(room, d, answer);
  } else throw new Error('Unknown action.');
  broadcast(room);
  res.json({ ok: true });
});
app.post('/api/demo/scenario', (req, res) => {
  const { room, session } = auth(req);
  if (room.mode !== 'demo') throw new Error('Scenarios are only available in demo rooms.');
  if (session.memberId !== room.hostId) throw new Error('The host starts the demo scenario.');
  const d = runDemoScenario(room);
  broadcast(room);
  res.json(d);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
  res.status(error.status || 400).json({ error: error.message || 'Something went wrong.' }),
);

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') return; // Vite handles its own HMR socket.
  const origin = req.headers.origin;
  const originHost = origin
    ? (() => {
        try {
          return new URL(origin).host;
        } catch {
          return '';
        }
      })()
    : '';
  if (originHost !== req.headers.host) {
    socket.destroy();
    return;
  }
  const session = sessions.get(url.searchParams.get('token') || '');
  const room = session ? rooms.get(session.roomId) : undefined;
  if (!session || !room) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const connections = clients.get(session.memberId) ?? new Set<WebSocket>();
    connections.add(ws);
    clients.set(session.memberId, connections);
    const member = room.members.find((m) => m.id === session.memberId)!;
    member.online = true;
    ws.send(JSON.stringify({ type: 'state', room }));
    broadcast(room);
    let alive = true;
    ws.on('pong', () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) ws.terminate();
      else {
        alive = false;
        ws.ping();
      }
    }, 15000);
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearInterval(heartbeat);
      connections.delete(ws);
      if (!connections.size) {
        clients.delete(member.id);
        member.online = false;
      }
      broadcast(room);
    });
  });
});
const voteTimer = setInterval(() => {
  for (const room of rooms.values())
    for (const d of room.decisions) {
      if (d.scope !== 'team' || d.status !== 'open' || Date.now() < (d.closesAt ?? Infinity))
        continue;
      const winner = voteOutcome(d);
      if (winner === null) {
        d.status = 'owner-needed';
        activity(room, 'Voting ended without a winner. The owner can decide.', 'decision');
        broadcast(room);
      } else void resolve(room, d, d.options[winner]);
    }
  for (const [ip, attempts] of joinAttempts)
    if (attempts.until < Date.now()) joinAttempts.delete(ip);
}, 500);
const fileTimer = setInterval(() => {
  for (const room of rooms.values())
    if (room.mode === 'live')
      for (const agent of room.agents) {
        const runtime = runtimes.get(agent.id);
        if (!runtime?.cwd || !runtime.base || runtime.polling) continue;
        runtime.polling = true;
        void changedFiles(runtime.cwd, runtime.base)
          .then((files) => {
            if (JSON.stringify(files) !== JSON.stringify(agent.files)) {
              const old = new Set(room.overlaps.map((o) => o.path));
              agent.files = files;
              room.overlaps = overlaps(room.agents);
              for (const o of room.overlaps)
                if (!old.has(o.path)) activity(room, `Potential overlap in ${o.path}`, 'overlap');
              broadcast(room);
            }
          })
          .catch((error) => {
            if (agent.error !== String(error)) {
              agent.error = String(error);
              entry(agent, 'error', `File tracking: ${error}`);
              broadcast(room);
            }
          })
          .finally(() => {
            runtime.polling = false;
          });
      }
}, 2000);

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(appRoot, 'dist')));
  app.use((_req, res) => res.sendFile(path.join(appRoot, 'dist', 'index.html')));
} else {
  const { createServer: createVite } = await import('vite');
  const vite = await createVite({
    root: appRoot,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}
const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || '127.0.0.1', () =>
  console.log(
    `Multiplayer is ready at http://${process.env.HOST || '127.0.0.1'}:${port}\nHost project: ${repoPath}`,
  ),
);
function shutdown() {
  clearInterval(voteTimer);
  clearInterval(fileTimer);
  for (const runtime of runtimes.values()) {
    runtime.client?.close();
    clearTimeout(runtime.demoTimer);
  }
  for (const socket of wss.clients) socket.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
