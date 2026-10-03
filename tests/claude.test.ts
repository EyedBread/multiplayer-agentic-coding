import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import {
  createSdkMcpServer,
  type Options,
  type SDKMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeClient } from '../runner/claude.js';
import type { HarnessEvent } from '../shared/runner.js';

class FakeQuery implements AsyncIterable<SDKMessage> {
  closed = false;
  private values: SDKMessage[] = [];
  private waiting?: (result: IteratorResult<SDKMessage>) => void;
  push(message: object) {
    const value = message as SDKMessage;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
    } else this.values.push(value);
  }
  close() {
    this.closed = true;
    this.waiting?.({ done: true, value: undefined });
    this.waiting = undefined;
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
function fixture(model?: string) {
  const events: HarnessEvent[] = [];
  const queries: FakeQuery[] = [];
  const inputs: { prompt: string; options: Options }[] = [];
  const tools: SdkMcpToolDefinition[] = [];
  const exits: string[] = [];
  const client = new ClaudeClient(
    '/local/isolated-worktree',
    (event) => events.push(event),
    (error) => exits.push(error),
    {
      env: { ANTHROPIC_API_KEY: 'test-key-local-only', CLAUDE_MODEL: 'fixture-default' },
      query: (input) => {
        inputs.push(input);
        const query = new FakeQuery();
        queries.push(query);
        return query;
      },
      createServer: (options) => {
        tools.push(...(options.tools ?? []));
        return createSdkMcpServer(options);
      },
    },
    model,
  );
  return { client, events, queries, inputs, tools, exits };
}
const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 'local-session',
};
const permissionContext = () => ({
  signal: new AbortController().signal,
  toolUseID: 'tool',
  requestId: 'permission',
});

test('Claude keeps credentials local, resumes the exact session, and shares only public text and tool summaries', async () => {
  const f = fixture();
  await f.client.init();
  const firstId = await f.client.prompt('Implement the feature');
  assert.equal(f.client.turnId, firstId);
  assert.equal(f.inputs[0].options.cwd, '/local/isolated-worktree');
  assert.equal(f.inputs[0].options.model, 'fixture-default');
  assert.equal(f.inputs[0].options.permissionMode, 'default');
  assert.deepEqual(f.inputs[0].options.allowedTools, ['mcp__multiplayer__team_decision']);
  assert.deepEqual(f.inputs[0].options.settingSources, []);
  assert.deepEqual(f.inputs[0].options.disallowedTools, ['Agent', 'Task']);
  assert.equal(f.inputs[0].options.resume, undefined);
  assert.equal(f.inputs[0].options.env?.ANTHROPIC_API_KEY, 'test-key-local-only');
  assert.equal(await f.client.steer('new decision'), false);
  await assert.rejects(f.client.prompt('Concurrent turn'), /already working/);
  const q = f.queries[0];
  q.push({ type: 'system', subtype: 'init', session_id: 'local-session' });
  q.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'message-1' } } });
  q.push({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'thinking_delta', thinking: 'PRIVATE_THINKING' },
    },
  });
  q.push({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Public progress' } },
  });
  q.push({
    type: 'assistant',
    uuid: 'assistant-1',
    message: {
      id: 'message-1',
      content: [
        { type: 'text', text: 'Public progress' },
        { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      ],
    },
  });
  q.push({
    type: 'assistant',
    uuid: 'assistant-2',
    message: {
      id: 'message-2',
      content: [
        { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'source.ts' } },
      ],
    },
  });
  q.push({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'PRIVATE_FILE_CONTENT' }],
    },
  });
  q.push(success);
  q.close();
  await setImmediate();
  const serialized = JSON.stringify(f.events);
  assert.ok(serialized.includes('Public progress'));
  assert.ok(serialized.includes('Read source.ts'));
  assert.ok(!serialized.includes('PRIVATE_THINKING'));
  assert.ok(!serialized.includes('PRIVATE_FILE_CONTENT'));
  assert.ok(!serialized.includes('test-key-local-only'));
  assert.equal(f.events.filter((event) => event.method === 'item/agentMessage/delta').length, 1);
  assert.equal(
    f.events.filter((event) => event.params?.item?.type === 'agentMessage').length,
    0,
    'streamed text is not duplicated by complete messages',
  );
  assert.equal(f.events.at(-1)?.params.turn.status, 'completed');
  assert.equal(f.client.turnId, '');
  await f.client.prompt('Continue the same feature');
  assert.equal(f.inputs[1].options.resume, 'local-session');
  assert.equal(f.inputs[1].options.sessionId, undefined);
  f.client.close();
  await setImmediate();
});

test('Claude keeps the per-agent model on subsequent prompts instead of the runner default', async () => {
  const f = fixture('fixture-selected');
  try {
    await f.client.init();
    await f.client.prompt('First task');
    assert.equal(f.inputs[0].options.model, 'fixture-selected');
    f.queries[0].push(success);
    f.queries[0].close();
    await setImmediate();
    await f.client.prompt('Continue');
    assert.equal(f.inputs[1].options.model, 'fixture-selected');
    assert.equal(f.inputs[1].options.resume, 'local-session');
  } finally {
    f.client.close();
  }
});

test('Claude approvals wait for an explicit owner reply and do not install persistent grants', async () => {
  const f = fixture();
  await f.client.init();
  await f.client.prompt('Run the build');
  const approval = f.inputs[0].options.canUseTool!(
    'Bash',
    { command: 'npm run build' },
    permissionContext(),
  );
  let resolved = false;
  void approval.then(() => {
    resolved = true;
  });
  await setImmediate();
  assert.equal(resolved, false);
  const request = f.events.find(
    (event) => event.method === 'item/commandExecution/requestApproval',
  )!;
  assert.equal(request.params.command, 'npm run build');
  f.client.reply(request.id!, { decision: 'decline' });
  assert.equal((await approval)?.behavior, 'deny');
  const allowed = f.inputs[0].options.canUseTool!(
    'Write',
    { file_path: 'source.ts', content: 'new code' },
    permissionContext(),
  );
  const second = f.events
    .filter((event) => event.method === 'item/commandExecution/requestApproval')
    .at(-1)!;
  f.client.reply(second.id!, { decision: 'accept' });
  assert.deepEqual(await allowed, {
    behavior: 'allow',
    updatedInput: { file_path: 'source.ts', content: 'new code' },
  });
  assert.throws(() => f.client.reply(second.id!, { decision: 'accept' }), /already ended/);
  f.client.close();
});

test('Claude AskUserQuestion maps owner answers back to the SDK and rejects malformed questions', async () => {
  const f = fixture();
  await f.client.init();
  await f.client.prompt('Clarify the task');
  const input = {
    questions: [
      {
        question: 'Which test style?',
        header: 'Testing',
        options: [{ label: 'Typed' }, { label: 'Snapshot' }],
      },
      {
        question: 'Which output?',
        header: 'Output',
        options: [{ label: 'Short' }, { label: 'Long' }],
      },
    ],
  };
  const answer = f.inputs[0].options.canUseTool!('AskUserQuestion', input, permissionContext());
  const request = f.events.find((event) => event.method === 'item/tool/requestUserInput')!;
  assert.deepEqual(
    request.params.questions.map((question: { id: string }) => question.id),
    ['q0', 'q1'],
  );
  f.client.reply(request.id!, {
    answers: { q0: { answers: ['Typed'] }, q1: { answers: ['Long'] } },
  });
  assert.deepEqual(await answer, {
    behavior: 'allow',
    updatedInput: { ...input, answers: { 'Which test style?': 'Typed', 'Which output?': 'Long' } },
  });
  assert.equal(
    (
      await f.inputs[0].options.canUseTool!(
        'AskUserQuestion',
        { questions: [] },
        permissionContext(),
      )
    )?.behavior,
    'deny',
  );
  f.client.close();
});

test('the Claude team tool stays blocked until a shared decision is delivered', async () => {
  const f = fixture();
  await f.client.init();
  await f.client.prompt('Pick a shared contract');
  const decision = f.tools[0].handler(
    {
      question: 'Which event contract?',
      context: 'Both sessions need it.',
      options: ['Typed', 'Snapshot'],
    },
    {},
  );
  let resolved = false;
  void decision.then(() => {
    resolved = true;
  });
  await setImmediate();
  assert.equal(resolved, false);
  const request = f.events.find((event) => event.method === 'item/tool/call')!;
  assert.equal(request.params.tool, 'team_decision');
  f.client.reply(request.id!, {
    success: true,
    contentItems: [{ type: 'inputText', text: 'Typed' }],
  });
  assert.deepEqual(await decision, { content: [{ type: 'text', text: 'Typed' }] });
  assert.ok(
    f.events.some(
      (event) => event.method === 'serverRequest/resolved' && event.params.requestId === request.id,
    ),
  );
  f.client.close();
});

test('interrupt cancels outstanding tool and permission requests before allowing another turn', async () => {
  const f = fixture();
  await f.client.init();
  await f.client.prompt('Working');
  const permission = f.inputs[0].options.canUseTool!(
    'Bash',
    { command: 'npm test' },
    permissionContext(),
  );
  const decision = f.tools[0].handler(
    { question: 'Use types?', context: 'A shared choice.', options: ['Yes', 'No'] },
    {},
  );
  await f.client.interrupt();
  assert.equal((await permission)?.behavior, 'deny');
  assert.equal((await decision).isError, true);
  assert.equal(f.queries[0].closed, true);
  assert.equal(f.inputs[0].options.abortController?.signal.aborted, true);
  assert.equal(f.client.turnId, '');
  assert.equal(f.events.at(-1)?.params.turn.status, 'interrupted');
  await f.client.prompt('A separate turn');
  assert.equal(f.queries.length, 2);
  f.client.close();
  await setImmediate();
  await assert.rejects(f.client.prompt('Late prompt'), /not connected/);
  assert.deepEqual(f.exits, []);
});

test('Claude reports failed provider results and lets the SDK resolve local login or API credentials', async () => {
  const nativeLogin = new ClaudeClient(
    '/tmp',
    () => {},
    () => {},
    { env: {} },
  );
  assert.ok(
    await nativeLogin.init(),
    'A native CLI login does not require an API key environment variable.',
  );
  nativeLogin.close();
  const f = fixture();
  await f.client.init();
  await f.client.prompt('Work');
  f.queries[0].push({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Provider rejected the request.'],
    session_id: 'local-session',
  });
  f.queries[0].close();
  await setImmediate();
  assert.equal(f.events.at(-1)?.params.turn.status, 'failed');
  assert.equal(f.events.at(-1)?.params.turn.error.message, 'Provider rejected the request.');
  f.client.close();
});
