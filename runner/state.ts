import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RunnerBootstrap } from '../shared/runner.js';

export type RunnerState = RunnerBootstrap & {
  version: 1;
  server: string;
  repo?: string;
  clone?: string;
};
export function normalizeServer(raw: string) {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Use the room server’s HTTP or HTTPS URL without credentials, query parameters, or fragments.',
    );
  if (url.pathname !== '/') throw new Error('Use the server origin, without a page path.');
  return url.origin;
}
export function defaultStatePath(state: RunnerBootstrap) {
  if (![state.roomId, state.runner.id].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)))
    throw new Error('Invalid runner identity.');
  return path.join(homedir(), '.multiplayer', 'runners', `${state.roomId}-${state.runner.id}.json`);
}
export async function saveState(file: string, state: RunnerState) {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error('The runner state path must be a regular file, not a symlink.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function loadState(file: string): Promise<RunnerState> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Runner state must be a regular file, not a symlink.');
  let state: RunnerState;
  try {
    state = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    throw new Error('Runner state is not valid JSON. Pair again using a new state file.');
  }
  if (
    state?.version !== 1 ||
    !state.token ||
    !state.roomId ||
    !state.runner?.id ||
    !['codex', 'claude'].includes(state.runner.harness) ||
    !state.project?.baseCommit ||
    !(state.repo || state.clone)
  )
    throw new Error('Runner state is incomplete. Pair again using a new state file.');
  state.server = normalizeServer(state.server);
  return state;
}
