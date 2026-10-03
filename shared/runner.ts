export type Harness = 'codex' | 'claude';
export type RunnerProject = {
  remoteUrl: string | null;
  identity: string | null;
  baseCommit: string;
};
export type Runner = {
  id: string;
  ownerId: string;
  name: string;
  harness: Harness;
  status: 'connecting' | 'online' | 'offline';
};
// Both adapters publish this small public event vocabulary. No provider credentials cross it.
export type HarnessEvent = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
};
export interface HarnessClient {
  turnId: string;
  init(): Promise<string>;
  prompt(text: string): Promise<string>;
  steer(text: string): Promise<boolean>;
  interrupt(): Promise<void>;
  reply(id: string | number, result: unknown): void | Promise<void>;
  reject(id: string | number, message: string): void | Promise<void>;
  close(): void;
}
export type RunnerBootstrap = {
  token: string;
  runner: Runner;
  roomId: string;
  project: RunnerProject;
};
export type RunnerRequest = {
  type: 'request';
  id: string;
  method: 'start' | 'prompt' | 'steer' | 'interrupt' | 'reply' | 'reject' | 'diff' | 'close';
  agentId: string;
  params: any;
};
export type RunnerMessage =
  | { type: 'ready'; protocol: 1; baseCommit: string; identity: string | null }
  | { type: 'result'; id: string; result?: any; error?: string }
  | { type: 'event'; agentId: string; event: HarnessEvent }
  | { type: 'files'; agentId: string; files: string[] }
  | { type: 'agent-error'; agentId: string; error: string };

/** Accept only ordinary Git network transports and omit credentials from room metadata. */
export function repositoryRemote(raw: string): { remoteUrl: string; identity: string } | null {
  const value = raw.trim();
  if (!value || /[\s\x00-\x1f]/.test(value)) return null;
  let url: URL;
  try {
    const scp = /^(?:([a-zA-Z0-9._-]+)@)?([a-zA-Z0-9.-]+):([^/].*)$/.exec(value);
    url = new URL(
      scp && !value.includes('://') ? `ssh://${scp[1] || 'git'}@${scp[2]}/${scp[3]}` : value,
    );
  } catch {
    return null;
  }
  if (!['https:', 'ssh:'].includes(url.protocol) || !url.hostname || url.search || url.hash)
    return null;
  if (url.protocol === 'https:') {
    url.username = '';
    url.password = '';
  } else if (url.password || (url.username && !/^[a-zA-Z0-9._-]+$/.test(url.username))) return null;
  const pathname = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!pathname || pathname.split('/').some((part) => part === '.' || part === '..')) return null;
  const port = url.port && !['22', '443'].includes(url.port) ? `:${url.port}` : '';
  return {
    remoteUrl: url.toString(),
    identity: `${url.hostname.toLowerCase()}${port}/${pathname}`,
  };
}
