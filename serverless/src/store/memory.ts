import type { Store } from "./types.ts";

export interface MemoryStoreHooks {
  /** Awaited after a get resolves, before returning: lets tests interleave visits. */
  afterGet?: (key: string) => Promise<void>;
  /** Awaited before a putIfAbsent applies. */
  beforePut?: (key: string) => Promise<void>;
}

/** In-memory store for tests and local development. */
export class MemoryStore implements Store {
  readonly data = new Map<string, string>();
  puts = 0;
  hooks: MemoryStoreHooks;

  constructor(hooks: MemoryStoreHooks = {}) {
    this.hooks = hooks;
  }

  async get(key: string): Promise<string | null> {
    const v = this.data.get(key);
    await this.hooks.afterGet?.(key);
    const trimmed = v?.trim();
    return trimmed ? trimmed : null;
  }

  async putIfAbsent(key: string, value: string): Promise<boolean> {
    await this.hooks.beforePut?.(key);
    this.puts++;
    if (this.data.has(key)) return false;
    this.data.set(key, value);
    return true;
  }
}
