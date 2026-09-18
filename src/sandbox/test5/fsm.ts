export type TxStateKind = "Idle" | "Preparing" | "Committed" | "Aborted" | "Cached";

export interface TxState {
  kind: TxStateKind;
  txId: string;
  timestamp: number;
}

export class TxStateMachine {
  private history: TxState[] = [];

  constructor(txId: string) {
    this.history.push({ kind: "Idle", txId, timestamp: Date.now() });
  }

  public get current(): TxStateKind {
    return this.history[this.history.length - 1].kind;
  }

  public get historyLength(): number {
    return this.history.length;
  }

  public transitionTo(kind: TxStateKind): boolean {
    const curr = this.current;
    if (curr === "Committed" || curr === "Aborted") {
      if (kind !== "Cached") return false;
    }
    this.history.push({ kind, txId: this.history[0].txId, timestamp: Date.now() });
    return true;
  }
}
