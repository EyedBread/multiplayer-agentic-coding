#!/usr/bin/env node
// Deterministic protocol fixture. This never calls a model or reads credentials.
import { createInterface } from 'node:readline';
import { writeFileSync, appendFileSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let serial = 0;
let turn = '';
const requests = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { userAgent: 'fixture' } });
  if (message.method === 'model/list')
    send({
      id: message.id,
      result: {
        data: [
          { model: 'fixture-fast', displayName: 'Fixture Fast' },
          { model: 'fixture-deep', displayName: 'Fixture Deep' },
        ],
        nextCursor: null,
      },
    });
  if (message.method === 'thread/start') {
    if (message.params.model) writeFileSync('selected-model.txt', message.params.model);
    if (message.params.dynamicTools[0].type !== 'function')
      throw new Error('Wrong dynamic tool schema');
    send({ id: message.id, result: { thread: { id: 'thread-test' } } });
  }
  if (message.method === 'turn/start') {
    turn = `turn-${++serial}`;
    const prompt = message.params.input[0].text;
    send({ id: message.id, result: { turn: { id: turn } } });
    send({ method: 'turn/started', params: { turn: { id: turn } } });
    writeFileSync('shared.ts', 'export const eventType = "typed";\n');
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: `message-${serial}`, delta: 'Connected. ' },
    });
    send({
      method: 'item/agentMessage/delta',
      params: { itemId: `message-${serial}`, delta: 'Checking the shared contract.' },
    });
    const id = `request-${serial}`;
    requests.set(id, turn);
    if (prompt.includes('ASK_OWNER'))
      send({
        id,
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'q1',
              question: 'Which shared format?',
              header: 'Format',
              options: [{ label: 'Typed' }, { label: 'Snapshot' }],
            },
          ],
          threadId: 'thread-test',
          turnId: turn,
        },
      });
    else if (prompt.includes('ASK_APPROVAL'))
      send({
        id,
        method: 'item/commandExecution/requestApproval',
        params: {
          command: 'echo test',
          reason: 'Protocol approval test',
          availableDecisions: ['accept', 'decline'],
        },
      });
    else if (prompt.includes('ASK_TEAM'))
      send({
        id,
        method: 'item/tool/call',
        params: {
          tool: 'team_decision',
          arguments: {
            question: 'Which event format?',
            context: 'Shared contract',
            options: ['Typed', 'Snapshot'],
          },
        },
      });
    else {
      requests.delete(id);
      send({ method: 'turn/completed', params: { turn: { id: turn, status: 'completed' } } });
    }
  }
  if (message.method === 'turn/steer') send({ id: message.id, result: {} });
  if (message.method === 'turn/interrupt') {
    requests.clear();
    send({ id: message.id, result: {} });
    send({ method: 'turn/completed', params: { turn: { id: turn, status: 'interrupted' } } });
  }
  if (!message.method && requests.has(message.id)) {
    appendFileSync('answers.jsonl', JSON.stringify(message.result) + '\n');
    const finished = requests.get(message.id);
    requests.delete(message.id);
    send({ method: 'serverRequest/resolved', params: { requestId: message.id } });
    send({ method: 'turn/completed', params: { turn: { id: finished, status: 'completed' } } });
  }
});
