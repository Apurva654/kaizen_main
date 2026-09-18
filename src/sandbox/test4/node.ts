export class LRUNode<K, V> {
  public key: K;
  public value: V;
  public expiresAt: number;
  public createdAt: number;
  public prev: LRUNode<K, V> | null = null;
  public next: LRUNode<K, V> | null = null;

  constructor(key: K, value: V, ttlMs: number) {
    this.key = key;
    this.value = value;
    this.createdAt = Date.now();
    this.expiresAt = this.createdAt + ttlMs;
  }

  public isExpired(now: number = Date.now()): boolean {
    return now >= this.expiresAt;
  }

  public detach(): void {
    this.prev = null;
    this.next = null;
  }
}
