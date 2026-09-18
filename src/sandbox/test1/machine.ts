import { State, StateKind, Transition, validateTransitionGuard } from "./types";

export class GenericStateMachine<S extends State = State> {
  private history: S[];
  private transitions: Map<string, Transition<S>>;
  private transitionCount: number = 0;

  constructor(initialState: S) {
    this.history = [Object.freeze({ ...initialState })];
    this.transitions = new Map();
  }

  public registerTransition(transition: Transition<S>): void {
    this.transitions.set(transition.name, transition);
  }

  public getCurrentState(): Readonly<S> {
    return this.history[this.history.length - 1];
  }

  public getHistory(): ReadonlyArray<Readonly<S>> {
    return this.history;
  }

  public getTransitionCount(): number {
    return this.transitionCount;
  }

  public transition(transitionName: string, nextStateOverride?: S): boolean {
    const transition = this.transitions.get(transitionName);
    if (!transition) {
      return false;
    }

    const current = this.getCurrentState();
    if (current.kind !== transition.from) {
      return false;
    }

    if (!validateTransitionGuard(transition.guard, current, this.transitionCount)) {
      return false;
    }

    let newState: S;
    if (transition.action) {
      newState = Object.freeze(transition.action(current)) as S;
    } else if (nextStateOverride) {
      newState = Object.freeze({ ...nextStateOverride });
    } else {
      return false;
    }

    this.history.push(newState);
    this.transitionCount++;
    return true;
  }
}
