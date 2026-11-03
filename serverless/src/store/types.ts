/**
 * The whole storage contract. Mappings are write-once, so a store only needs
 * reads and an atomic create-if-absent.
 */
export interface Store {
  /** The stored value with surrounding whitespace trimmed, or null if absent or empty. */
  get(key: string): Promise<string | null>;
  /** Create key with value if it does not exist. True if we created it, false if it already existed. */
  putIfAbsent(key: string, value: string): Promise<boolean>;
}
