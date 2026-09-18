import { LRUNode } from "./node";

export class ZeroAllocationLRUCache<K, V> {
  private map: Map<K, LRUNode<K, V>> = new Map();
  private head: LRUNode<K, V> | null = null;
  private tail: LRUNode<K, V> | null = null;
  public readonly capacity: number;
  public readonly defaultTtlMs: number;
  public hits: number = 0;
  public misses: number = 0;
  public evictions: number = 0;
  public ttlExpirations: number = 0;

  constructor(capacity: number = 500, defaultTtlMs: number = 60000) {
    this.capacity = capacity;
    this.defaultTtlMs = defaultTtlMs;
  }

  public get(key: K): V | undefined {
    const node = this.map.get(key);
    if (!node) {
      this.misses++;
      return undefined;
    }

    if (node.isExpired()) {
      this.ttlExpirations++;
      this.removeNode(node);
      this.map.delete(key);
      node.detach();
      this.misses++;
      return undefined;
    }

    this.moveToHead(node);
    this.hits++;
    return node.value;
  }

  public set(key: K, value: V, ttlMs: number = this.defaultTtlMs): void {
    const existing = this.map.get(key);
    if (existing) {
      existing.value = value;
      existing.createdAt = Date.now();
      existing.expiresAt = existing.createdAt + ttlMs;
      this.moveToHead(existing);
      return;
    }

    if (this.map.size >= this.capacity) {
      this.evictTail();
    }

    const newNode = new LRUNode(key, value, ttlMs);
    this.map.set(key, newNode);
    this.addToHead(newNode);
  }

  public sweepExpired(): number {
    const now = Date.now();
    let removedCount = 0;
    let curr = this.tail;

    while (curr) {
      const prevNode = curr.prev;
      if (curr.isExpired(now)) {
        this.removeNode(curr);
        this.map.delete(curr.key);
        curr.detach();
        this.ttlExpirations++;
        removedCount++;
      }
      curr = prevNode;
    }
    return removedCount;
  }

  public size(): number {
    return this.map.size;
  }

  public clear(): void {
    let curr = this.head;
    while (curr) {
      const nextNode = curr.next;
      curr.detach();
      curr = nextNode;
    }
    this.map.clear();
    this.head = null;
    this.tail = null;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.ttlExpirations = 0;
  }

  private addToHead(node: LRUNode<K, V>): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  private removeNode(node: LRUNode<K, V>): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      this.tail = node.prev;
    }
  }

  private moveToHead(node: LRUNode<K, V>): void {
    if (this.head === node) return;
    this.removeNode(node);
    this.addToHead(node);
  }

  private evictTail(): void {
    if (!this.tail) return;
    const oldTail = this.tail;
    this.removeNode(oldTail);
    this.map.delete(oldTail.key);
    oldTail.detach();
    this.evictions++;
  }
}
