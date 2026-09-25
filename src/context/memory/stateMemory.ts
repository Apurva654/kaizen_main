import { KaizenStateType } from '../../state';
import { StateMemoryRecord, sanitizeSecretInfo } from './memoryTypes';
import { persistenceEngine } from '../../tools/persistenceEngine';

export class StateMemoryManager {
  private currentState: StateMemoryRecord | null = null;

  public updateState(state: KaizenStateType, workspaceId: string = 'default'): StateMemoryRecord {
    const generatedObj: Record<string, string> = {};
    if (state.generatedPatch) {
      generatedObj['patch'] = state.generatedPatch;
    }

    const record: StateMemoryRecord = {
      id: `state_${state.sessionId || 'current'}`,
      type: 'state',
      workspaceId,
      sessionId: state.sessionId,
      runId: state.runId,
      timestamp: new Date().toISOString(),
      currentTask: sanitizeSecretInfo(state.originalUserRequest || state.userInput || 'Initialized'),
      currentStage: state.currentStage || 'intent',
      completedStages: state.completedStages || [],
      skippedStages: state.skippedStages || [],
      targetFiles: state.targetFiles || [],
      plan: state.plan || [],
      planApprovalStatus: state.planApprovalStatus || 'NONE',
      generatedFiles: generatedObj,
      errors: (state.structuredFailures || []).map(f => sanitizeSecretInfo(typeof f === 'string' ? f : f.message || JSON.stringify(f))),
      retryCount: state.retryCount || 0,
      status: state.status || 'INITIALIZED',
      lifecycleStatus: state.lifecycleStatus || 'RUNNING',
      permissionStatus: state.permissionStatus || 'AUTO_APPROVED',
      dockerSandboxActive: !!state.dockerSandboxActive,
      importance: 0.8,
      confidence: 1.0
    };

    this.currentState = record;

    if (state.sessionId) {
      persistenceEngine.saveCheckpoint(state.sessionId, record.currentStage, state);
    }

    return record;
  }

  public getState(): StateMemoryRecord | null {
    return this.currentState;
  }

  public clearState(): void {
    this.currentState = null;
  }

  public formatForPrompt(): string {
    if (!this.currentState) {
      return 'STATE MEMORY: (No active execution state)';
    }

    const s = this.currentState;
    const planSummary = s.plan.length > 0
      ? s.plan.map(step => `  [${step.status}] Step ${step.id}: ${step.description}`).join('\n')
      : '  (No steps)';

    const errorSummary = s.errors.length > 0
      ? s.errors.map(err => `  - ${err}`).join('\n')
      : '  (None)';

    return `
STATE MEMORY (Current Workflow Execution):
==========================================
Session ID: ${s.sessionId || 'N/A'}
Current Task: ${s.currentTask}
Current Stage: ${s.currentStage}
Status: ${s.status} | Lifecycle: ${s.lifecycleStatus}
Target Files: ${s.targetFiles.join(', ') || 'None'}
Retry Count: ${s.retryCount}
Plan Approval: ${s.planApprovalStatus}

PLAN STEPS:
${planSummary}

ERRORS ENCOUNTERED:
${errorSummary}
`;
  }
}
