import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, fileDiff, git } from '../server/git.js';

test('Git tracking includes committed, staged, unstaged, deleted and new files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'multiplayer-git-test-'));
  try {
    await git(dir, 'init', '-b', 'main');
    for (const name of ['committed.txt', 'staged.txt', 'unstaged.txt', 'deleted.txt'])
      await writeFile(path.join(dir, name), 'before\n');
    await git(dir, 'add', '.');
    await git(
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'fixture',
    );
    const base = (await git(dir, 'rev-parse', 'HEAD')).trim();
    await writeFile(path.join(dir, 'committed.txt'), 'committed change\n');
    await git(dir, 'add', 'committed.txt');
    await git(
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'change',
    );
    await writeFile(path.join(dir, 'staged.txt'), 'staged change\n');
    await git(dir, 'add', 'staged.txt');
    await writeFile(path.join(dir, 'unstaged.txt'), 'unstaged change\n');
    await rm(path.join(dir, 'deleted.txt'));
    await writeFile(path.join(dir, 'new file.txt'), 'new content\n');
    assert.deepEqual(await changedFiles(dir, base), [
      'committed.txt',
      'deleted.txt',
      'new file.txt',
      'staged.txt',
      'unstaged.txt',
    ]);
    assert.match(await fileDiff(dir, base, 'committed.txt'), /\+committed change/);
    assert.match(await fileDiff(dir, base, 'new file.txt'), /\+new content/);
    await assert.rejects(fileDiff(dir, base, '../outside.txt'), /not in the agent/);
    await symlink('/etc/hosts', path.join(dir, 'outside-link'));
    await assert.rejects(fileDiff(dir, base, 'outside-link'), /outside the worktree/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
