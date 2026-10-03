export type HarnessModel = { id: string; name: string };

export function modelSelection(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,159}$/.test(value))
    throw new Error('Enter a model ID of at most 160 characters, without spaces.');
  return value;
}

/** Only public model IDs and labels cross the harness boundary. */
export function modelChoices(value: unknown): HarnessModel[] {
  if (!Array.isArray(value)) throw new Error('The harness did not return a model list.');
  const choices = new Map<string, HarnessModel>();
  for (const item of value.slice(0, 200)) {
    try {
      const id = modelSelection(item?.id);
      if (id && typeof item.name === 'string' && item.name.trim())
        choices.set(id, { id, name: item.name.slice(0, 160) });
    } catch {
      /* Ignore invalid catalog entries. */
    }
  }
  return [...choices.values()];
}

export async function modelDiscovery<T>(read: () => Promise<T>, close: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Model discovery timed out.')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    close();
  }
}
