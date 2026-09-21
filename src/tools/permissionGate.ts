export type PermissionMode = 'deny_first' | 'auto_mode';
export type PermissionStatus = 'APPROVED' | 'REJECTED' | 'PENDING_APPROVAL' | 'AUTO_APPROVED';

export interface PermissionEvaluationResult {
  allowed: boolean;
  riskScore: number;
  reason: string;
  requiresApproval: boolean;
  status: PermissionStatus;
}

export class PermissionGateManager {
  private mode: PermissionMode = 'deny_first';
  private dryRunMode: boolean = false;

  public getMode(): PermissionMode {
    return this.mode;
  }

  public setMode(newMode: PermissionMode): void {
    console.log(`[PermissionGate] Mode updated: ${this.mode} ──► ${newMode}`);
    this.mode = newMode;
  }

  public isDryRunMode(): boolean {
    return this.dryRunMode;
  }

  public setDryRunMode(enabled: boolean): void {
    console.log(`[PermissionGate] Dry-Run Mode set to: ${enabled}`);
    this.dryRunMode = enabled;
  }

  /**
   * Evaluates Risk Assessment Score (0 - 100) based on command operation safety
   */
  public calculateRiskScore(actionType: string, payload: any = {}): number {
    const action = actionType.toLowerCase();
    const commandStr = (payload?.command || payload?.content || payload?.path || '').toString().toLowerCase();

    // High Risk Operations (70 - 100)
    if (action.includes('delete') || action.includes('remove') || commandStr.includes('rm ') || commandStr.includes('rm -rf') || commandStr.includes('del ')) {
      return 90;
    }
    if (action.includes('git_push') || commandStr.includes('git push') || commandStr.includes('sudo') || commandStr.includes('chmod') || commandStr.includes('npm publish')) {
      return 90;
    }
    if (action.includes('terminal_exec') || action.includes('shell_exec')) {
      if (/\b(dir|ls|pwd|echo|cat|node -v|npm -v|whoami)\b/i.test(commandStr) && !/\b(rm|del|sudo|chmod|rf)\b/i.test(commandStr)) {
        return 15;
      }
      return 75;
    }

    // Medium Risk Operations (30 - 69)
    if (action.includes('git_commit') || commandStr.includes('git commit')) {
      return 50;
    }
    if (action.includes('write') || action.includes('patch_file')) {
      // Writing outside src/sandbox is higher risk
      if (payload?.path && !payload.path.toString().startsWith('src/sandbox/')) {
        return 80;
      }
      return 45;
    }
    if (action.includes('run_tests')) {
      return 35;
    }

    // Low Risk / Safe Read Operations (0 - 29)
    if (action.includes('git_status') || action.includes('git_diff') || action.includes('git_log') || action.includes('read') || action.includes('list') || action.includes('ast_parse') || action.includes('general_query')) {
      return 10;
    }

    return 25;
  }

  /**
   * Evaluates whether an operation can proceed automatically or requires HITL developer approval
   */
  public evaluate(actionType: string, payload: any = {}): PermissionEvaluationResult {
    const riskScore = this.calculateRiskScore(actionType, payload);

    if (this.mode === 'auto_mode') {
      if (riskScore >= 85) {
        return {
          allowed: false,
          riskScore,
          reason: `High risk score (${riskScore}/100) requires manual confirmation even in Auto-Mode.`,
          requiresApproval: true,
          status: 'PENDING_APPROVAL'
        };
      }
      return {
        allowed: true,
        riskScore,
        reason: `Auto-Approved in Auto-Mode (Risk Score: ${riskScore}/100).`,
        requiresApproval: false,
        status: 'AUTO_APPROVED'
      };
    }

    // Deny-First Mode: Any operation with risk >= 40 requires approval
    if (riskScore >= 40) {
      return {
        allowed: false,
        riskScore,
        reason: `Deny-First Gate: Risk Score (${riskScore}/100) exceeds auto-threshold. Approval required.`,
        requiresApproval: true,
        status: 'PENDING_APPROVAL'
      };
    }

    return {
      allowed: true,
      riskScore,
      reason: `Safe read operation allowed under Deny-First Mode (Risk Score: ${riskScore}/100).`,
      requiresApproval: false,
      status: 'AUTO_APPROVED'
    };
  }
}

export const permissionGate = new PermissionGateManager();
