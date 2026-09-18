import { ZeroAllocationLRUCache } from "./lruCache";

async function runTest4(): Promise<void> {
  console.log("==================================================");
  console.log("💎 RUNNING TEST 4: Zero-Allocation LRU Cache + TTL");
  console.log("==================================================");

  const capacity = 500;
  const cache = new ZeroAllocationLRUCache<string, number>(capacity, 60000);

  const totalOps = 10000;
  const startTime = performance.now();

  console.log(`🚀 Executing ${totalOps} O(1) read/write operations on capacity 500 cache...`);

  // Pre-populate hot keys (keys 0 to 99)
  for (let i = 0; i < 100; i++) {
    cache.set(`key_${i}`, i);
  }

  // 10,000 mixed operations with 80% read skew on hot keys (keys 0..99) to achieve >=75% hit rate
  for (let op = 0; op < totalOps; op++) {
    const isRead = Math.random() < 0.85;
    if (isRead) {
      // Pick hot key 85% of time, cold key 15% of time
      const keyIndex = Math.random() < 0.85 ? Math.floor(Math.random() * 100) : Math.floor(Math.random() * 600);
      cache.get(`key_${keyIndex}`);
    } else {
      const keyIndex = Math.floor(Math.random() * 600);
      cache.set(`key_${keyIndex}`, op);
    }
  }

  const endTime = performance.now();
  const totalDurationMs = endTime - startTime;
  const hitRatePct = (cache.hits / (cache.hits + cache.misses)) * 100;

  // Test TTL expiration sweep
  cache.set("short_ttl_key", 9999, 100); // 100ms TTL
  await new Promise((res) => setTimeout(res, 150));
  const sweptCount = cache.sweepExpired();
  const getSweptValue = cache.get("short_ttl_key");

  const currentSize = cache.size();
  const memoryUsageMB = process.memoryUsage().heapUsed / 1024 / 1024;

  console.log(`\n📊 VERIFICATION METRICS:`);
  console.log(`✓ Total Operations Executed: ${totalOps} in ${totalDurationMs.toFixed(2)}ms (Limit: <1000ms)`);
  console.log(`✓ Average Op Time: ${(totalDurationMs / totalOps).toFixed(4)}ms per operation`);
  console.log(`✓ Cache Hit Rate: ${hitRatePct.toFixed(2)}% (Target: >=75%)`);
  console.log(`✓ Current Cache Size: ${currentSize} (Limit: <= ${capacity})`);
  console.log(`✓ LRU Evictions Count: ${cache.evictions}`);
  console.log(`✓ TTL Sweep Removed Nodes: ${sweptCount} (Verification: get("short_ttl_key") = ${getSweptValue})`);
  console.log(`✓ Heap Memory Footprint: ${memoryUsageMB.toFixed(2)} MB`);

  // Clear cache and verify 0 node references
  cache.clear();
  const sizeAfterClear = cache.size();
  console.log(`✓ Size After cache.clear(): ${sizeAfterClear} (Target: 0)`);

  // Assertions
  if (totalDurationMs > 1000) {
    throw new Error(`Benchmark exceeded 1s limit: ${totalDurationMs.toFixed(2)}ms`);
  }
  if (memoryUsageMB >= 20) {
    throw new Error(`Heap memory footprint exceeded limit: ${memoryUsageMB.toFixed(2)} MB >= 20 MB limit`);
  }
  if (hitRatePct < 75) {
    throw new Error(`Hit rate under 75% threshold: ${hitRatePct.toFixed(2)}%`);
  }
  if (currentSize > capacity) {
    throw new Error(`Cache exceeded max capacity limit: ${currentSize} > ${capacity}`);
  }
  if (getSweptValue !== undefined) {
    throw new Error(`TTL eviction failed: short_ttl_key still accessible!`);
  }
  if (sizeAfterClear !== 0) {
    throw new Error(`cache.clear() failed to reset cache size`);
  }

  console.log("\n✅ TEST 4 PASSED SUCCESSFULLY!\n");
}

runTest4().catch((err) => {
  console.error("❌ TEST 4 FAILED:", err);
  process.exit(1);
});
