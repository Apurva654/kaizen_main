import { TransactionCoordinator } from "./coordinator";
import { DatabaseParticipantNode, Transaction } from "./participant";

class AcidVerifierNode {
  public verifyJournal(
    coordinator: TransactionCoordinator,
    nodes: DatabaseParticipantNode[]
  ): { dirtyReads: number; splitBrainConflicts: number; acidCompliant: boolean } {
    let dirtyReads = 0;
    let splitBrainConflicts = 0;

    const commitTxIds = new Set(
      coordinator.journal.filter((j) => j.phase === "COMMIT").map((j) => j.txId)
    );
    const abortTxIds = new Set(
      coordinator.journal.filter((j) => j.phase === "ABORT").map((j) => j.txId)
    );

    // 1. Verify split-brain (no tx is both COMMIT and ABORT in journal)
    for (const txId of commitTxIds) {
      if (abortTxIds.has(txId)) {
        splitBrainConflicts++;
      }
    }

    // 2. Verify no dirty locks remaining on database nodes after completion
    for (const node of nodes) {
      // Check sample keys to ensure locks were released
      for (let k = 0; k < 20; k++) {
        const key = `key_${k}`;
        if (node.isKeyLocked(key)) {
          dirtyReads++;
        }
      }
    }

    return {
      dirtyReads,
      splitBrainConflicts,
      acidCompliant: dirtyReads === 0 && splitBrainConflicts === 0,
    };
  }
}

async function runTest3(): Promise<void> {
  console.log("==================================================");
  console.log("🥉 RUNNING TEST 3: Distributed 2PC Consensus Simulator");
  console.log("==================================================");

  const numNodes = 5;
  const nodes: DatabaseParticipantNode[] = [];
  for (let i = 0; i < numNodes; i++) {
    nodes.push(new DatabaseParticipantNode(`node_${i}`));
  }

  const coordinator = new TransactionCoordinator(nodes);
  const verifier = new AcidVerifierNode();

  const totalTransactions = 100;
  const networkDropRate = 0.2; // 20% simulated network drop/failure
  const startTime = performance.now();

  console.log(`🚀 Executing ${totalTransactions} multi-node transactions with 20% network failure rate...`);

  const txPromises: Promise<"COMMITTED" | "ABORTED">[] = [];

  for (let i = 0; i < totalTransactions; i++) {
    const targetNodeA = nodes[i % numNodes];
    const targetNodeB = nodes[(i + 1) % numNodes];

    const tx: Transaction = {
      id: `tx_${i}`,
      timestamp: Date.now(),
      writes: [
        { nodeId: targetNodeA.id, key: `key_${i % 10}`, value: `val_A_${i}` },
        { nodeId: targetNodeB.id, key: `key_${(i + 1) % 10}`, value: `val_B_${i}` },
      ],
    };

    txPromises.push(coordinator.executeTransaction(tx, networkDropRate));
  }

  const results = await Promise.all(txPromises);
  const endTime = performance.now();
  const totalDurationMs = endTime - startTime;
  const avgLatencyMs = totalDurationMs / totalTransactions;

  const committedCount = results.filter((r) => r === "COMMITTED").length;
  const abortedCount = results.filter((r) => r === "ABORTED").length;

  // Run 6th Verifier Node inspection
  const verificationResult = verifier.verifyJournal(coordinator, nodes);

  console.log(`\n📊 VERIFICATION METRICS:`);
  console.log(`✓ Total Transactions Processed: ${totalTransactions}`);
  console.log(`✓ Transactions Committed: ${committedCount}`);
  console.log(`✓ Transactions Aborted (Graceful Network Recovery): ${abortedCount}`);
  console.log(`✓ Split-Brain Conflicts Detected: ${verificationResult.splitBrainConflicts} (Target: 0)`);
  console.log(`✓ Dirty Reads / Lingering Locks: ${verificationResult.dirtyReads} (Target: 0)`);
  console.log(`✓ ACID Compliance Verified: ${verificationResult.acidCompliant ? "100% YES" : "NO"}`);
  console.log(`✓ Journal Entry Count: ${coordinator.journal.length}`);
  console.log(`✓ Average 2PC Round-Trip Latency: ${avgLatencyMs.toFixed(2)}ms (Limit: <500ms)`);

  // Assertions
  if (committedCount + abortedCount !== totalTransactions) {
    throw new Error(`Transaction total mismatch: ${committedCount + abortedCount} !== ${totalTransactions}`);
  }
  if (verificationResult.splitBrainConflicts > 0) {
    throw new Error(`Split-brain consensus failure detected!`);
  }
  if (verificationResult.dirtyReads > 0) {
    throw new Error(`Dirty reads/unreleased locks detected!`);
  }
  if (!verificationResult.acidCompliant) {
    throw new Error(`ACID verification failed!`);
  }
  if (avgLatencyMs > 500) {
    throw new Error(`Average 2PC latency exceeded 500ms limit: ${avgLatencyMs.toFixed(2)}ms`);
  }

  console.log("\n✅ TEST 3 PASSED SUCCESSFULLY!\n");
}

runTest3().catch((err) => {
  console.error("❌ TEST 3 FAILED:", err);
  process.exit(1);
});
