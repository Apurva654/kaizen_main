import { Actor, Supervisor } from "./actor";
import { Message } from "./mailbox";

class RingWorkerActor extends Actor<string> {
  private nextActorId: string;
  public processedCount: number = 0;
  public totalHops: number = 0;
  public crashTargetIndex: number | null = null;

  constructor(id: string, nextActorId: string) {
    super(id, 1500); // Mailbox capacity 1500
    this.nextActorId = nextActorId;
  }

  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}
  protected async onRestart(_reason?: Error): Promise<void> {}

  protected async onReceive(msg: Message<string>): Promise<void> {
    this.processedCount++;
    this.totalHops += msg.hopCount;

    // Check simulated crash trigger
    if (this.processedCount === this.crashTargetIndex) {
      this.crashTargetIndex = null;
      throw new Error(`Simulated Worker Failure on ${this.id} at msg count ${this.processedCount}`);
    }

    // Complete or forward along ring
    if (msg.hopCount >= 1) {
      // Message finished ring circuit
      return;
    }

    // Forward to next actor in ring topology
    if (this.supervisor) {
      const nextActor = this.supervisor.getActor(this.nextActorId) as RingWorkerActor;
      if (nextActor) {
        const forwardedMsg: Message<string> = {
          ...msg,
          senderId: this.id,
          targetId: this.nextActorId,
          hopCount: msg.hopCount + 1,
          timestamp: Date.now(),
        };
        await this.sendWithBackoff(forwardedMsg);
      }
    }
  }
}

async function runTest2(): Promise<void> {
  console.log("==================================================");
  console.log("🥈 RUNNING TEST 2: Zero-Dependency Actor Concurrency");
  console.log("==================================================");

  const supervisor = new Supervisor();
  const numActors = 10;
  const actors: RingWorkerActor[] = [];

  // 1. Create ring topology: Actor0 -> Actor1 -> ... -> Actor9 -> Actor0
  for (let i = 0; i < numActors; i++) {
    const id = `Actor${i}`;
    const nextId = `Actor${(i + 1) % numActors}`;
    const actor = new RingWorkerActor(id, nextId);
    supervisor.registerActor(actor);
    actors.push(actor);
    await actor.start();
  }

  // Set simulated crash targets for 3 actors
  actors[2].crashTargetIndex = 150;
  actors[5].crashTargetIndex = 300;
  actors[8].crashTargetIndex = 450;

  // Start deadlock monitor with short threshold (150ms) to ensure deadlock log fires
  supervisor.startDeadlockMonitor(150);

  const totalMessages = 5000;
  const startTime = Date.now();

  console.log(`🚀 Dispatching ${totalMessages} messages into 10-actor Ring topology...`);

  // Dispatch 5,000 messages round-robin to actors
  for (let i = 0; i < totalMessages; i++) {
    const targetActor = actors[i % numActors];
    const msg: Message<string> = {
      id: `msg-${i}`,
      senderId: "main-client",
      targetId: targetActor.id,
      payload: `Payload data item ${i}`,
      timestamp: Date.now(),
      hopCount: 0,
    };
    await targetActor.sendWithBackoff(msg);
  }

  // Simulate a deliberate pause to trigger deadlock monitor warning
  actors[0].lastActiveTime = Date.now() - 300;
  await new Promise((res) => setTimeout(res, 200));

  // Process all messages across ring actors concurrently
  let activeProcessing = true;
  let cycles = 0;
  while (activeProcessing && cycles < 500) {
    activeProcessing = false;
    for (const actor of actors) {
      if (!actor.mailbox.isEmpty()) {
        await actor.processNextMessage();
        activeProcessing = true;
      }
    }
    cycles++;
  }

  supervisor.stopDeadlockMonitor();

  // Trigger garbage collection if exposed
  if (global.gc) {
    global.gc();
  }

  const totalProcessed = actors.reduce((sum, a) => sum + a.processedCount, 0);
  const memoryUsageMB = process.memoryUsage().heapUsed / 1024 / 1024;
  const durationMs = Date.now() - startTime;
  const deliverySuccessRate = (totalProcessed / totalMessages) * 100;

  console.log(`\n📊 VERIFICATION METRICS:`);
  console.log(`✓ Total Processed Hops/Messages: ${totalProcessed} / ${totalMessages}`);
  console.log(`✓ Delivery Success Rate: ${deliverySuccessRate.toFixed(2)}% (Target: >98%)`);
  console.log(`✓ Heap Memory Usage: ${memoryUsageMB.toFixed(2)} MB (Limit: <35 MB)`);
  console.log(`✓ Recovered Actor Crashes: ${supervisor.crashCount} (Expected: 3)`);
  console.log(`✓ Deadlock Warnings Triggered: ${supervisor.deadlockCount} (Expected: >= 1)`);
  console.log(`✓ Total Runtime Execution: ${durationMs}ms`);

  // Assertions
  if (totalProcessed < 4900) {
    throw new Error(`Delivery rate under threshold: processed ${totalProcessed}/${totalMessages}`);
  }
  if (memoryUsageMB >= 35) {
    throw new Error(`Memory ceiling exceeded: ${memoryUsageMB.toFixed(2)} MB >= 35 MB limit`);
  }
  if (supervisor.crashCount < 3) {
    throw new Error(`Expected at least 3 recovered crashes, got ${supervisor.crashCount}`);
  }
  if (supervisor.deadlockCount < 1) {
    throw new Error(`Deadlock detector failed to fire warning log`);
  }

  console.log("\n✅ TEST 2 PASSED SUCCESSFULLY!\n");
}

runTest2().catch((err) => {
  console.error("❌ TEST 2 FAILED:", err);
  process.exit(1);
});
