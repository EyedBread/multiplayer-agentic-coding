import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { HostProject } from '../shared/types.js';
import { git, repoInfo } from './git.js';

// Paths remain server-side; remote clients select only host-registered IDs.
export class ProjectRegistry {
  private projects = new Map<string, string>();
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private defaultPath: string,
    private stateDir: string,
  ) {
    this.projects.set('default', defaultPath);
  }

  async load() {
    try {
      const saved: unknown = JSON.parse(
        await readFile(path.join(this.stateDir, 'projects.json'), 'utf8'),
      );
      if (!Array.isArray(saved)) throw new Error('Invalid saved project list.');
      for (const item of saved) {
        if (
          !item ||
          typeof item.id !== 'string' ||
          item.id === 'default' ||
          typeof item.path !== 'string' ||
          !path.isAbsolute(item.path)
        )
          throw new Error('Invalid saved project.');
        this.projects.set(item.id, item.path);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  resolve(id: unknown) {
    const root = typeof id === 'string' ? this.projects.get(id) : undefined;
    if (!root) throw new Error('Select a project registered on the host.');
    return root;
  }

  async list(includePaths: boolean): Promise<HostProject[]> {
    return Promise.all(
      [...this.projects].map(async ([id, root]) => {
        try {
          const info = await repoInfo(root);
          await git(root, 'rev-parse', '--verify', 'HEAD');
          return {
            id,
            name: info.name,
            path: includePaths ? root : '',
            branch: info.branch,
            dirty: info.dirty,
          };
        } catch {
          return {
            id,
            name: path.basename(root),
            path: includePaths ? root : '',
            branch: '',
            dirty: false,
            error: 'Repository unavailable or has no commits.',
          };
        }
      }),
    );
  }

  async add(input: unknown) {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096)
      throw new Error('Enter a Git repository folder on the host.');
    const expanded = input.trim().replace(/^~(?=\/)/, homedir());
    if (!path.isAbsolute(expanded))
      throw new Error('Use an absolute path to a Git repository on the host.');
    let root: string;
    try {
      root = await realpath((await repoInfo(expanded)).root);
      await git(root, 'rev-parse', '--verify', 'HEAD');
    } catch {
      throw new Error('Choose an existing Git repository with at least one commit.');
    }
    // Serialize additions so duplicate clicks and concurrent saves cannot lose entries.
    let id = '';
    const save = this.saving.then(async () => {
      for (const [existingId, existingPath] of this.projects) {
        const canonical = await realpath(existingPath).catch(() => existingPath);
        if (canonical === root) {
          id = existingId;
          return;
        }
      }
      if (this.projects.size >= 50)
        throw new Error('The host supports up to 50 registered projects.');
      id = randomUUID();
      const entries = [...this.projects]
        .filter(([key]) => key !== 'default')
        .map(([key, value]) => ({ id: key, path: value }));
      entries.push({ id, path: root });
      await mkdir(this.stateDir, { recursive: true });
      const temporary = path.join(this.stateDir, `projects-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(entries), { mode: 0o600 });
      await rename(temporary, path.join(this.stateDir, 'projects.json'));
      this.projects.set(id, root);
    });
    this.saving = save.catch(() => {});
    await save;
    return id;
  }

  worktreeRoot(id: string) {
    return id === 'default' ? undefined : path.join(this.stateDir, 'worktrees');
  }
}
