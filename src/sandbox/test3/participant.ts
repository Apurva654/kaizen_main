export interface WriteOperation {
  key: string;
  value: string;
  nodeId: string;
}

export interface Transaction {
  id: string;
  writes: WriteOperation[];
  timestamp: number;
}

export type Vote = "YES" | "NO";

export class DatabaseParticipantNode {
  public readonly id: string;
  private store: Map<string, string> = new Map();
  private locks: Map<string, string> = new Map(); // key -> txId
  private preparedTx: Map<string, Transaction> = new Map();

  constructor(id: string) {
    this.id = id;
  }

  public prepare(tx: Transaction, dropMessageRate: number = 0.2): Vote {
    // Simulate network loss
    if (Math.random() < dropMessageRate) {
      return "NO";
    }

    // Check key lock contention
    for (const write of tx.writes) {
      if (write.nodeId === this.id) {
        const existingLock = this.locks.get(write.key);
        if (existingLock && existingLock !== tx.id) {
          return "NO";
        }
      }
    }

    // Acquire locks for write keys on this node
    for (const write of tx.writes) {
      if (write.nodeId === this.id) {
        this.locks.set(write.key, tx.id);
      }
    }

    this.preparedTx.set(tx.id, tx);
    return "YES";
  }

  public commit(txId: string): boolean {
    const tx = this.preparedTx.get(txId);
    if (!tx) {
      return false; // Already aborted or invalid
    }

    // Apply writes
    for (const write of tx.writes) {
      if (write.nodeId === this.id) {
        this.store.set(write.key, write.value);
        this.locks.delete(write.key);
      }
    }

    this.preparedTx.delete(txId);
    return true;
  }

  public rollback(txId: string): boolean {
    const tx = this.preparedTx.get(txId);
    if (tx) {
      for (const write of tx.writes) {
        if (write.nodeId === this.id) {
          if (this.locks.get(write.key) === txId) {
            this.locks.delete(write.key);
          }
        }
      }
      this.preparedTx.delete(txId);
    }
    return true; // Idempotent rollback
  }

  public get(key: string): string | undefined {
    return this.store.get(key);
  }

  public isKeyLocked(key: string): boolean {
    return this.locks.has(key);
  }
}
