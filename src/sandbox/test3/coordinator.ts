import { DatabaseParticipantNode, Transaction, Vote } from "./participant";

export interface JournalEntry {
  txId: string;
  phase: "PREPARE" | "COMMIT" | "ABORT";
  timestamp: number;
  votes?: Record<string, Vote>;
  writes: Transaction["writes"];
}

export class TransactionCoordinator {
  private nodes: Map<string, DatabaseParticipantNode> = new Map();
  public journal: JournalEntry[] = [];
  public committedTxCount: number = 0;
  public abortedTxCount: number = 0;

  constructor(nodes: DatabaseParticipantNode[]) {
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
  }

  public async executeTransaction(tx: Transaction, dropRate: number = 0.2): Promise<"COMMITTED" | "ABORTED"> {
    const targetNodes = new Set(tx.writes.map((w) => w.nodeId));
    const votes: Record<string, Vote> = {};

    // Journal Phase 1 (Prepare)
    this.journal.push({
      txId: tx.id,
      phase: "PREPARE",
      timestamp: Date.now(),
      writes: tx.writes,
    });

    let unanimousYes = true;

    // Collect votes from all target nodes
    for (const nodeId of targetNodes) {
      const node = this.nodes.get(nodeId);
      if (!node) {
        unanimousYes = false;
        votes[nodeId] = "NO";
        break;
      }

      const vote = node.prepare(tx, dropRate);
      votes[nodeId] = vote;
      if (vote !== "YES") {
        unanimousYes = false;
      }
    }

    // Phase 2 Decision (Commit vs Abort)
    if (unanimousYes) {
      // Commit across all participants
      for (const nodeId of targetNodes) {
        const node = this.nodes.get(nodeId);
        node?.commit(tx.id);
      }

      this.journal.push({
        txId: tx.id,
        phase: "COMMIT",
        timestamp: Date.now(),
        votes,
        writes: tx.writes,
      });

      this.committedTxCount++;
      return "COMMITTED";
    } else {
      // Rollback/Abort across all participants
      for (const nodeId of targetNodes) {
        const node = this.nodes.get(nodeId);
        node?.rollback(tx.id);
      }

      this.journal.push({
        txId: tx.id,
        phase: "ABORT",
        timestamp: Date.now(),
        votes,
        writes: tx.writes,
      });

      this.abortedTxCount++;
      return "ABORTED";
    }
  }
}
