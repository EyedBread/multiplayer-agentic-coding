import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Express, Request } from 'express';
import type { Agent, Room, Session } from '../shared/types.js';
import type {
  HarnessClient,
  HarnessEvent,
  Runner,
  RunnerBootstrap,
  RunnerRequest,
} from '../shared/runner.js';

type Credentials = { token: string; runner: Runner; room: Room };
type Pending = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type Connection = {
  ws: WebSocket;
  credential: Credentials;
  ready: boolean;
  pending: Map<string, Pending>;
};
type Hooks = {
  auth(req: Request): { room: Room; session: Session };
  broadcast(room: Room): void;
  ready(room: Room, runner: Runner): void;
  disconnected(room: Room, runner: Runner): void;
  event(room: Room, agent: Agent, event: HarnessEvent): void;
  files(room: Room, agent: Agent, files: string[]): void;
  error(room: Room, agent: Agent, message: string): void;
};
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
const safePath = (file: unknown): file is string =>
  typeof file === 'string' &&
  file.length > 0 &&
  file.length <= 1000 &&
  !file.startsWith('/') &&
  !file.includes('\\') &&
  !file.includes('\0') &&
  !/^[a-z]:/i.test(file) &&
  !file.split('/').some((part) => part === '..' || part === '.git');

export class RunnerRegistry {
  private credentials = new Map<string, Credentials>();
  private pairings = new Map<
    string,
    { room: Room; ownerId: string; harness: Runner['harness']; expiresAt: number }
  >();
  private connections = new Map<string, Connection>();
  private attempts = new Map<string, { count: number; until: number }>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  constructor(private hooks: Hooks) {}

  mount(app: Express) {
    app.post('/api/runners/pair', (req, res) => {
      const { room, session } = this.hooks.auth(req);
      if (room.mode !== 'live' || !room.project)
        throw fail('Connect local runners in a live room.');
      if (!['codex', 'claude'].includes(req.body.harness))
        throw fail('Choose Codex or Claude Code.');
      for (const [code, p] of this.pairings)
        if (p.expiresAt <= Date.now() || (p.room.id === room.id && p.ownerId === session.memberId))
          this.pairings.delete(code);
      if (room.runners.length >= 12)
        throw fail(
          'This room has reached its limit of 12 runners. Disconnect an unused runner first.',
        );
      const code = randomBytes(12).toString('hex').toUpperCase();
      const expiresAt = Date.now() + 10 * 60_000;
      this.pairings.set(code, {
        room,
        ownerId: session.memberId,
        harness: req.body.harness,
        expiresAt,
      });
      res.json({ code, expiresAt, project: room.project });
    });
    app.post('/api/runners/claim', (req, res) => {
      const ip = req.socket.remoteAddress || '';
      for (const [key, attempt] of this.attempts)
        if (attempt.until < Date.now()) this.attempts.delete(key);
      const attempt = this.attempts.get(ip) || { count: 0, until: Date.now() + 60_000 };
      this.attempts.set(ip, attempt);
      if (++attempt.count > 30)
        throw fail('Too many pairing attempts. Try again in a minute.', 429);
      const code =
        typeof req.body.code === 'string' ? req.body.code.toUpperCase().replace(/[\s-]/g, '') : '';
      const pairing = this.pairings.get(code);
      if (!pairing || pairing.expiresAt <= Date.now())
        throw fail(
          'This pairing code is invalid or expired. Generate a new code in your room.',
          401,
        );
      if (pairing.room.runners.length >= 12) throw fail('This room has reached its runner limit.');
      this.pairings.delete(code);
      const runner: Runner = {
        id: randomUUID(),
        ownerId: pairing.ownerId,
        harness: pairing.harness,
        name:
          typeof req.body.name === 'string'
            ? req.body.name.trim().slice(0, 60) || 'My computer'
            : 'My computer',
        status: 'connecting',
      };
      const credential = { token: randomBytes(32).toString('hex'), room: pairing.room, runner };
      this.credentials.set(credential.token, credential);
      pairing.room.runners.push(runner);
      this.hooks.broadcast(pairing.room);
      res.json(this.bootstrap(credential));
    });
    app.get('/api/runner', (req, res) => res.json(this.bootstrap(this.authenticate(req))));
    app.post('/api/runners/:id/revoke', (req, res) => {
      const { room, session } = this.hooks.auth(req);
      const runner = room.runners.find((r) => r.id === req.params.id);
      if (!runner || runner.ownerId !== session.memberId)
        throw fail('Only the runner owner can disconnect it.', 403);
      for (const [key, value] of this.credentials)
        if (value.runner.id === runner.id) this.credentials.delete(key);
      this.connections
        .get(runner.id)
        ?.ws.close(1008, 'Runner access revoked. Pair again to reconnect.');
      runner.status = 'offline';
      this.hooks.disconnected(room, runner);
      // Preserve the device label for its existing sessions. An unused runner can be removed.
      if (!room.agents.some((a) => a.runnerId === runner.id))
        room.runners = room.runners.filter((r) => r.id !== runner.id);
      this.hooks.broadcast(room);
      res.json({ ok: true });
    });
  }
  private bootstrap(c: Credentials): RunnerBootstrap {
    return { token: c.token, runner: c.runner, roomId: c.room.id, project: c.room.project! };
  }
  private authenticate(req: IncomingMessage) {
    const c = this.credentials.get(req.headers.authorization?.replace(/^Bearer /, '') || '');
    if (!c)
      throw fail(
        'Runner access expired. Pair again in your room. Your local worktrees are unchanged.',
        401,
      );
    return c;
  }
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    let credential: Credentials;
    try {
      if (req.headers.origin) throw fail('Use the local runner CLI.');
      credential = this.authenticate(req);
      if (this.connections.has(credential.runner.id))
        throw fail('This runner is already connected.');
    } catch {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const connection: Connection = { ws, credential, ready: false, pending: new Map() };
      this.connections.set(credential.runner.id, connection);
      credential.runner.status = 'connecting';
      this.hooks.broadcast(credential.room);
      let alive = true;
      const readyTimeout = setTimeout(() => {
        if (!connection.ready) ws.close(1008, 'Runner did not verify its project.');
      }, 30_000);
      const heartbeat = setInterval(() => {
        if (!alive) ws.terminate();
        else {
          alive = false;
          ws.ping();
        }
      }, 15_000);
      ws.on('pong', () => {
        alive = true;
      });
      ws.on('error', () => ws.terminate());
      ws.on('message', (raw) => {
        if (this.connections.get(credential.runner.id) !== connection) return;
        try {
          const message = JSON.parse(raw.toString());
          if (message.type === 'ready' && !connection.ready) {
            const project = credential.room.project!;
            if (
              message.protocol !== 1 ||
              message.baseCommit !== project.baseCommit ||
              message.identity !== project.identity
            )
              throw fail('The runner is connected to a different repository or commit.');
            clearTimeout(readyTimeout);
            connection.ready = true;
            credential.runner.modelSelection = message.capabilities?.modelSelection === true;
            credential.runner.status = 'online';
            this.hooks.ready(credential.room, credential.runner);
          } else if (message.type === 'result' && typeof message.id === 'string') {
            const pending = connection.pending.get(message.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            connection.pending.delete(message.id);
            if (typeof message.error === 'string')
              pending.reject(new Error(message.error.slice(0, 3000)));
            else pending.resolve(message.result);
          } else if (connection.ready) {
            const agent = credential.room.agents.find(
              (a) =>
                a.id === message.agentId &&
                a.runnerId === credential.runner.id &&
                a.ownerId === credential.runner.ownerId,
            );
            if (!agent) throw fail('Agent does not belong to this runner.');
            if (message.type === 'event') {
              const event = message.event;
              if (
                !event ||
                typeof event !== 'object' ||
                typeof event.method !== 'string' ||
                !event.params ||
                typeof event.params !== 'object'
              )
                throw fail('Invalid harness event.');
              // A malformed provider event must never escape this WebSocket callback.
              this.hooks.event(credential.room, agent, event);
            } else if (message.type === 'files') {
              if (
                !Array.isArray(message.files) ||
                message.files.length > 2000 ||
                !message.files.every(safePath)
              )
                throw fail('Invalid changed-file report.');
              this.hooks.files(credential.room, agent, [...new Set<string>(message.files)].sort());
            } else if (message.type === 'agent-error' && typeof message.error === 'string') {
              this.hooks.error(credential.room, agent, message.error.slice(0, 3000));
            } else throw fail('Unknown runner message.');
          } else throw fail('Verify the project before sending agent events.');
        } catch {
          ws.close(1008, 'Invalid runner message. Reconnect after checking the local runner.');
        }
      });
      ws.on('close', () => {
        clearTimeout(heartbeat);
        clearTimeout(readyTimeout);
        for (const pending of connection.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Runner disconnected. The local turn has been stopped.'));
        }
        connection.pending.clear();
        if (this.connections.get(credential.runner.id) === connection) {
          this.connections.delete(credential.runner.id);
          credential.runner.status = 'offline';
          this.hooks.disconnected(credential.room, credential.runner);
        }
      });
    });
  }
  call(
    runnerId: string,
    agentId: string,
    method: RunnerRequest['method'],
    params: any = {},
  ): Promise<any> {
    const connection = this.connections.get(runnerId);
    if (!connection?.ready || connection.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error('This runner is offline. Reconnect it on its owner’s computer.'),
      );
    if (connection.pending.size >= 50)
      return Promise.reject(new Error('This runner is busy. Try again shortly.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          connection.pending.delete(id);
          reject(new Error(`The local runner timed out during ${method}. Check its terminal.`));
        },
        method === 'start' ? 90_000 : 40_000,
      );
      connection.pending.set(id, { resolve, reject, timer });
      connection.ws.send(
        JSON.stringify({ type: 'request', id, method, agentId, params } satisfies RunnerRequest),
        (error) => {
          if (error) {
            clearTimeout(timer);
            connection.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  close() {
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

export class RemoteHarnessClient implements HarnessClient {
  turnId = '';
  constructor(
    private registry: RunnerRegistry,
    private room: Room,
    private agent: Agent,
  ) {}
  private call(method: RunnerRequest['method'], params?: any) {
    return this.registry.call(this.agent.runnerId!, this.agent.id, method, params);
  }
  async init() {
    const result = await this.call('start', {
      agent: {
        id: this.agent.id,
        ownerId: this.agent.ownerId,
        name: this.agent.name,
        task: this.agent.task,
        branch: this.agent.branch,
        model: this.agent.model,
      },
      project: this.room.project,
    });
    return result.threadId as string;
  }
  async prompt(text: string) {
    const result = await this.call('prompt', { text });
    return result.turnId as string;
  }
  async steer(text: string) {
    const result = await this.call('steer', { text });
    return result.accepted === true;
  }
  async interrupt() {
    await this.call('interrupt');
  }
  async reply(requestId: string | number, result: unknown) {
    await this.call('reply', { requestId, result });
  }
  async reject(requestId: string | number, message: string) {
    await this.call('reject', { requestId, message });
  }
  close() {
    void this.call('close').catch(() => {});
  }
}
