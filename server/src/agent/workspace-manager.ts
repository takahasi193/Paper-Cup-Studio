import path from 'node:path';
import fs from 'node:fs';
import { config, resolvePapercupConfigDir } from '../config.js';

export interface WorkspaceRegistry {
  active: string;
  recent: string[];
}

export interface WorkspaceManagerOptions {
  configDir?: string;
  persist?: boolean;
  initialWorkspace?: string;
}

function sameWorkspacePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function dedupeExistingDirs(paths: string[]): { valid: string[]; hadInvalidOrDup: boolean } {
  const valid: string[] = [];
  let hadInvalidOrDup = false;
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) {
      hadInvalidOrDup = true;
      continue;
    }
    const resolved = path.resolve(raw);
    let existsDir = false;
    try {
      existsDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory();
    } catch {
      existsDir = false;
    }
    if (!existsDir) {
      hadInvalidOrDup = true;
      continue;
    }
    if (valid.some((existing) => sameWorkspacePath(existing, resolved))) {
      hadInvalidOrDup = true;
      continue;
    }
    valid.push(resolved);
  }
  return { valid, hadInvalidOrDup };
}

export class WorkspaceManager {
  private configDir: string;
  private filePath: string;
  private persist: boolean;
  private registry: WorkspaceRegistry;

  constructor(options?: WorkspaceManagerOptions) {
    this.configDir = options?.configDir || resolvePapercupConfigDir();
    this.filePath = path.join(this.configDir, 'workspaces.json');
    this.persist = options?.persist ?? true;
    this.registry = this.load(options?.initialWorkspace);
  }

  private load(initialWorkspace?: string): WorkspaceRegistry {
    const current = path.resolve(initialWorkspace || config.defaultWorkspace);

    if (!this.persist && initialWorkspace) {
      return {
        active: current,
        recent: [current],
      };
    }

    // 1. ~/.papercup/workspaces.json の読み込みと検証
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        if (data && typeof data.active === 'string') {
          const resolvedActive = path.resolve(data.active);
          const rawRecent = Array.isArray(data.recent) ? data.recent : [data.active];
          const { valid: validRecent, hadInvalidOrDup } = dedupeExistingDirs(rawRecent);

          let activeValid = false;
          try {
            activeValid = fs.existsSync(resolvedActive) && fs.statSync(resolvedActive).isDirectory();
          } catch {
            activeValid = false;
          }

          if (activeValid) {
            const recent = validRecent.some((p) => sameWorkspacePath(p, resolvedActive))
              ? validRecent
              : [resolvedActive, ...validRecent];
            const reg = { active: resolvedActive, recent };
            if (hadInvalidOrDup && this.persist) {
              this.registry = reg;
              this.save();
            }
            return reg;
          } else if (validRecent.length > 0) {
            const reg = { active: validRecent[0], recent: validRecent };
            if (this.persist) {
              this.registry = reg;
              this.save();
            }
            return reg;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to read workspaces.json:', e);
    }

    // 2. 有効なカレントワーキングディレクトリへのフォールバック
    return {
      active: current,
      recent: [current],
    };
  }

  save(): void {
    if (!this.persist) {
      return;
    }
    try {
      if (!fs.existsSync(this.configDir)) {
        fs.mkdirSync(this.configDir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.registry, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save workspaces.json:', e);
    }
  }

  getRegistry(): WorkspaceRegistry {
    return {
      active: this.registry.active,
      recent: [...this.registry.recent],
    };
  }

  switchWorkspace(targetPath: string): string {
    const resolved = path.resolve(targetPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Directory does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${resolved}`);
    }

    this.registry.active = resolved;
    this.registry.recent = [
      resolved,
      ...this.registry.recent.filter((p) => !sameWorkspacePath(p, resolved)),
    ];
    this.save();
    return resolved;
  }

  removeWorkspace(targetPath: string): void {
    const resolved = path.resolve(targetPath);
    this.registry.recent = this.registry.recent.filter((p) => !sameWorkspacePath(p, resolved));
    if (sameWorkspacePath(this.registry.active, resolved)) {
      this.registry.active = this.registry.recent[0] || path.resolve(config.defaultWorkspace);
    }
    this.save();
  }
}
