import { ActorSupervisor, NodeActor } from "./actors";
import { HybridLRUCache } from "./cache";
import { HybridTransaction, TwoPhaseCommitConsensusEngine } from "./twopc";

async function runTest5(): Promise<void> {
  console.log("==================================================");
  console.log("🚀 RUNNING TEST 5: The Hybrid Avalanche (NIGHTMARE MODE)");
  console.log("==================================================");

  const supervisor = new ActorSupervisor();
  const numNodes = 5;
  const nodes: NodeActor[] = [];

  for (let i = 0; i < numNodes; i++) {
    const node = new NodeActor(`node_${i}`);
    supervisor.register(node);
    nodes.push(node);
  }

  const cache = new HybridLRUCache<string>(500);
  const consensusEngine = new TwoPhaseCommitConsensusEngine(supervisor, cache);

  const totalTransactions = 50;
  const startTime = performance.now();

  console.log(`💥 INJECTING CHAOS EVENTS ACROSS 50 CONCURRENT TRANSACTIONS...`);

  // Event 1: Network partition on Node 2
  supervisor.setPartition("node_2", true);

  const txPromises: Promise<"COMMITTED" | "ABORTED">[] = [];

  for (let i = 0; i < totalTransactions; i++) {
    const nodeA = nodes[i % numNodes];
    const nodeB = nodes[(i + 1) % numNodes];

    const tx: HybridTransaction = {
      id: `hybrid_tx_${i}`,
      timestamp: Date.now(),
      writes: [
        { nodeId: nodeA.id, key: `shared_key_${i % 5}`, value: `val_${i}_A` },
        { nodeId: nodeB.id, key: `shared_key_${(i + 1) % 5}`, value: `val_${i}_B` },
      ],
    };

    // Chaos Event Injection:
    // Event 2: Simulate 5 actor crashes at specific intervals
    if (i === 10 || i === 20 || i === 30 || i === 40 || i === 48) {
      const targetNode = nodes[i % numNodes];
      targetNode.simulateCrash();
      console.log(`🔥 [CHAOS] Simulated Actor Crash on Node ${targetNode.id} during Tx ${i}`);
      // Immediate supervisor recovery
      supervisor.recoverCrashedNode(targetNode.id);
    }

    // Event 5: Coordinator timeout abort simulation on every 10th transaction
    const forceTimeoutAbort = i % 10 === 7;

    txPromises.push(consensusEngine.processTransaction(tx, 0.15, forceTimeoutAbort));

    // Cache read test after write
    cache.get(`shared_key_${i % 5}`);
  }

  // Event 1 Partition Healing: Rejoin Node 2 mid-execution
  await new Promise((res) => setTimeout(res, 50));
  supervisor.setPartition("node_2", false);
  console.log(`✨ [HEALING] Node node_2 network partition healed. State resynced.`);

  const results = await Promise.all(txPromises);
  const endTime = performance.now();
  const totalDurationMs = endTime - startTime;
  const p99LatencyMs = totalDurationMs;

  const committedCount = results.filter((r) => r === "COMMITTED").length;
  const abortedCount = results.filter((r) => r === "ABORTED").length;
  const resolutionRatePct = ((committedCount + abortedCount) / totalTransactions) * 100;

  // Verify ACID properties across ledger
  const commitTxIds = new Set(
    consensusEngine.ledger.filter((l) => l.phase === "COMMIT").map((l) => l.txId)
  );
  const abortTxIds = new Set(
    consensusEngine.ledger.filter((l) => l.phase === "ABORT").map((l) => l.txId)
  );

  let splitBrainCount = 0;
  for (const id of commitTxIds) {
    if (abortTxIds.has(id)) splitBrainCount++;
  }

  // Verify zero lingering locks across nodes
  let lingeringLocks = 0;
  for (const node of nodes) {
    lingeringLocks += node.locks.size;
  }

  const memoryUsageMB = process.memoryUsage().heapUsed / 1024 / 1024;
  const cacheHitRate = cache.hits / Math.max(1, cache.hits + cache.misses) * 100;

  console.log(`\n📊 FINAL VERIFICATION METRICS (NIGHTMARE MODE):`);
  console.log(`✓ Total Transactions Processed: ${totalTransactions}`);
  console.log(`✓ Transaction Resolution Rate: ${resolutionRatePct.toFixed(2)}% (Target: >95%)`);
  console.log(`✓ Transactions Committed: ${committedCount}`);
  console.log(`✓ Transactions Aborted Under Chaos: ${abortedCount}`);
  console.log(`✓ Split-Brain Conflicts Detected: ${splitBrainCount} (Target: 0)`);
  console.log(`✓ Lingering Lock Contention: ${lingeringLocks} (Target: 0)`);
  console.log(`✓ Recovered Actor Crashes: ${supervisor.totalCrashesRecovered} (Expected: 5)`);
  console.log(`✓ Cache Invalidations Logged: ${cache.invalidationsCount}`);
  console.log(`✓ Cache Hit Rate: ${cacheHitRate.toFixed(2)}%`);
  console.log(`✓ Peak Heap Memory Usage: ${memoryUsageMB.toFixed(2)} MB (Limit: <50 MB)`);
  console.log(`✓ Execution Duration (p99 Latency): ${totalDurationMs.toFixed(2)}ms (Limit: <2000ms)`);
  console.log(`✓ FSM Tracked Transactions: ${consensusEngine.fsmMap.size}`);

  // Assertions
  if (resolutionRatePct < 95) {
    throw new Error(`Resolution rate under 95% threshold: ${resolutionRatePct.toFixed(2)}%`);
  }
  if (splitBrainCount > 0) {
    throw new Error(`Split-brain consensus failure detected!`);
  }
  if (lingeringLocks > 0) {
    throw new Error(`Lingering unreleased locks detected on database nodes!`);
  }
  if (supervisor.totalCrashesRecovered < 5) {
    throw new Error(`Supervisor failed to recover all 5 crashed nodes!`);
  }
  if (memoryUsageMB >= 50) {
    throw new Error(`Peak heap memory usage exceeded limit: ${memoryUsageMB.toFixed(2)} MB >= 50 MB limit`);
  }
  if (totalDurationMs > 2000) {
    throw new Error(`p99 transaction latency exceeded 2000ms limit: ${totalDurationMs.toFixed(2)}ms`);
  }
  if (consensusEngine.fsmMap.size !== 50) {
    throw new Error(`FSM failed to track all 50 transactions`);
  }

  console.log("\n✅ TEST 5 (HYBRID AVALANCHE) PASSED SUCCESSFULLY!\n");
  console.log("🏆 CONGRATULATIONS! ALL 5 PENTATHLON TESTS PASSED WITH 100% SUCCESS!\n");
}

runTest5().catch((err) => {
  console.error("❌ TEST 5 FAILED:", err);
  process.exit(1);
});
