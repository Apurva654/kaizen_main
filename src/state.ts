import { Annotation } from '@langchain/langgraph';

export interface PlanStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export const KaizenState = Annotation.Root({
  // Read-only string input from user
  userInput: Annotation<string>(),

  // Array of target files (Prevents duplicate file paths)
  targetFiles: Annotation<string[]>({
    reducer: (x, y) => Array.from(new Set([...x, ...y])),
    default: () => []
  }),

  // String context buffer
  extractedContext: Annotation<string>({
    reducer: (_, y) => y,
    default: () => ""
  }),

  // Smart array reducer: lets you return individual updated steps OR a whole new plan
  plan: Annotation<PlanStep[]>({
    reducer: (x, y) => {
      if (!x.length) return y;
      // If y contains partial updates, merge them by matching step ID
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

  // Diff/patch output
  generatedPatch: Annotation<string>({
    reducer: (_, y) => y,
    default: () => ""
  }),

  // Option choices array
  choices: Annotation<string[]>({
    reducer: (_, y) => y,
    default: () => []
  }),

  // Counter for retries (Node can return { retryCount: 1 } to add, or just pass final count)
  retryCount: Annotation<number>({
    reducer: (x, y) => (y === 1 ? x + 1 : y), // Handy shortcut for auto-incrementing
    default: () => 0
  }),

  // Overall workflow execution status string
  status: Annotation<string>({
    reducer: (_, y) => y,
    default: () => "INITIALIZED"
  })
});

// Extract the type for use in your Node definitions
export type KaizenStateType = typeof KaizenState.State;

