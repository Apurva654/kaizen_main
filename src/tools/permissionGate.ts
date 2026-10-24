import * as path from 'path';
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
    const commandStr = (payload?.command || '').toString().toLowerCase();
    const rawPath = (payload?.path || payload?.relPath || payload?.filePath || '').toString();
    const normPath = rawPath ? path.posix.normalize(rawPath.replace(/\\/g, '/')).replace(/^\.\//, '') : '';
    const destructiveCmd = /(^|[;&|]\s*|\s)(rm|rmdir|del|rd|erase)\s/.test(` ${commandStr} `) || /\brm\s+-[a-z]*[rf]/.test(commandStr);

    // High Risk Operations (70 - 100)
    if (/\b(delete|remove)\b|_delete\b|_remove\b/.test(action) || destructiveCmd) {
      return 90;
    }
    if (action.includes('git_push') || /\bgit\s+push\b/.test(commandStr) || /\bsudo\b/.test(commandStr) || /\bchmod\b/.test(commandStr) || /\bnpm\s+publish\b/.test(commandStr)) {
      return 90;
    }
    if (action.includes('terminal_exec') || action.includes('shell_exec')) {
      if (/^\s*(dir|ls|pwd|echo|cat|node -v|npm -v|whoami)\b/i.test(commandStr) && !/[;&|`$><]/.test(commandStr)) {
        return 15;
      }
      return 75;
    }

    // Medium Risk Operations (30 - 69)
    if (action.includes('file_move') || action.includes('move_file') || action.includes('move') || action.includes('rename')) {
      return 45;
    }
    if (action.includes('git_commit') || /\bgit\s+commit\b/.test(commandStr)) {
      return 50;
    }
    if (action.includes('write') || action.includes('patch_file')) {
      if (normPath && (path.posix.isAbsolute(normPath) || normPath.startsWith('..') || !normPath.startsWith('src/sandbox/'))) {
        return 80;
      }
      return 45;
    }
    if (action.includes('run_tests')) {
      return 35;
    }

    // Low Risk / Safe Read Operations (0 - 29)
    if (/^(git_status|git_diff|git_log|ast_parse|general_query)$/.test(action) || /(^|_)(read|list)($|_)/.test(action)) {
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
