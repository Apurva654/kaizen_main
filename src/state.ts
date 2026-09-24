import { Annotation } from '@langchain/langgraph';

export interface PlanStep {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  targetFile?: string;
  action?: string;
  isNewFile?: boolean;
  dependencies?: string[];
  requiresApproval?: boolean;
  appliedPatch?: boolean;
  userApprovedFile?: boolean;
  patchId?: string;
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
    reducer: (x, y) => y !== undefined ? y : x,
    default: () => 0
  }),

  // ✅ ADD THESE NEW FIELDS
  lastPlan: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  planTimestamp: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  canRetry: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => true
  }),

  rejectionReason: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
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
  }),

  generalAnswer: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  imagePayload: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  extractedImageText: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  permissionMode: Annotation<'deny_first' | 'auto_mode'>({
    reducer: (_, y) => y,
    default: () => 'deny_first'
  }),

  riskScore: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0
  }),

  permissionStatus: Annotation<'APPROVED' | 'REJECTED' | 'PENDING_APPROVAL' | 'AUTO_APPROVED'>({
    reducer: (_, y) => y,
    default: () => 'AUTO_APPROVED'
  }),

  mcpActions: Annotation<Array<{ tool: string; action: string; status: string; output?: string }>>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
    default: () => []
  }),

  dockerSandboxActive: Annotation<boolean>({
    reducer: (_, y) => y,
    default: () => false
  }),

  structuredFailures: Annotation<Array<any>>({
    reducer: (x, y) => [...(x || []), ...(y || [])],
    default: () => []
  }),

  planApprovalStatus: Annotation<'NONE' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'FEEDBACK_SUBMITTED'>({
    reducer: (_, y) => y,
    default: () => 'NONE'
  }),

  originalUserRequest: Annotation<string | undefined>({
    reducer: (_, y) => y,
    default: () => undefined
  }),

  errorsEncountered: Annotation<number>({
    reducer: (x, y) => (y !== undefined ? (x || 0) + y : (x || 0)),
    default: () => 0
  })
});

export type KaizenStateType = typeof KaizenState.State;