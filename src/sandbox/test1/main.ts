import { GenericStateMachine } from "./machine";
import { State, ProgressData } from "./types";

export const MAX_TRANSITIONS = 10000;

export function isWithinMaxTransitions(count: number): boolean {
  return count < MAX_TRANSITIONS;
}

function runTest1(): void {
  console.log("==================================================");
  console.log("🥇 RUNNING TEST 1: Generic FSM & Circular Dependency");
  console.log("==================================================");

  const initialState: State = { kind: "Idle", payload: undefined };
  const fsm = new GenericStateMachine<State>(initialState);

  // Register transitions
  fsm.registerTransition({
    name: "start",
    from: "Idle",
    to: "Loading",
    guard: (_state, _count) => true,
    action: (_state) => ({
      kind: "Loading",
      payload: { step: 1, percentage: 0 },
    }),
  });

  fsm.registerTransition({
    name: "progress",
    from: "Loading",
    to: "Loading",
    guard: (state, count) => isWithinMaxTransitions(count) && state.kind === "Loading",
    action: (state) => {
      if (state.kind !== "Loading") {
        return state;
      }
      const nextStep = state.payload.step + 1;
      const nextPct = Math.min(100, Math.floor((nextStep / 500) * 100));
      return {
        kind: "Loading",
        payload: { step: nextStep, percentage: nextPct },
      };
    },
  });

  fsm.registerTransition({
    name: "complete",
    from: "Loading",
    to: "Success",
    guard: (state) => state.kind === "Loading" && state.payload.step >= 500,
    action: () => ({
      kind: "Success",
      payload: { result: "Pipeline execution completed successfully" },
    }),
  });

  const startTime = performance.now();

  // 1. Idle -> Loading
  const started = fsm.transition("start");
  if (!started) {
    throw new Error("Failed to transition from Idle to Loading");
  }

  // 2. Loop 499 times through progress
  for (let i = 0; i < 499; i++) {
    const ok = fsm.transition("progress");
    if (!ok) {
      throw new Error(`Progress transition failed at iteration ${i}`);
    }
  }

  // 3. Loading -> Success
  const finished = fsm.transition("complete");
  if (!finished) {
    throw new Error("Failed to transition from Loading to Success");
  }

  const endTime = performance.now();
  const durationMs = endTime - startTime;

  const history = fsm.getHistory();
  const transitionCount = fsm.getTransitionCount();

  console.log(`✓ Total State Changes: ${transitionCount}`);
  console.log(`✓ History Buffer Length: ${history.length}`);
  console.log(`✓ Final State: ${JSON.stringify(fsm.getCurrentState())}`);
  console.log(`✓ Execution Time: ${durationMs.toFixed(2)}ms (Limit: <100ms)`);

  // Assertions
  if (transitionCount < 500) {
    throw new Error(`Expected at least 500 transitions, got ${transitionCount}`);
  }
  if (history.length !== 502) {
    throw new Error(`Expected history length 502, got ${history.length}`);
  }
  if (durationMs > 100) {
    throw new Error(`Execution exceeded 100ms threshold: ${durationMs.toFixed(2)}ms`);
  }
  if (fsm.getCurrentState().kind !== "Success") {
    throw new Error(`Final state must be 'Success'`);
  }

  console.log("\n✅ TEST 1 PASSED SUCCESSFULLY!\n");
}

runTest1();
