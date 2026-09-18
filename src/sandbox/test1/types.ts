import { isWithinMaxTransitions } from "./main";

export interface ProgressData {
  step: number;
  percentage: number;
}

export type State =
  | { kind: "Idle"; payload: void }
  | { kind: "Loading"; payload: ProgressData }
  | { kind: "Error"; payload: Error }
  | { kind: "Success"; payload: { result: string } };

export type StateKind = State["kind"];

export type ExtractState<K extends StateKind> = Extract<State, { kind: K }>;

export type GuardFn<S extends State = State> = (state: S, transitionCount: number) => boolean;

export type ActionFn<S extends State = State> = (state: S) => State;

export type Transition<S extends State = State> = {
  name: string;
  from: S["kind"];
  to: StateKind;
  guard?: (state: S, transitionCount: number) => boolean;
  action?: (state: S) => State;
};

export function validateTransitionGuard<S extends State>(guard: GuardFn<S> | undefined, state: S, count: number): boolean {
  if (!isWithinMaxTransitions(count)) {
    return false;
  }
  return guard ? guard(state, count) : true;
}
