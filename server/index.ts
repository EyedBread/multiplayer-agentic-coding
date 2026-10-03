import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Agent, Decision, Room, Session } from '../shared/types.js';
import type { HarnessClient, Runner } from '../shared/runner.js';
import { repositoryRemote } from '../shared/runner.js';
import { VOTE_DURATION_MS } from '../shared/types.js';
import {
  activity,
  addDecision,
  castVote,
  closeVoting,
  createRoom,
  discussDecision,
  entry,
  makeAgent,
  overlaps,
  settleDecision,
  token,
  uid,
} from './room.js';
import { changedFiles, createWorktree, fileDiff, repoInfo, git } from './git.js';
import { codexInvocation, CodexClient } from './codex.js';
import { RemoteHarnessClient, RunnerRegistry } from './runners.js';
import { demoDiff, runDemoScenario, seedDemo } from './demo.js';
import { ProjectRegistry } from './projects.js';

const exec = promisify(execFile);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoPath = path.resolve(process.env.HOST_REPO_PATH || appRoot);
const projects = new ProjectRegistry(
  repoPath,
  path.resolve(process.env.MULTIPLAYER_STATE_DIR || path.join(appRoot, '.multiplayer')),
);
await projects.load();
const rooms = new Map<string, Room>();
const sessions = new Map<string, Session>();
const clients = new Map<string, Set<WebSocket>>();
type Runtime = {
  client?: HarnessClient;
  cwd?: string;
  base?: string;
  polling?: boolean;
  demoTimer?: NodeJS.Timeout;
};
const runtimes = new Map<string, Runtime>();
const responders = new Map<string, (answer: string) => void | Promise<void>>();
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
  if (agent.ownerId !== session.memberId && (agent.runnerId || room.hostId !== session.memberId))
    throw Object.assign(
      new Error(
        agent.runnerId
          ? 'Only this agent’s owner can control their local runner.'
          : 'Only this agent’s owner or the host can control it.',
      ),
      {
        status: 403,
      },
    );
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
      await respond(answer);
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
            if (sent) agent.contextVersion = Math.max(agent.contextVersion, version);
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
  const reply = (id: string | number, result: unknown) => {
    void Promise.resolve()
      .then(() => client.reply(id, result))
      .catch((error) => {
        entry(agent, 'error', `Could not deliver the response: ${error}`);
        broadcast(room);
      });
  };
  const reject = (id: string | number, message: string) => {
    void Promise.resolve()
      .then(() => client.reject(id, message))
      .catch(() => {});
  };
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
        responders.set(d.id, async (answer) => {
          await client.reply(id, {
            contentItems: [{ type: 'inputText', text: answer }],
            success: true,
          });
          if (agent.status === 'waiting') agent.status = 'working';
        });
        bindRequest(room, agent, id, [d]);
        return;
      }
      if (
        message.method === 'item/tool/requestUserInput' ||
        message.method === 'tool/requestUserInput'
      ) {
        if (!Array.isArray(p.questions) || !p.questions.length || p.questions.length > 8)
          throw new Error('Provide one to eight structured questions.');
        if (p.questions.some((q: any) => q?.isSecret)) {
          reply(id, { answers: {} });
          entry(agent, 'system', 'Private input is not supported in a shared room.');
          return;
        }
        // Validate every question before changing room state, including duplicate answer keys.
        const questions = p.questions.map((q: any) => {
          if (
            !q ||
            typeof q !== 'object' ||
            (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 8))
          )
            throw new Error('Invalid structured question.');
          return {
            id: text(q.id, 'Question identifier', 100),
            question: text(q.question, 'Question', 1000),
            header: q.header
              ? text(q.header, 'Question header', 160)
              : 'A question from your agent',
            options: (q.options ?? []).map((o: any) => text(o?.label, 'Choice', 300)),
          };
        });
        if (new Set(questions.map((q: any) => q.id)).size !== questions.length)
          throw new Error('Question identifiers must be distinct.');
        const answers: Record<string, { answers: string[] }> = Object.create(null);
        const decisions = questions.map(
          (q: { id: string; question: string; header: string; options: string[] }) => {
            const d = addDecision(room, {
              agentId: agent.id,
              ownerId: agent.ownerId,
              question: q.question,
              detail: q.header || 'A question from your agent',
              options: q.options,
              scope: 'owner',
            });
            responders.set(d.id, async (answer) => {
              answers[q.id] = { answers: [answer] };
              if (Object.keys(answers).length === questions.length) {
                await client.reply(id, { answers });
                if (agent.status === 'waiting') agent.status = 'working';
              }
            });
            return d;
          },
        );
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
          reply(id, { decision: 'cancel' });
          return;
        }
        const d = addDecision(room, {
          agentId: agent.id,
          ownerId: agent.runnerId ? agent.ownerId : room.hostId,
          scope: 'approval',
          question: p.command ? 'Allow this command?' : 'Allow this file change?',
          detail: [p.command, p.reason, p.cwd].filter(Boolean).join('\n'),
          options: choices.map((c) => (c === 'accept' ? 'Allow once' : 'Decline')),
        });
        responders.set(d.id, async (answer) => {
          await client.reply(id, { decision: answer === 'Allow once' ? 'accept' : 'decline' });
          if (agent.status === 'waiting') agent.status = 'working';
        });
        bindRequest(room, agent, id, [d]);
        return;
      }
      if (message.method === 'item/permissions/requestApproval') {
        const d = addDecision(room, {
          agentId: agent.id,
          ownerId: agent.runnerId ? agent.ownerId : room.hostId,
          scope: 'approval',
          question: 'Allow additional permissions for this turn?',
          detail: `${p.reason || ''}\n${JSON.stringify(p.permissions, null, 2)}`,
          options: ['Allow once', 'Decline'],
        });
        responders.set(d.id, async (answer) => {
          await client.reply(id, {
            permissions: answer === 'Allow once' ? p.permissions : {},
            scope: 'turn',
          });
          if (agent.status === 'waiting') agent.status = 'working';
        });
        bindRequest(room, agent, id, [d]);
        return;
      }
      if (message.method === 'mcpServer/elicitation/request') {
        reply(id, { action: 'decline', content: null });
        entry(
          agent,
          'system',
          'External sign-in and app forms must be handled outside this shared room.',
        );
        return;
      }
      reject(id, `Unsupported request: ${message.method}`);
    } catch (error) {
      reject(id, String(error));
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
        `Changed ${(item.changes || []).map((c: any) => (agent.runnerId ? c.path : path.relative(runtimes.get(agent.id)?.cwd || '', c.path))).join(', ')}`,
        item.id,
      );
  } else if (message.method === 'error')
    entry(agent, 'error', p.error?.message || 'The harness reported an error.');
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

function updateFiles(room: Room, agent: Agent, files: string[]) {
  if (JSON.stringify(files) === JSON.stringify(agent.files)) return;
  const old = new Set(room.overlaps.map((o) => o.path));
  agent.files = files;
  room.overlaps = overlaps(room.agents);
  for (const o of room.overlaps)
    if (!old.has(o.path)) activity(room, `Potential overlap in ${o.path}`, 'overlap');
  broadcast(room);
}
async function connectRemoteAgent(room: Room, agent: Agent) {
  agent.status = 'starting';
  agent.error = undefined;
  const client = new RemoteHarnessClient(runnerRegistry, room, agent);
  runtimes.set(agent.id, { client });
  broadcast(room);
  try {
    await client.init();
    agent.status = 'idle';
    entry(
      agent,
      'system',
      `${agent.harness === 'claude' ? 'Claude Code' : 'Codex'} connected on your computer. Your isolated worktree is ready. Send a prompt to begin.`,
    );
  } catch (error) {
    const runner = room.runners.find((r) => r.id === agent.runnerId);
    agent.status = runner?.status === 'online' ? 'error' : 'offline';
    agent.error = String(error);
    entry(agent, 'error', String(error));
    client.close();
  }
  broadcast(room);
}
const runnerRegistry = new RunnerRegistry({
  auth,
  broadcast,
  ready(room: Room, runner: Runner) {
    activity(
      room,
      `${runner.name} connected with ${runner.harness === 'claude' ? 'Claude Code' : 'Codex'}`,
    );
    for (const agent of room.agents.filter((a) => a.runnerId === runner.id))
      void connectRemoteAgent(room, agent);
    broadcast(room);
  },
  disconnected(room, runner) {
    for (const agent of room.agents.filter((a) => a.runnerId === runner.id)) {
      cancelRequests(room, agent);
      runtimes.delete(agent.id);
      if (agent.status !== 'offline')
        entry(
          agent,
          'system',
          'Runner disconnected. The previous turn stopped. Reconnect the runner to start a fresh conversation in the same worktree, then send a prompt to continue.',
        );
      agent.status = 'offline';
      agent.contextVersion = 0;
    }
    broadcast(room);
  },
  event: codexEvent,
  files: updateFiles,
  error(room, agent, message) {
    agent.status = 'error';
    agent.error = message;
    entry(agent, 'error', message);
    cancelRequests(room, agent);
    broadcast(room);
  },
});
runnerRegistry.mount(app);

app.get('/api/config', async (req, res) => {
  const info = await repoInfo(repoPath).catch(() => ({
    name: path.basename(repoPath),
    branch: 'No Git repository',
    dirty: false,
  }));
  const command = codexInvocation(['--version']);
  const codexAvailable = await exec(command.command, command.args, { timeout: 5000 }).then(
    () => true,
    () => false,
  );
  res.json({
    repoName: info.name,
    repoPath: local(req.socket.remoteAddress) ? repoPath : '',
    branch: info.branch,
    dirty: info.dirty,
    codexAvailable,
    canHost: true,
    canManageProjects: local(req.socket.remoteAddress),
    projects: await projects.list(local(req.socket.remoteAddress)),
  });
});
app.post('/api/projects', async (req, res) => {
  if (!local(req.socket.remoteAddress))
    return res
      .status(403)
      .json({ error: 'Add project folders from the host computer at localhost.' });
  const id = await projects.add(req.body.path);
  res.json({ id, projects: await projects.list(true) });
});
app.post('/api/rooms', async (req, res) => {
  const mode = req.body.mode === 'live' ? 'live' : 'demo';
  if (rooms.size >= 20)
    throw new Error(
      'This host has reached its room limit. Restart the server to clear inactive rooms.',
    );
  const projectId = req.body.projectId ?? 'default';
  const selectedPath = mode === 'live' ? projects.resolve(projectId) : '';
  const info =
    mode === 'live'
      ? await repoInfo(selectedPath)
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
  if (mode === 'live') {
    room.projectId = projectId;
    const remote = await git(selectedPath, 'remote', 'get-url', 'origin').then(
      repositoryRemote,
      () => null,
    );
    room.project = {
      remoteUrl: remote?.remoteUrl ?? null,
      identity: remote?.identity ?? null,
      baseCommit: (await git(selectedPath, 'rev-parse', 'HEAD')).trim(),
    };
  }
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
  const runnerId = req.body.runnerId;
  const runner = runnerId
    ? room.runners.find((r) => r.id === runnerId && r.ownerId === session.memberId)
    : undefined;
  if (runnerId && (!runner || runner.status !== 'online'))
    throw new Error('Select an online runner that belongs to you.');
  const agent = makeAgent(
    room,
    session.memberId,
    text(req.body.name, 'Agent name', 32),
    text(req.body.task, 'Task', 300),
  );
  agent.harness = runner?.harness ?? 'codex';
  agent.runnerId = runner?.id;
  if (runner) {
    await connectRemoteAgent(room, agent);
    activity(room, `${agent.name} joined the workspace on ${runner.name}`);
    broadcast(room);
    res.json(agent);
    return;
  }
  runtimes.set(agent.id, {});
  broadcast(room);
  try {
    if (room.mode === 'live') {
      const worktree = await createWorktree(
        projects.resolve(room.projectId ?? 'default'),
        room.id,
        agent.id,
        agent.branch,
        room.project?.baseCommit,
        projects.worktreeRoot(room.projectId ?? 'default'),
      );
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
      if (!client) throw new Error('The agent’s harness is not connected.');
      const decisions = room.decisions
        .filter((d) => d.scope === 'team' && d.status === 'resolved')
        .reverse()
        .map((d) => `${d.question}\nDecision: ${d.answer}`)
        .join('\n\n');
      const contextVersion = room.decisionVersion;
      await client.prompt(
        `${decisions ? `SHARED TEAM DECISIONS:\n${decisions}\n\n` : ''}TASK: ${agent.task}\n\n${prompt}`,
      );
      agent.contextVersion = Math.max(agent.contextVersion, contextVersion);
    }
  } catch (error) {
    agent.status =
      agent.runnerId && room.runners.find((r) => r.id === agent.runnerId)?.status !== 'online'
        ? 'offline'
        : 'error';
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
app.post('/api/agents/:id/restart', async (req, res) => {
  const { room, session } = auth(req);
  const agent = getAgent(room, String(req.params.id));
  requireOwner(room, agent, session);
  if (!agent.runnerId || agent.status !== 'error')
    throw new Error('Only a failed local session can be restarted.');
  if (room.runners.find((r) => r.id === agent.runnerId)?.status !== 'online')
    throw new Error('Reconnect the runner in its terminal first.');
  agent.status = 'starting';
  cancelRequests(room, agent);
  broadcast(room);
  await runnerRegistry.call(agent.runnerId, agent.id, 'close').catch(() => {});
  entry(
    agent,
    'system',
    'Restarting a fresh conversation in the same worktree. Existing files are preserved.',
  );
  agent.contextVersion = 0;
  await connectRemoteAgent(room, agent);
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
      : agent.runnerId
        ? (await runnerRegistry.call(agent.runnerId, agent.id, 'diff', { file })).diff
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
  else if (req.params.action === 'chat') discussDecision(room, d, session.memberId, req.body.text);
  else if (req.params.action === 'promote') {
    if (d.scope !== 'owner' || d.options.length < 2)
      throw new Error('Only questions with two or more choices can become team votes.');
    d.scope = 'team';
    d.closesAt = Date.now() + VOTE_DURATION_MS;
    d.eligible = room.members.map((m) => m.id);
    activity(room, 'An agent question became a team vote', 'decision');
  } else if (req.params.action === 'resolve') {
    if (d.ownerId !== session.memberId)
      return res
        .status(403)
        .json({ error: 'Only the decision owner can approve the final answer.' });
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
  if (url.pathname === '/runner-ws') {
    runnerRegistry.upgrade(req, socket, head);
    return;
  }
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
      if (closeVoting(room, d)) broadcast(room);
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
            updateFiles(room, agent, files);
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
  runnerRegistry.close();
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
