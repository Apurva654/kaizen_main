export interface ActorMessage<T = unknown> {
  id: string;
  senderId: string;
  targetId: string;
  type: "PREPARE" | "COMMIT" | "ROLLBACK" | "HEARTBEAT" | "RESYNC";
  payload: T;
  timestamp: number;
}

export class NodeActor {
  public readonly id: string;
  public isIsolated: boolean = false; // Simulated Network Partition
  public store: Map<string, string> = new Map();
  public locks: Map<string, string> = new Map();
  public mailbox: ActorMessage[] = [];
  public crashCount: number = 0;
  public isAlive: boolean = true;

  constructor(id: string) {
    this.id = id;
  }

  public enqueue(msg: ActorMessage): boolean {
    if (!this.isAlive || this.isIsolated) {
      return false; // Dropped/Partitioned
    }
    this.mailbox.push(msg);
    return true;
  }

  public processNext(): ActorMessage | undefined {
    if (!this.isAlive || this.mailbox.length === 0) {
      return undefined;
    }
    return this.mailbox.shift();
  }

  public simulateCrash(): void {
    this.isAlive = false;
    this.crashCount++;
    // Mailbox is preserved during crash recovery
  }

  public recover(): void {
    this.isAlive = true;
  }
}

export class ActorSupervisor {
  private nodes: Map<string, NodeActor> = new Map();
  public totalCrashesRecovered: number = 0;

  public register(node: NodeActor): void {
    this.nodes.set(node.id, node);
  }

  public getNode(id: string): NodeActor | undefined {
    return this.nodes.get(id);
  }

  public recoverCrashedNode(id: string): void {
    const node = this.nodes.get(id);
    if (node && !node.isAlive) {
      node.recover();
      this.totalCrashesRecovered++;
      console.log(`⚡ [SUPERVISOR] Node ${id} RECOVERED with ${node.mailbox.length} messages preserved.`);
    }
  }

  public setPartition(id: string, isolated: boolean): void {
    const node = this.nodes.get(id);
    if (node) {
      node.isIsolated = isolated;
      console.log(`🌐 [CHAOS] Node ${id} Network Partition status set to: ${isolated ? "ISOLATED" : "REJOINED"}`);
    }
  }
}
