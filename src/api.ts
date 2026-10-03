import type { Session } from '../shared/types';
export async function api<T>(url: string, session: Session | null, data?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}
