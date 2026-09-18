export interface Message<T = unknown> {
  id: string;
  senderId: string;
  targetId: string;
  payload: T;
  timestamp: number;
  hopCount: number;
  retryCount?: number;
}

export class Mailbox<T = unknown> {
  private queue: Message<T>[] = [];
  private maxCapacity: number;

  constructor(maxCapacity: number = 1000) {
    this.maxCapacity = maxCapacity;
  }

  public enqueue(msg: Message<T>): void {
    if (this.queue.length >= this.maxCapacity) {
      const err = new Error(`ERR_BACKPRESSURE: Mailbox capacity exceeded (${this.maxCapacity})`);
      (err as unknown as Record<string, string>).code = "ERR_BACKPRESSURE";
      throw err;
    }
    this.queue.push(msg);
  }

  public dequeue(): Message<T> | undefined {
    return this.queue.shift();
  }

  public peek(): Message<T> | undefined {
    return this.queue[0];
  }

  public size(): number {
    return this.queue.length;
  }

  public isEmpty(): boolean {
    return this.queue.length === 0;
  }

  public clear(): void {
    this.queue = [];
  }

  public getSnapshot(): Message<T>[] {
    return [...this.queue];
  }

  public restoreSnapshot(msgs: Message<T>[]): void {
    this.queue = [...msgs, ...this.queue];
  }
}
