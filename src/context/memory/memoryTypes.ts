import { PlanStep } from '../../state';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type MemoryType = 'state' | 'short_term' | 'long_term' | 'episodic';

export type LongTermCategory =
  | 'user_preference'
  | 'project_fact'
  | 'architecture_decision'
  | 'coding_convention'
  | 'repository_convention'
  | 'important_constraint';

export type EventKind =
  | 'USER_MESSAGE'
  | 'ASSISTANT_RESPONSE'
  | 'AGENT_STARTED'
  | 'AGENT_COMPLETED'
  | 'TOOL_CALLED'
  | 'TOOL_RESULT'
  | 'TEST_FAILED'
  | 'TEST_PASSED'
  | 'DEBUG_ATTEMPT'
  | 'PLAN_APPROVED'
  | 'PLAN_REJECTED';

export interface BaseMemory {
  id: string;
  type: MemoryType;
  workspaceId: string;
  sessionId?: string;
  timestamp: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface StateMemoryRecord extends BaseMemory {
  type: 'state';
  runId?: string;
  currentTask: string;
  currentStage: string;
  completedStages: string[];
  skippedStages: string[];
  targetFiles: string[];
  plan: PlanStep[];
  planApprovalStatus: string;
  generatedFiles: Record<string, string>;
  errors: string[];
  retryCount: number;
  status: string;
  lifecycleStatus: string;
  permissionStatus: string;
  dockerSandboxActive: boolean;
}

export interface ShortTermEvent extends BaseMemory {
  type: 'short_term';
  eventKind: EventKind;
  role?: 'user' | 'assistant' | 'system';
  content: string;
  summary?: string;
  agent?: string;
  toolName?: string;
  toolResult?: string;
}

export interface LongTermMemoryRecord extends BaseMemory {
  type: 'long_term';
  category: LongTermCategory;
  key: string;
  value: string;
  source: string;
  confidence: number;
}

export interface EpisodicMemoryRecord extends BaseMemory {
  type: 'episodic';
  episodeId: string;
  task: string;
  intent: string;
  affectedFiles: string[];
  actions: string[];
  errors: string[];
  solution: string;
  outcome: 'success' | 'failure' | 'partial';
  testsPassed: boolean;
  lessons: string[];
}

export interface UnifiedContext {
  codeContext: string;
  stateMemory?: StateMemoryRecord;
  shortTermMemory: ShortTermEvent[];
  longTermMemory: LongTermMemoryRecord[];
  episodicMemory: EpisodicMemoryRecord[];
}

export function sanitizeSecretInfo(text: string): string {
  if (!text) return text;
  let sanitized = text;

  // 1. Redact direct API key & secret token signatures (gsk_, sk-, AIzaSy, Bearer, PEM keys)
  sanitized = sanitized
    .replace(/(gsk_[a-zA-Z0-9_-]{6,})/g, '[REDACTED_API_KEY]')
    .replace(/(sk-[a-zA-Z0-9_-]{6,})/g, '[REDACTED_API_KEY]')
    .replace(/(AIzaSy[a-zA-Z0-9_-]{15,})/g, '[REDACTED_API_KEY]')
    .replace(/Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/(-----BEGIN\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+PRIVATE\s+KEY-----)/gi, '[REDACTED_PRIVATE_KEY]');

  // 2. Redact natural language or code API key & token assignments (e.g. api_key = "...", apiKey: sk-..., token is ...)
  const apiKeyPattern = /\b((?:api[_\s]*key|apikey|access[_\s]*token|auth[_\s]*token|token))\s*(?:[:=]|\bis\b|\bwas\b|\bset\s+to\b)\s*(['"]?)([^'"\s,;.]+)\2/gi;
  sanitized = sanitized.replace(apiKeyPattern, (match, label, quote, val) => {
    if (!val || val === '[REDACTED_API_KEY]' || val === '[REDACTED]') return match;
    return match.replace(val, '[REDACTED_API_KEY]');
  });

  // 3. Redact natural language or code password & secret assignments (e.g. password is demo-password, password="...", secret: ...)
  const passwordPattern = /\b((?:password|passcode|secret))\s*(?:[:=]|\bis\b|\bwas\b|\bset\s+to\b)\s*(['"]?)([^'"\s,;.]+)\2/gi;
  sanitized = sanitized.replace(passwordPattern, (match, label, quote, val) => {
    if (!val || val === '[REDACTED_API_KEY]' || val === '[REDACTED]') return match;
    return match.replace(val, '[REDACTED]');
  });

  return sanitized;
}
