import { Mailbox, Message } from "./mailbox";

export abstract class Actor<T = unknown> {
  public readonly id: string;
  public readonly mailbox: Mailbox<T>;
  protected supervisor: Supervisor | null = null;
  public isAlive: boolean = false;
  public lastActiveTime: number = Date.now();
  public restartCount: number = 0;

  constructor(id: string, maxMailboxCapacity: number = 1000) {
    this.id = id;
    this.mailbox = new Mailbox<T>(maxMailboxCapacity);
  }

  public setSupervisor(supervisor: Supervisor): void {
    this.supervisor = supervisor;
  }

  public async start(): Promise<void> {
    this.isAlive = true;
    this.lastActiveTime = Date.now();
    await this.onStart();
  }

  public async stop(): Promise<void> {
    this.isAlive = false;
    await this.onStop();
  }

  public async restart(reason?: Error): Promise<void> {
    this.restartCount++;
    this.isAlive = false;
    await this.onStop();
    await this.onRestart(reason);
    this.isAlive = true;
    this.lastActiveTime = Date.now();
    await this.onStart();
  }

  public async sendWithBackoff(msg: Message<T>, maxRetries: number = 5): Promise<boolean> {
    let delay = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        this.mailbox.enqueue(msg);
        return true;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error?.code === "ERR_BACKPRESSURE") {
          if (attempt === maxRetries) {
            return false;
          }
          await new Promise((res) => setTimeout(res, delay));
          delay *= 2;
        } else {
          throw err;
        }
      }
    }
    return false;
  }

  public async processNextMessage(): Promise<boolean> {
    if (!this.isAlive || this.mailbox.isEmpty()) {
      return false;
    }

    const msg = this.mailbox.dequeue();
    if (!msg) return false;

    this.lastActiveTime = Date.now();
    try {
      await this.onReceive(msg);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (this.supervisor) {
        await this.supervisor.handleActorCrash(this, error, msg);
      }
      return false;
    }
  }

  protected abstract onStart(): Promise<void>;
  protected abstract onReceive(msg: Message<T>): Promise<void>;
  protected abstract onStop(): Promise<void>;
  protected abstract onRestart(reason?: Error): Promise<void>;
}

export class Supervisor {
  private actors: Map<string, Actor> = new Map();
  public crashCount: number = 0;
  public deadlockCount: number = 0;
  private deadlockCheckInterval: NodeJS.Timeout | null = null;
  public deadlockThresholdMs: number = 200; // Simulated threshold for fast testing (e.g. 200ms or 5s threshold)

  public registerActor(actor: Actor): void {
    actor.setSupervisor(this);
    this.actors.set(actor.id, actor);
  }

  public getActor(id: string): Actor | undefined {
    return this.actors.get(id);
  }

  public async handleActorCrash(actor: Actor, reason: Error, failedMessage?: Message): Promise<void> {
    this.crashCount++;
    console.log(`⚠️ [SUPERVISOR] Actor ${actor.id} CRASHED: ${reason.message}. Restarting...`);

    // Durable queue preservation: return unhandled message if any back into mailbox
    const savedQueue = actor.mailbox.getSnapshot();
    if (failedMessage) {
      savedQueue.unshift(failedMessage);
    }

    // Exponential backoff restart logic (simulated 10ms -> 20ms -> 40ms for test performance)
    const backoffDelay = Math.min(100, 10 * Math.pow(2, actor.restartCount));
    await new Promise((res) => setTimeout(res, backoffDelay));

    await actor.restart(reason);
    actor.mailbox.restoreSnapshot(savedQueue);
    console.log(`✅ [SUPERVISOR] Actor ${actor.id} successfully RESTARTED with ${actor.mailbox.size()} messages preserved.`);
  }

  public startDeadlockMonitor(timeoutMs: number = 200): void {
    this.deadlockThresholdMs = timeoutMs;
    this.deadlockCheckInterval = setInterval(() => {
      const now = Date.now();
      for (const actor of this.actors.values()) {
        if (actor.isAlive && !actor.mailbox.isEmpty()) {
          const inactiveDuration = now - actor.lastActiveTime;
          if (inactiveDuration > this.deadlockThresholdMs) {
            this.deadlockCount++;
            console.log(
              `🚨 WARNING [DEADLOCK DETECTOR]: Actor ${actor.id} stalled for ${inactiveDuration}ms with ${actor.mailbox.size()} pending messages.`
            );
            // Reset active time to prevent log spam
            actor.lastActiveTime = now;
          }
        }
      }
    }, 50);
  }

  public stopDeadlockMonitor(): void {
    if (this.deadlockCheckInterval) {
      clearInterval(this.deadlockCheckInterval);
      this.deadlockCheckInterval = null;
    }
  }
}
