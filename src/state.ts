import { Annotation } from '@langchain/langgraph';

export interface PlanStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export const KaizenState = Annotation.Root({
  sessionId: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  createdAt: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  userInput: Annotation<string>(),

  targetFiles: Annotation<string[]>({
    reducer: (x, y) => Array.from(new Set([...x, ...y])),
    default: () => []
  }),

  extractedContext: Annotation<string>({
    reducer: (_, y) => y,
    default: () => ""
  }),

  plan: Annotation<PlanStep[]>({
    reducer: (x, y) => {
      if (!x.length) return y;
      const merged = [...x];
      for (const updatedStep of y) {
        const idx = merged.findIndex(s => s.id === updatedStep.id);
        if (idx !== -1) {
          merged[idx] = { ...merged[idx], ...updatedStep };
        } else {
          merged.push(updatedStep);
        }
      }
      return merged;
    },
    default: () => []
  }),

  generatedPatch: Annotation<string>({
    reducer: (_, y) => y,
    default: () => ""
  }),

  choices: Annotation<string[]>({
    reducer: (_, y) => y,
    default: () => []
  }),

  retryCount: Annotation<number>({
    reducer: (x, y) => (y === 1 ? x + 1 : y),
    default: () => 0
  }),

  status: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "INITIALIZED"
  }),

  runId: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  lifecycleStatus: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => "INITIALIZED"
  }),

  currentStage: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => "intent"
  }),

  completedStages: Annotation<string[] | undefined>({
    reducer: (x, y) => Array.from(new Set([...(x || []), ...(y || [])])),
    default: () => []
  }),

  skippedStages: Annotation<string[] | undefined>({
    reducer: (x, y) => Array.from(new Set([...(x || []), ...(y || [])])),
    default: () => []
  })
});

export type KaizenStateType = typeof KaizenState.State;



