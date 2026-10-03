import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { CodexClient } from '../server/codex.js';
import { changedFiles, fileDiff } from '../server/git.js';
import type {
  HarnessClient,
  HarnessEvent,
  RunnerBootstrap,
  RunnerMessage,
  RunnerRequest,
} from '../shared/runner.js';
import {
  defaultStatePath,
  loadState,
  normalizeServer,
  saveState,
  type RunnerState,
} from './state.js';
import { prepareAgentWorktree, prepareRepository, type PreparedRepository } from './workspace.js';

type Arguments = {
  server?: string;
  pair?: string;
  repo?: string;
  clone?: string;
  resume?: string;
  'state-file'?: string;
  name?: string;
  help?: string;
};
function argumentsFrom(values: string[]): Arguments {
  const result: Record<string, string> = {};
  const allowed = new Set(['server', 'pair', 'repo', 'clone', 'resume', 'state-file', 'name']);
  for (let i = 0; i < values.length; i++) {
    const key = values[i].replace(/^--/, '');
    if (values[i] === '--help' || values[i] === '-h') {
      result.help = 'true';
      continue;
    }
    if (
      !values[i].startsWith('--') ||
      !allowed.has(key) ||
      !values[i + 1] ||
      values[i + 1].startsWith('--')
    )
      throw new Error(
        `Unknown or incomplete argument: ${values[i]}. Run npm run runner -- --help.`,
      );
    if (key in result) throw new Error(`Specify --${key} only once.`);
    result[key] = values[++i];
  }
  return result;
}
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
class RunnerHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(
  server: string,
  route: string,
  token?: string,
  data?: unknown,
): Promise<T> {
  const response = await fetch(server + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new RunnerHttpError(
      result.error || `The room server returned HTTP ${response.status}.`,
      response.status,
    );
  return result as T;
}

const publicEvents = new Set([
  'turn/started',
  'turn/completed',
  'item/agentMessage/delta',
  'item/started',
  'item/completed',
  'error',
  'serverRequest/resolved',
  'item/tool/call',
  'item/tool/requestUserInput',
  'tool/requestUserInput',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
/** Share public progress only; machine-specific paths become relative to the agent worktree. */
export function publicEvent(event: HarnessEvent, cwd: string): HarnessEvent | null {
  if (!event.method || !publicEvents.has(event.method)) return null;
  if (
    (event.method === 'item/started' || event.method === 'item/completed') &&
    !['agentMessage', 'commandExecution', 'fileChange'].includes(event.params?.item?.type)
  )
    return null;
  function clean(value: unknown, key = '', depth = 0): unknown {
    if (depth > 12) return '[omitted]';
    if (
      /^(?:api_?key|access_?token|refresh_?token|token|authorization|password|secret|env|environment)$/i.test(
        key,
      )
    )
      return undefined;
    if (typeof value === 'string') {
      if (['path', 'cwd'].includes(key) && path.isAbsolute(value)) {
        const relative = path.relative(cwd, value);
        return relative === '..' ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
          ? '[outside worktree]'
          : relative.split(path.sep).join('/') || '.';
      }
      return value.slice(-24_000);
    }
    if (Array.isArray(value)) return value.slice(0, 100).map((item) => clean(item, key, depth + 1));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 100)
          .map(([childKey, child]) => [childKey, clean(child, childKey, depth + 1)]),
      );
    return value;
  }
  const sanitized: HarnessEvent = {
    ...(event.id === undefined ? {} : { id: event.id }),
    method: event.method,
    params: clean(event.params),
  };
  return Buffer.byteLength(JSON.stringify(sanitized)) <= 96 * 1024 ? sanitized : null;
}

export function boundedFiles(paths: string[]) {
  const files: string[] = [];
  let bytes = 2;
  for (const file of paths) {
    if (
      !file ||
      file.length > 1000 ||
      path.isAbsolute(file) ||
      /^[a-z]:/i.test(file) ||
      file.includes('\\') ||
      file.includes('\0') ||
      file.split('/').some((part) => part === '..' || part === '.git')
    )
      continue;
    const normalized = file.split(path.sep).join('/');
    const added = Buffer.byteLength(JSON.stringify(normalized)) + 1;
    if (files.length >= 1000 || bytes + added > 96 * 1024) break;
    files.push(normalized);
    bytes += added;
  }
  return { files, truncated: files.length < paths.length };
}

type Runtime = {
  client?: HarnessClient;
  cwd: string;
  base: string;
  generation: number;
  files: string;
  polling: boolean;
  completedTurns: Set<string>;
};
export function connectRunner(state: RunnerState, repository: PreparedRepository) {
  const runtimes = new Map<string, Runtime>();
  let socket: WebSocket | undefined;
  let generation = 0;
  let closed = false;
  let retry = 0;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function stopRuntime(agentId: string) {
    const runtime = runtimes.get(agentId);
    runtimes.delete(agentId);
    if (runtime?.client) {
      void runtime.client.interrupt().catch(() => {});
      runtime.client.close();
    }
  }
  function stopAll() {
    for (const agentId of [...runtimes.keys()]) stopRuntime(agentId);
  }
  function send(message: RunnerMessage, expectedGeneration = generation) {
    if (closed || generation !== expectedGeneration || socket?.readyState !== WebSocket.OPEN)
      return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(message));
  }
  function current(agentId: string, runtime: Runtime) {
    return !closed && runtime.generation === generation && runtimes.get(agentId) === runtime;
  }
  function textParam(params: any) {
    if (typeof params?.text !== 'string' || !params.text.trim() || params.text.length > 200_000)
      throw new Error('A nonempty prompt of at most 200,000 characters is required.');
    return params.text as string;
  }
  async function handle(message: RunnerRequest, expectedGeneration: number) {
    if (closed || expectedGeneration !== generation)
      throw new Error('Runner connection changed. Send a new request after reconnecting.');
    const { agentId, method, params } = message;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(agentId))
      throw new Error('Invalid agent identifier.');
    if (method === 'start') {
      if (runtimes.has(agentId)) throw new Error('This agent is already connected.');
      if (
        params?.agent?.id !== agentId ||
        params.agent.ownerId !== state.runner.ownerId ||
        params?.project?.baseCommit !== state.project.baseCommit ||
        params.project.identity !== state.project.identity
      )
        throw new Error('The agent does not belong to this runner’s owner or pinned project.');
      const workspace = await prepareAgentWorktree(repository, state.roomId, params.agent);
      if (closed || expectedGeneration !== generation)
        throw new Error('Disconnected before the agent started. Its worktree was preserved.');
      const runtime: Runtime = {
        ...workspace,
        generation: expectedGeneration,
        files: '',
        polling: false,
        completedTurns: new Set(),
      };
      runtimes.set(agentId, runtime);
      const onEvent = (event: HarnessEvent) => {
        if (!current(agentId, runtime)) return;
        if (runtime.client && event.method === 'turn/started')
          runtime.client.turnId = event.params?.turn?.id || '';
        if (event.method === 'turn/completed') {
          if (runtime.client) runtime.client.turnId = '';
          if (event.params?.turn?.id) runtime.completedTurns.add(event.params.turn.id);
          if (runtime.completedTurns.size > 20)
            runtime.completedTurns.delete(runtime.completedTurns.values().next().value!);
        }
        if (event.id !== undefined && event.method) {
          if (event.method === 'mcpServer/elicitation/request') {
            void runtime.client?.reply(event.id, { action: 'decline', content: null });
            return;
          }
          if (
            ['item/tool/requestUserInput', 'tool/requestUserInput'].includes(event.method) &&
            Array.isArray(event.params?.questions) &&
            event.params.questions.some((question: any) => question?.isSecret)
          ) {
            void runtime.client?.reply(event.id, { answers: {} });
            return;
          }
          if (!publicEvents.has(event.method)) {
            void runtime.client?.reject(
              event.id,
              'This private or unsupported request must be handled locally.',
            );
            return;
          }
        }
        const sanitized = publicEvent(event, workspace.cwd);
        if (sanitized) send({ type: 'event', agentId, event: sanitized }, expectedGeneration);
        else if (event.id !== undefined)
          void runtime.client?.reject(
            event.id,
            'This request is too large or unsupported for a shared room.',
          );
      };
      const onExit = (_reason: string) => {
        if (!current(agentId, runtime)) return;
        runtimes.delete(agentId);
        send(
          {
            type: 'agent-error',
            agentId,
            error: `${state.runner.harness} disconnected on its owner’s computer. Restart the session from the room.`,
          },
          expectedGeneration,
        );
      };
      try {
        if (state.runner.harness === 'claude') {
          const { ClaudeClient } = await import('./claude.js');
          if (!current(agentId, runtime))
            throw new Error('Runner disconnected while loading the harness.');
          runtime.client = new ClaudeClient(workspace.cwd, onEvent, onExit);
        } else runtime.client = new CodexClient(workspace.cwd, onEvent, onExit);
        const threadId = await runtime.client.init();
        if (!current(agentId, runtime)) {
          runtime.client.close();
          throw new Error('Runner disconnected while the harness started.');
        }
        return { threadId };
      } catch (error) {
        runtime.client?.close();
        if (runtimes.get(agentId) === runtime) runtimes.delete(agentId);
        throw error;
      }
    }
    const runtime = runtimes.get(agentId);
    if (!runtime?.client || !current(agentId, runtime))
      throw new Error(
        'The local agent is disconnected. Reconnect the runner before sending another task.',
      );
    if (method === 'prompt') {
      if (runtime.client.turnId) throw new Error('This agent already has a running turn.');
      const turnId = await runtime.client.prompt(textParam(params));
      // A fast provider can finish before the start RPC promise settles.
      if (runtime.completedTurns.has(turnId)) runtime.client.turnId = '';
      return { turnId };
    }
    if (method === 'steer') return { accepted: await runtime.client.steer(textParam(params)) };
    if (method === 'interrupt') {
      await runtime.client.interrupt();
      return {};
    }
    if (method === 'reply' || method === 'reject') {
      if (!['string', 'number'].includes(typeof params?.requestId))
        throw new Error('Invalid request identifier.');
      if (method === 'reply') await runtime.client.reply(params.requestId, params.result);
      else
        await runtime.client.reject(
          params.requestId,
          String(params.message || 'Request declined').slice(0, 2000),
        );
      return {};
    }
    if (method === 'diff') {
      if (typeof params?.file !== 'string' || params.file.length > 1024)
        throw new Error('Invalid changed file.');
      const diff = await fileDiff(runtime.cwd, runtime.base, params.file);
      return {
        diff:
          Buffer.byteLength(diff) > 96 * 1024
            ? Buffer.from(diff)
                .subarray(0, 96 * 1024)
                .toString('utf8') + '\n[Preview truncated]'
            : diff,
      };
    }
    if (method === 'close') {
      stopRuntime(agentId);
      return {};
    }
    throw new Error('Unsupported runner request.');
  }
  const fileTimer = setInterval(() => {
    for (const [agentId, runtime] of runtimes) {
      if (runtime.polling || !current(agentId, runtime)) continue;
      runtime.polling = true;
      void changedFiles(runtime.cwd, runtime.base)
        .then((files) => {
          if (!current(agentId, runtime)) return;
          const { files: relative, truncated } = boundedFiles(files);
          const serialized = JSON.stringify(relative);
          if (serialized !== runtime.files) {
            runtime.files = serialized;
            if (truncated)
              console.error(
                `Agent ${agentId}: changed-file report was limited to ${relative.length} safe paths. Inspect the complete list locally with git status.`,
              );
            send({ type: 'files', agentId, files: relative }, runtime.generation);
          }
        })
        .catch(() => {
          if (current(agentId, runtime))
            send(
              {
                type: 'agent-error',
                agentId,
                error: 'Local Git file tracking failed. Check the worktree on the runner computer.',
              },
              runtime.generation,
            );
        })
        .finally(() => {
          runtime.polling = false;
        });
    }
  }, 2000);
  function connect() {
    if (closed) return;
    const expectedGeneration = ++generation;
    const url = new URL('/runner-ws', state.server);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(url, {
      headers: { Authorization: `Bearer ${state.token}` },
      maxPayload: 512 * 1024,
      handshakeTimeout: 15_000,
    });
    socket = connection;
    const queues = new Map<string, Promise<unknown>>();
    const seen = new Set<string>();
    let alive = true;
    let opened = false;
    connection.on('open', () => {
      if (closed || expectedGeneration !== generation) {
        connection.close();
        return;
      }
      retry = 0;
      opened = true;
      console.log(
        `Runner connected: ${state.runner.name} (${state.runner.harness}). Keep this terminal open.`,
      );
      send(
        {
          type: 'ready',
          protocol: 1,
          baseCommit: repository.baseCommit,
          identity: repository.identity,
        },
        expectedGeneration,
      );
      heartbeat = setInterval(() => {
        if (!alive) {
          connection.terminate();
          return;
        }
        alive = false;
        connection.ping();
      }, 15_000);
    });
    connection.on('pong', () => {
      alive = true;
    });
    connection.on('message', (data) => {
      let message: RunnerRequest;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        message.type !== 'request' ||
        typeof message.id !== 'string' ||
        typeof message.agentId !== 'string' ||
        seen.has(message.id)
      )
        return;
      if (seen.size >= 10_000) {
        connection.close(1012, 'Refresh runner connection');
        return;
      }
      seen.add(message.id);
      const queued = (queues.get(message.agentId) ?? Promise.resolve())
        .catch(() => {})
        .then(() => handle(message, expectedGeneration));
      queues.set(message.agentId, queued);
      void queued
        .then(
          (result) => send({ type: 'result', id: message.id, result }, expectedGeneration),
          (error) =>
            send(
              {
                type: 'result',
                id: message.id,
                error: errorText(error).replaceAll(state.token, '[redacted]').slice(0, 2000),
              },
              expectedGeneration,
            ),
        )
        .finally(() => {
          if (queues.get(message.agentId) === queued) queues.delete(message.agentId);
        });
    });
    connection.on('error', () => {
      /* Close handles reconnect without printing credentials. */
    });
    connection.on('close', async (code) => {
      if (expectedGeneration !== generation) return;
      ++generation;
      clearInterval(heartbeat);
      stopAll();
      if (closed) return;
      const revoked = () => {
        closed = true;
        clearInterval(fileTimer);
        console.error(
          'Runner access expired, was revoked, or the project was rejected. Worktrees were preserved. Generate a new pairing code in the room and pair again.',
        );
        process.exitCode = 1;
      };
      if (code === 1008) {
        revoked();
        return;
      }
      if (!opened) {
        try {
          await request(state.server, '/api/runner', state.token);
        } catch (error) {
          if (error instanceof RunnerHttpError && [401, 404].includes(error.status)) {
            revoked();
            return;
          }
        }
      }
      if (closed) return;
      const delay = Math.min(1000 * 2 ** retry++, 30_000);
      console.error(
        `Room connection lost. Local turns stopped; worktrees kept. Reconnecting in ${delay / 1000}s.`,
      );
      reconnect = setTimeout(connect, delay);
    });
  }
  connect();
  return {
    close() {
      closed = true;
      ++generation;
      clearTimeout(reconnect);
      clearInterval(heartbeat);
      clearInterval(fileTimer);
      stopAll();
      socket?.terminate();
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = argumentsFrom(argv);
  if (args.help) {
    console.log(
      'Run your own coding harness in a shared room.\n\n  npm run runner -- --server http://HOST:3000 --pair CODE --repo /existing/checkout\n  npm run runner -- --server http://HOST:3000 --pair CODE --clone /new/checkout\n  npm run runner -- --resume /path/to/runner-state.json\n\nOptional: --state-file PATH, --name NAME. Pairing selects Codex or Claude.\nA resumed runner can use --repo PATH to repair its local checkout. Credentials stay on this computer.',
    );
    return;
  }
  let state: RunnerState;
  let stateFile: string;
  if (args.resume) {
    if (args.pair || args.server || args['state-file'])
      throw new Error(
        '--resume uses the server and credentials in its saved state. Do not combine it with --pair, --server, or --state-file.',
      );
    if (args.repo && args.clone) throw new Error('Choose one local checkout option.');
    stateFile = path.resolve(args.resume);
    state = await loadState(stateFile);
    const refreshed = await request<RunnerBootstrap>(state.server, '/api/runner', state.token);
    if (
      refreshed.roomId !== state.roomId ||
      refreshed.runner.id !== state.runner.id ||
      refreshed.runner.ownerId !== state.runner.ownerId ||
      refreshed.runner.harness !== state.runner.harness ||
      refreshed.project.baseCommit !== state.project.baseCommit ||
      refreshed.project.identity !== state.project.identity
    )
      throw new Error(
        'The saved runner no longer matches this room and project. Pair a new runner.',
      );
    state = { ...state, runner: refreshed.runner, project: refreshed.project };
    if (args.repo || args.clone) {
      state.repo = args.repo ? path.resolve(args.repo) : undefined;
      state.clone = args.clone ? path.resolve(args.clone) : undefined;
    }
  } else {
    if (!args.server || !args.pair || !!args.repo === !!args.clone)
      throw new Error(
        'Provide --server URL, --pair CODE, and exactly one of --repo PATH or --clone PATH.',
      );
    const server = normalizeServer(args.server);
    const claim = await request<RunnerBootstrap>(server, '/api/runners/claim', undefined, {
      code: args.pair.trim(),
      name: args.name || hostname(),
    });
    state = {
      ...claim,
      version: 1,
      server,
      ...(args.repo ? { repo: path.resolve(args.repo) } : { clone: path.resolve(args.clone!) }),
    };
    stateFile = path.resolve(args['state-file'] || defaultStatePath(claim));
  }
  await saveState(stateFile, state);
  console.log(
    `Runner credentials saved privately. Resume with:\nnpm run runner -- --resume ${shellQuote(stateFile)}`,
  );
  const repository = await prepareRepository({
    repo: state.repo,
    clone: state.clone,
    project: state.project,
  });
  state = { ...state, repo: repository.root, clone: undefined };
  await saveState(stateFile, state);
  console.log(
    `Project verified at ${repository.baseCommit.slice(0, 12)}. Harness: ${state.runner.harness}.`,
  );
  const runner = connectRunner(state, repository);
  const stop = () => {
    runner.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`Runner: ${errorText(error)}`);
    process.exitCode = 1;
  });
}
