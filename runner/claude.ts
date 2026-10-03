import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type Options,
  type SDKMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { HarnessClient, HarnessEvent } from '../shared/runner.js';

type ClaudeQuery = AsyncIterable<SDKMessage> & { close(): void };
export type ClaudeQueryFactory = (input: { prompt: string; options: Options }) => ClaudeQuery;
type Dependencies = {
  query?: ClaudeQueryFactory;
  createServer?: typeof createSdkMcpServer;
  env?: NodeJS.ProcessEnv;
};
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
};
type Turn = {
  id: string;
  query: ClaudeQuery;
  controller: AbortController;
  interrupted: boolean;
  done: Promise<void>;
};
const questionSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().min(1).max(1000),
        header: z.string().max(100).optional(),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(500),
              description: z.string().max(2000).optional(),
            }),
          )
          .min(2)
          .max(4),
        multiSelect: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(4),
});
const instructions =
  'You are in Multiplayer, a shared coding room. Work only in your assigned worktree. ' +
  'Do not merge, push, modify other worktrees, or delegate to additional agents. ' +
  'Teammates see your public messages and commands. Never put credentials or private reasoning in them. ' +
  'Use mcp__multiplayer__team_decision for consequential shared API, dependency, architecture, ' +
  'or product decisions. This tool waits for a team vote and the session owner’s final answer. ' +
  'Use AskUserQuestion for task-local clarification. Treat shared team decisions supplied in prompts as constraints. ' +
  'Explain progress briefly. Do not read secrets unless necessary for the explicitly requested task.';

/** Claude Code runs locally through its official Agent SDK; only public events leave this adapter. */
export class ClaudeClient implements HarnessClient {
  threadId: string = randomUUID();
  turnId = '';
  private sessionStarted = false;
  private initialized = false;
  private stopped = false;
  private current?: Turn;
  private pending = new Map<string, Pending>();
  private readonly makeQuery: ClaudeQueryFactory;
  private readonly makeServer: typeof createSdkMcpServer;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly cwd: string,
    readonly onEvent: (event: HarnessEvent) => void,
    readonly onExit: (message: string) => void,
    dependencies: Dependencies = {},
  ) {
    this.makeQuery = dependencies.query ?? query;
    this.makeServer = dependencies.createServer ?? createSdkMcpServer;
    this.env = dependencies.env ?? process.env;
  }

  async init() {
    if (this.stopped) throw new Error('Claude is disconnected. Reconnect the runner.');
    // The official SDK resolves this machine's Claude login, API key, or provider
    // credentials itself. Initializing a worktree does not make a model request.
    this.initialized = true;
    return this.threadId;
  }

  async prompt(text: string) {
    if (!this.initialized || this.stopped) throw new Error('Claude is not connected.');
    if (this.current)
      throw new Error('Claude is already working. Stop this turn before sending another prompt.');
    const controller = new AbortController();
    const server = this.makeServer({
      name: 'multiplayer',
      version: '1.0.0',
      tools: [
        tool(
          'team_decision',
          'Ask the team to vote on a consequential shared API, dependency, architecture, or product decision. Waits for the owner’s final answer.',
          {
            question: z.string().min(1).max(1000),
            context: z.string().min(1).max(3000),
            options: z.array(z.string().min(1).max(500)).min(2).max(4),
          },
          async (args) => {
            try {
              const response = (await this.request(
                'item/tool/call',
                {
                  tool: 'team_decision',
                  arguments: args,
                },
                controller.signal,
              )) as { success?: boolean; contentItems?: { type: string; text?: string }[] };
              const answer = response?.contentItems
                ?.filter((item) => item.type === 'inputText' && typeof item.text === 'string')
                .map((item) => item.text)
                .join('\n');
              if (!response?.success || !answer)
                throw new Error('The team decision was cancelled.');
              return { content: [{ type: 'text', text: answer }] };
            } catch {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'The team decision was cancelled. Do not assume an answer.',
                  },
                ],
                isError: true,
              };
            }
          },
          { annotations: { readOnlyHint: true, destructiveHint: false }, alwaysLoad: true },
        ),
      ],
    });
    const run: Turn = {
      id: randomUUID(),
      controller,
      interrupted: false,
      done: Promise.resolve(),
      query: this.makeQuery({
        prompt: text,
        options: {
          cwd: this.cwd,
          abortController: controller,
          ...(this.sessionStarted ? { resume: this.threadId } : { sessionId: this.threadId }),
          ...(this.env.CLAUDE_MODEL ? { model: this.env.CLAUDE_MODEL } : {}),
          permissionMode: 'default',
          canUseTool: this.canUseTool,
          // Repo/user settings can contain hooks and broad permission grants. Start
          // with SDK defaults; only this no-side-effect collaboration tool is preapproved.
          settingSources: [],
          allowedTools: ['mcp__multiplayer__team_decision'],
          disallowedTools: ['Agent', 'Task'],
          mcpServers: { multiplayer: server },
          systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
          includePartialMessages: true,
          env: { ...this.env },
        },
      }),
    };
    this.current = run;
    this.turnId = run.id;
    this.emit({ method: 'turn/started', params: { turn: { id: run.id } } });
    run.done = this.consume(run);
    return run.id;
  }

  // A fresh query resumes the exact local session. New shared decisions go in the
  // next user prompt; we do not claim a running Claude turn has consumed them.
  async steer(_text: string) {
    return false;
  }

  async interrupt() {
    const run = this.current;
    if (!run) return;
    run.interrupted = true;
    run.controller.abort();
    this.cancelPending('The turn was stopped.');
    run.query.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        run.done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error('Claude did not stop in time. Reconnect this runner before continuing.'),
              ),
            5000,
          );
        }),
      ]);
    } catch (error) {
      this.close();
      this.onExit(error instanceof Error ? error.message : 'Claude could not be stopped.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  reply(id: string | number, result: unknown) {
    const request = this.pending.get(String(id));
    if (!request) throw new Error('This Claude request has already ended.');
    request.resolve(result);
  }

  reject(id: string | number, message: string) {
    this.pending.get(String(id))?.reject(new Error(message));
  }

  close() {
    if (this.stopped) return;
    this.stopped = true;
    const run = this.current;
    if (run) {
      run.interrupted = true;
      run.controller.abort();
      run.query.close();
    }
    this.cancelPending('The runner disconnected.');
    this.turnId = '';
  }

  private emit(event: HarnessEvent) {
    if (!this.stopped) this.onEvent(event);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (this.stopped || signal.aborted) return Promise.reject(new Error('The turn was stopped.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, result?: unknown) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.cleanup();
        this.emit({ method: 'serverRequest/resolved', params: { requestId: id } });
        if (error) reject(error);
        else resolve(result);
      };
      const abort = () => finish(new Error('The request was cancelled.'));
      this.pending.set(id, {
        resolve: (result) => finish(undefined, result),
        reject: (error) => finish(error),
        cleanup: () => signal.removeEventListener('abort', abort),
      });
      signal.addEventListener('abort', abort, { once: true });
      this.emit({ id, method, params: { ...params, callId: id } });
    });
  }

  private cancelPending(message: string) {
    for (const pending of [...this.pending.values()]) pending.reject(new Error(message));
  }

  private canUseTool: CanUseTool = async (name, input, context) => {
    try {
      if (name === 'AskUserQuestion') {
        const parsed = questionSchema.safeParse(input);
        if (!parsed.success)
          return {
            behavior: 'deny',
            message: 'Unsupported question format. Ask 1–4 questions with 2–4 choices each.',
          };
        const questions = parsed.data.questions.map((question, index) => ({
          ...question,
          id: `q${index}`,
          isSecret: false,
        }));
        const response = (await this.request(
          'item/tool/requestUserInput',
          { questions },
          context.signal,
        )) as {
          answers?: Record<string, { answers?: string[] }>;
        };
        const answers: Record<string, string> = {};
        for (const question of questions) {
          const values = response?.answers?.[question.id]?.answers;
          if (
            !Array.isArray(values) ||
            !values.length ||
            values.some((value) => typeof value !== 'string')
          ) {
            return { behavior: 'deny', message: 'The owner did not answer every question.' };
          }
          answers[question.question] = values.join(', ');
        }
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const file =
        typeof input.file_path === 'string'
          ? input.file_path
          : typeof input.notebook_path === 'string'
            ? input.notebook_path
            : '';
      const command =
        name === 'Bash' && typeof input.command === 'string'
          ? input.command.slice(0, 8000)
          : `${name}${file ? ` ${file}` : ''}`;
      const response = (await this.request(
        'item/commandExecution/requestApproval',
        {
          command,
          reason: context.decisionReason || `Claude requests permission to use ${name}.`,
          cwd: this.cwd,
          availableDecisions: ['accept', 'decline'],
        },
        context.signal,
      )) as { decision?: string };
      return response?.decision === 'accept'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'The runner owner declined this action.' };
    } catch {
      return {
        behavior: 'deny',
        message: 'The approval was cancelled or the runner disconnected.',
        interrupt: true,
      };
    }
  };

  private async consume(run: Turn) {
    let failure: string | undefined;
    let receivedResult = false;
    let messageId = '';
    const streamed = new Set<string>();
    const completeText = new Map<string, string>();
    const seen = new Set<string>();
    const commands = new Map<string, string>();
    try {
      for await (const message of run.query) {
        if (this.stopped || this.current !== run || run.interrupted) break;
        if ('session_id' in message && message.session_id) {
          this.threadId = message.session_id;
          this.sessionStarted = true;
        }
        if (message.type === 'stream_event') {
          const event = message.event;
          if (event.type === 'message_start') messageId = event.message.id;
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const itemId = `${run.id}:${messageId || 'text'}`;
            streamed.add(messageId);
            this.emit({
              method: 'item/agentMessage/delta',
              params: { itemId, delta: event.delta.text },
            });
          }
          // Thinking, signatures and tool input fragments are deliberately omitted.
        } else if (message.type === 'assistant') {
          if (seen.has(message.uuid)) continue;
          seen.add(message.uuid);
          for (const block of message.message.content) {
            if (block.type === 'text' && !streamed.has(message.message.id)) {
              const itemId = `${run.id}:${message.message.id}`;
              const text = (completeText.get(itemId) || '') + block.text;
              completeText.set(itemId, text);
              this.emit({
                method: 'item/completed',
                params: { item: { id: itemId, type: 'agentMessage', text } },
              });
            } else if (block.type === 'tool_use') {
              const input = block.input as Record<string, unknown>;
              const command =
                block.name === 'Bash' && typeof input?.command === 'string'
                  ? input.command.slice(0, 8000)
                  : `${block.name}${typeof input?.file_path === 'string' ? ` ${input.file_path}` : ''}`;
              commands.set(block.id, command);
              this.emit({
                method: 'item/started',
                params: { item: { id: block.id, type: 'commandExecution', command } },
              });
            }
          }
        } else if (message.type === 'user' && Array.isArray(message.message.content)) {
          for (const block of message.message.content) {
            if (block.type !== 'tool_result') continue;
            const command = commands.get(block.tool_use_id);
            if (!command) continue;
            // Tool result bodies may contain file contents or credentials. Share
            // completion, and expose actual file edits through the bounded Git diff.
            this.emit({
              method: 'item/completed',
              params: {
                item: {
                  id: block.tool_use_id,
                  type: 'commandExecution',
                  command,
                  aggregatedOutput: block.is_error ? 'Tool reported an error.' : 'Completed.',
                },
              },
            });
          }
        } else if (message.type === 'result') {
          receivedResult = true;
          if (message.is_error || message.subtype !== 'success') {
            failure =
              'errors' in message
                ? message.errors.join('\n').slice(0, 3000)
                : 'Claude reported an error.';
          }
        }
      }
      if (!receivedResult && !run.interrupted && !this.stopped)
        failure = 'Claude disconnected before completing the turn.';
    } catch (error) {
      if (!run.interrupted && !this.stopped)
        failure ||= error instanceof Error ? error.message : 'Claude disconnected.';
    } finally {
      run.query.close();
      if (this.current === run) {
        this.cancelPending('The turn has ended.');
        this.current = undefined;
        this.turnId = '';
        this.emit({
          method: 'turn/completed',
          params: {
            turn: {
              id: run.id,
              status: run.interrupted ? 'interrupted' : failure ? 'failed' : 'completed',
              ...(failure ? { error: { message: failure } } : {}),
            },
          },
        });
      }
    }
  }
}
