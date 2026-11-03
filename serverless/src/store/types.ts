export interface Entry {
  /** The stored value with surrounding whitespace trimmed. */
  value: string;
  /**
   * When the entry was created, in ms since the epoch, if the store knows.
   * Used to prefer the oldest mapping when several match one visit.
   */
  created?: number;
}

/**
 * The whole storage contract. Mappings are write-once, so a store only needs
 * reads and an atomic create-if-absent.
 */
export interface Store {
  /** The entry, or null if absent or empty. */
  get(key: string): Promise<Entry | null>;
  /**
   * Create key with value if it does not exist; `created` (ms since the
   * epoch, default now) is recorded with it. True if we created it, false if
   * it already existed.
   */
  putIfAbsent(key: string, value: string, created?: number): Promise<boolean>;
}
