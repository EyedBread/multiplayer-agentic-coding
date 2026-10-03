import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const projectBinary = fileURLToPath(new URL('../node_modules/.bin/codex', import.meta.url));
const desktopBinary = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
export const CODEX_BINARY =
  process.env.CODEX_BIN ||
  (existsSync(projectBinary) ? projectBinary : existsSync(desktopBinary) ? desktopBinary : 'codex');

type Rpc = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};
const decisionTool = {
  type: 'function',
  name: 'team_decision',
  description:
    'Ask the whole team to vote on a consequential shared API, dependency, architecture, or product decision. Blocks this agent until settled. Use for cross-team decisions only.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      context: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
    },
    required: ['question', 'context', 'options'],
    additionalProperties: false,
  },
};
export class CodexClient {
  process: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  serial = 0;
  threadId = '';
  turnId = '';
  stopped = false;
  constructor(
    readonly cwd: string,
    readonly onEvent: (message: Rpc) => void,
    readonly onExit: (message: string) => void,
    binary = CODEX_BINARY,
  ) {
    this.process = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    this.process.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-3000);
    });
    this.process.stdin.on('error', () => {});
    const reader = createInterface({ input: this.process.stdout });
    reader.on('line', (line) => {
      let message: Rpc;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        const pending = this.pending.get(Number(message.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(Number(message.id));
          if (message.error) pending.reject(new Error(message.error.message));
          else pending.resolve(message.result);
        }
      } else this.onEvent(message);
    });
    const fail = (reason: string) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.pending.clear();
      if (!this.stopped) {
        this.stopped = true;
        this.onExit(reason);
      }
    };
    this.process.on('error', (error) => fail(`Could not start Codex: ${error.message}`));
    this.process.on('exit', (code) => fail(`Codex disconnected (exit ${code}). ${stderr}`));
  }
  send(message: Rpc) {
    if (this.stopped || this.process.stdin.destroyed)
      throw new Error('Codex is disconnected. Start a new agent.');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex timed out during ${method}.`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async init() {
    await this.call('initialize', {
      clientInfo: { name: 'multiplayer_agentic_coding', title: 'Multiplayer', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    const result = await this.call('thread/start', {
      ...(process.env.CODEX_MODEL ? { model: process.env.CODEX_MODEL } : {}),
      cwd: this.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      dynamicTools: [decisionTool],
      developerInstructions:
        'You are in Multiplayer, a shared coding room. Work only in your assigned worktree. Do not merge, push, or modify other worktrees. Teammates can see your public messages and commands. Use team_decision for consequential shared API, dependency, architecture, or product choices; use ordinary user questions for task-local clarification. Explain progress briefly. Treat shared team decisions provided with prompts as constraints. Do not delegate to additional agents. Do not read secrets unless necessary for the explicitly requested task.',
    });
    this.threadId = result.thread.id;
    return this.threadId;
  }
  async prompt(text: string) {
    const result = await this.call('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    this.turnId = result.turn.id;
    return this.turnId;
  }
  async steer(text: string) {
    if (!this.turnId) return false;
    await this.call('turn/steer', {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    return true;
  }
  async interrupt() {
    if (this.turnId)
      await this.call('turn/interrupt', { threadId: this.threadId, turnId: this.turnId });
  }
  reply(id: string | number, result: unknown) {
    this.send({ id, result });
  }
  reject(id: string | number, message: string) {
    this.send({ id, error: { message } });
  }
  close() {
    this.stopped = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Session closed.'));
    }
    this.pending.clear();
    this.process.kill('SIGTERM');
  }
}
