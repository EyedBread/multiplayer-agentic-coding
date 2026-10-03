import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CodexClient, codexModels } from '../server/codex.js';
import { modelChoices, modelSelection } from '../shared/models.js';

test('model selections validate IDs and model catalogs expose only bounded public fields', () => {
  assert.equal(modelSelection(''), undefined);
  assert.equal(modelSelection(undefined), undefined);
  assert.equal(modelSelection('opus[1m]'), 'opus[1m]');
  assert.equal(modelSelection('provider/model-v2'), 'provider/model-v2');
  for (const value of [null, {}, 'x'.repeat(161), 'model with spaces', '--flag', 'model\nsecret'])
    assert.throws(() => modelSelection(value));
  assert.deepEqual(
    modelChoices([
      { id: 'valid', name: 'Valid', token: 'private' },
      { id: 'valid', name: 'Valid', config: { secret: 'private' } },
      { id: 'bad model', name: 'Bad' },
      { id: 'empty', name: '' },
    ]),
    [{ id: 'valid', name: 'Valid' }],
  );
});

test('Codex discovers models without a turn and each agent gets its selected model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-models-'));
  const binary = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
  const clients: CodexClient[] = [];
  try {
    assert.deepEqual(await codexModels(root, binary), [
      { id: 'fixture-fast', name: 'Fixture Fast' },
      { id: 'fixture-deep', name: 'Fixture Deep' },
    ]);
    assert.deepEqual(
      await readdir(root),
      [],
      'Discovery does not create a thread or submit a task',
    );
    for (const model of ['fixture-fast', 'fixture-deep']) {
      const client = new CodexClient(
        root,
        () => {},
        () => {},
        binary,
        model,
      );
      clients.push(client);
      await client.init();
      assert.equal(await readFile(path.join(root, 'selected-model.txt'), 'utf8'), model);
      client.close();
    }
  } finally {
    clients.forEach((client) => client.close());
    await rm(root, { recursive: true, force: true });
  }
});
