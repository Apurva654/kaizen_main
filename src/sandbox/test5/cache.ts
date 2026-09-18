export class CacheEntry<V> {
  public key: string;
  public value: V;
  public expiresAt: number;
  public prev: CacheEntry<V> | null = null;
  public next: CacheEntry<V> | null = null;

  constructor(key: string, value: V, ttlMs: number) {
    this.key = key;
    this.value = value;
    this.expiresAt = Date.now() + ttlMs;
  }
}

export class HybridLRUCache<V = string> {
  private map: Map<string, CacheEntry<V>> = new Map();
  private head: CacheEntry<V> | null = null;
  private tail: CacheEntry<V> | null = null;
  public readonly capacity: number = 500;
  public invalidationsCount: number = 0;
  public hits: number = 0;
  public misses: number = 0;

  constructor(capacity: number = 500) {
    this.capacity = capacity;
  }

  public get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() >= entry.expiresAt) {
      this.invalidate(key);
      this.misses++;
      return undefined;
    }
    this.moveToHead(entry);
    this.hits++;
    return entry.value;
  }

  public set(key: string, value: V, ttlMs: number = 60000): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      existing.expiresAt = Date.now() + ttlMs;
      this.moveToHead(existing);
      return;
    }
    if (this.map.size >= this.capacity) {
      this.evictTail();
    }
    const newEntry = new CacheEntry(key, value, ttlMs);
    this.map.set(key, newEntry);
    this.addToHead(newEntry);
  }

  public invalidate(key: string): boolean {
    const entry = this.map.get(key);
    if (entry) {
      this.removeEntry(entry);
      this.map.delete(key);
      this.invalidationsCount++;
      return true;
    }
    return false;
  }

  private addToHead(entry: CacheEntry<V>): void {
    entry.prev = null;
    entry.next = this.head;
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;
  }

  private removeEntry(entry: CacheEntry<V>): void {
    if (entry.prev) entry.prev.next = entry.next;
    else this.head = entry.next;

    if (entry.next) entry.next.prev = entry.prev;
    else this.tail = entry.prev;
  }

  private moveToHead(entry: CacheEntry<V>): void {
    if (this.head === entry) return;
    this.removeEntry(entry);
    this.addToHead(entry);
  }

  private evictTail(): void {
    if (!this.tail) return;
    const oldTail = this.tail;
    this.removeEntry(oldTail);
    this.map.delete(oldTail.key);
  }

  public size(): number {
    return this.map.size;
  }
}
