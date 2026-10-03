import test from 'node:test';
import assert from 'node:assert/strict';
import { codexInvocation } from '../server/codex.js';

test('Codex launches the npm JavaScript entrypoint through Node without a Windows shell shim', () => {
  const binary = 'C:\\Program Files\\Multiplayer\\node_modules\\@openai\\codex\\bin\\codex.js';
  assert.deepEqual(codexInvocation(['app-server', '--listen', 'stdio://'], binary), {
    command: process.execPath,
    args: [binary, 'app-server', '--listen', 'stdio://'],
  });
  assert.deepEqual(codexInvocation(['--version'], '/usr/local/bin/codex'), {
    command: '/usr/local/bin/codex',
    args: ['--version'],
  });
});
