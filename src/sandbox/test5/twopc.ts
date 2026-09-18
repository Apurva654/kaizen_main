import { ActorSupervisor, NodeActor } from "./actors";
import { HybridLRUCache } from "./cache";
import { TxStateMachine } from "./fsm";

export interface SystemWrite {
  nodeId: string;
  key: string;
  value: string;
}

export interface HybridTransaction {
  id: string;
  writes: SystemWrite[];
  timestamp: number;
}

export class TwoPhaseCommitConsensusEngine {
  private supervisor: ActorSupervisor;
  private cache: HybridLRUCache<string>;
  public fsmMap: Map<string, TxStateMachine> = new Map();
  public ledger: { txId: string; phase: "PREPARE" | "COMMIT" | "ABORT"; timestamp: number }[] = [];
  public committedCount: number = 0;
  public abortedCount: number = 0;

  constructor(supervisor: ActorSupervisor, cache: HybridLRUCache<string>) {
    this.supervisor = supervisor;
    this.cache = cache;
  }

  public async processTransaction(
    tx: HybridTransaction,
    messageLossRate: number = 0.15,
    forceTimeoutAbort: boolean = false
  ): Promise<"COMMITTED" | "ABORTED"> {
    const fsm = new TxStateMachine(tx.id);
    this.fsmMap.set(tx.id, fsm);
    fsm.transitionTo("Preparing");

    this.ledger.push({ txId: tx.id, phase: "PREPARE", timestamp: Date.now() });

    if (forceTimeoutAbort) {
      fsm.transitionTo("Aborted");
      this.ledger.push({ txId: tx.id, phase: "ABORT", timestamp: Date.now() });
      this.abortedCount++;
      return "ABORTED";
    }

    let allVotesYes = true;
    const lockedNodes: { node: NodeActor; keys: string[] }[] = [];

    for (const write of tx.writes) {
      const node = this.supervisor.getNode(write.nodeId);
      if (!node || !node.isAlive || node.isIsolated) {
        allVotesYes = false;
        break;
      }

      // Simulated message loss check
      if (Math.random() < messageLossRate) {
        allVotesYes = false;
        break;
      }

      // Check existing lock contention
      const lockHolder = node.locks.get(write.key);
      if (lockHolder && lockHolder !== tx.id) {
        allVotesYes = false;
        break;
      }

      // Acquire lock
      node.locks.set(write.key, tx.id);
      lockedNodes.push({ node, keys: [write.key] });
    }

    if (allVotesYes) {
      // Phase 2: Commit
      for (const write of tx.writes) {
        const node = this.supervisor.getNode(write.nodeId);
        if (node && node.isAlive && !node.isIsolated) {
          node.store.set(write.key, write.value);
          node.locks.delete(write.key);
          // Invalidate stale cache entries for updated key
          this.cache.invalidate(write.key);
        }
      }

      fsm.transitionTo("Committed");
      fsm.transitionTo("Cached");

      // Populate memoized read result in LRU cache
      for (const write of tx.writes) {
        this.cache.set(write.key, write.value, 30000);
      }

      this.ledger.push({ txId: tx.id, phase: "COMMIT", timestamp: Date.now() });
      this.committedCount++;
      return "COMMITTED";
    } else {
      // Phase 2: Abort & release locks
      for (const item of lockedNodes) {
        for (const key of item.keys) {
          if (item.node.locks.get(key) === tx.id) {
            item.node.locks.delete(key);
          }
        }
      }

      fsm.transitionTo("Aborted");
      this.ledger.push({ txId: tx.id, phase: "ABORT", timestamp: Date.now() });
      this.abortedCount++;
      return "ABORTED";
    }
  }
}
