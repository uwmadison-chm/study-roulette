import type { Entry, Store } from "./types.ts";

export interface MemoryStoreHooks {
  /** Awaited after a get resolves, before returning: lets tests interleave visits. */
  afterGet?: (key: string) => Promise<void>;
  /** Awaited before a putIfAbsent applies. */
  beforePut?: (key: string) => Promise<void>;
}

/**
 * In-memory store for tests and local development. Entries without an
 * explicit creation time get a strictly increasing one, so creation order is
 * unambiguous even within a millisecond.
 */
export class MemoryStore implements Store {
  readonly data = new Map<string, string>();
  readonly created = new Map<string, number>();
  puts = 0;
  hooks: MemoryStoreHooks;
  private clock = 0;

  constructor(hooks: MemoryStoreHooks = {}) {
    this.hooks = hooks;
  }

  async get(key: string): Promise<Entry | null> {
    const v = this.data.get(key);
    const created = this.created.get(key);
    await this.hooks.afterGet?.(key);
    const value = v?.trim();
    if (!value) return null;
    return created === undefined ? { value } : { value, created };
  }

  async putIfAbsent(key: string, value: string, created?: number): Promise<boolean> {
    await this.hooks.beforePut?.(key);
    this.puts++;
    if (this.data.has(key)) return false;
    this.data.set(key, value);
    this.created.set(key, created ?? ++this.clock);
    return true;
  }
}
