import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { KaizenState, PlanStep } from '../state';
import { ASTParserTool, ExtractedSymbol } from '../tools/astParser';
import { isProtectedFile } from './codeGenAgent';
import { runStructured } from '../tools/llmRunner';

dotenv.config();

export function normalizeSandboxPath(pathStr: string): string {
  if (!pathStr) return '';
  let norm = pathStr.replace(/\\/g, '/').trim();
  norm = norm.replace(/^\.\//, '');
  if (!norm.startsWith('src/sandbox/')) {
    if (norm.startsWith('src/')) {
      norm = norm.replace(/^src\//, 'src/sandbox/');
    } else {
      norm = `src/sandbox/${norm}`;
    }
  }
  return norm;
}

export const PlannerStepSchema = z.object({
  description: z.string().min(30).describe("Specific, actionable step description naming specific functions, classes, or code sections"),
  targetFile: z.string().describe("Target source file path under src/sandbox/..."),
  action: z.enum(['create', 'modify', 'test']).describe("Action type"),
  dependsOn: z.array(z.number()).optional().describe("1-indexed step numbers this step depends on")
});

export const PlannerSchema = z.object({
  approach: z.string().describe("High-level technical strategy and decomposition approach"),
  steps: z.array(PlannerStepSchema).min(1).max(8).describe("Ordered list of 1 to 8 implementation steps")
});

export function summarizePlan(plan: PlanStep[]): string {
  if (!plan || plan.length === 0) return '';
  return plan.map(s => `[${s.targetFile}] ${s.description}`).join(' | ');
}

function extractSymbolsFromWorkspace(targetFiles: string[], extractedContext: string, astParser: ASTParserTool): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const seenNames = new Set<string>();

  for (const tf of targetFiles) {
    if (tf && fs.existsSync(tf)) {
      try {
        const stat = fs.statSync(tf);
        if (!stat.isDirectory()) {
          const content = fs.readFileSync(tf, 'utf-8');
          const lang = astParser.getLanguageFromPath(tf);
          const fileSymbols = astParser.extractTopLevelSymbols(content, lang);
          for (const sym of fileSymbols) {
            const key = `${sym.language}:${sym.type}:${sym.name}`;
            if (!seenNames.has(key)) {
              seenNames.add(key);
              symbols.push(sym);
            }
          }
        }
      } catch { }
    }
  }

  if (extractedContext) {
    const fileBlocks = extractedContext.split(/--- FILE: (.*?) ---/g);
    for (let i = 1; i < fileBlocks.length; i += 2) {
      const filePath = fileBlocks[i].trim();
      const content = fileBlocks[i + 1] || "";
      const lang = astParser.getLanguageFromPath(filePath);
      const fileSymbols = astParser.extractTopLevelSymbols(content, lang);
      for (const sym of fileSymbols) {
        const key = `${sym.language}:${sym.type}:${sym.name}`;
        if (!seenNames.has(key)) {
          seenNames.add(key);
          symbols.push(sym);
        }
      }
    }
  }

  return symbols;
}

function extractTokens(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/);
  return new Set(words.filter(w => w.length > 2));
}

function computeJaccardSimilarity(text1: string, text2: string): number {
  const set1 = extractTokens(text1);
  const set2 = extractTokens(text2);
  if (set1.size === 0 || set2.size === 0) return 0;
  let intersectionSize = 0;
  for (const token of set1) {
    if (set2.has(token)) {
      intersectionSize++;
    }
  }
  const unionSize = set1.size + set2.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export async function plannerAgentNode(state: typeof KaizenState.State) {
  const cleanUserQuery = state.originalUserRequest || state.userInput || "";
  const stateTargets = state.targetFiles || [];
  const extractedCtx = state.extractedContext || "";

  const MAX_PLAN_ATTEMPTS = 3;
  const attempt = state.planAttempt ?? 0;

  const rejectedPlans: string[] = [...(state.rejectedPlans || [])];
  if (
    (state.planApprovalStatus === 'REJECTED' || state.planApprovalStatus === 'FEEDBACK_SUBMITTED') &&
    state.plan &&
    state.plan.length > 0
  ) {
    const lastSummary = summarizePlan(state.plan);
    if (lastSummary && !rejectedPlans.includes(lastSummary)) {
      rejectedPlans.push(lastSummary);
    }
  }

  if (attempt >= MAX_PLAN_ATTEMPTS) {
    return {
      status: 'PLAN_RETRY_LIMIT',
      planFailureReason: 'Plan rejected 3 times. Please refine the request.',
      rejectedPlans
    };
  }

  const astParser = new ASTParserTool();
  const normalizedTargets = stateTargets.map(normalizeSandboxPath).filter(Boolean);
  const symbols = extractSymbolsFromWorkspace(normalizedTargets, extractedCtx, astParser);

  // Strategy lens & temperature selection based on attempt
  let strategyLens = "";
  let temperature = 0.2;

  if (attempt === 0) {
    strategyLens = "Direct Implementation Strategy (attempt 0/3): Focus on the most direct, minimal, and concise change set to fulfill the request cleanly.";
    temperature = 0.2;
  } else if (attempt === 1) {
    strategyLens = "Alternative Decomposition Strategy (attempt 1/3): The previous plan was rejected. Produce a DELIBERATELY DIFFERENT decomposition, file layout, or technique than the rejected plans.";
    temperature = 0.6;
  } else {
    strategyLens = "Robustness-First Strategy (attempt 2/3): Focus on robustness-first design, comprehensive data structures, edge case validation, and verification, completely different from the rejected plans.";
    temperature = 0.9;
  }

  const systemPrompt = `You are Kaizen's Lead Software Architect.
Your task is to decompose the user's coding request into a precise, step-by-step technical plan.

STRATEGY LENS:
${strategyLens}

STRICT ARCHITECTURAL RULES:
1. Every file path in targetFile MUST be under 'src/sandbox/' (e.g., 'src/sandbox/app.py' or 'src/sandbox/services/auth.ts').
2. You select the exact file layout and filenames (hint files are suggestions only).
3. Do NOT include extra test files, CSS, HTML, or mock models unless specifically requested or necessary for the execution.
4. Small or focused requests MUST be decomposed into 1 to 3 steps max.
5. Each step's 'description' MUST be at least 30 characters long, naming specific functions, classes, or code sections to create/modify.
6. NEVER restate the user request verbatim in step descriptions or say "implement requested functionality".

Return a structured JSON output with 'approach' and 'steps'.`;

  // Read existing target hint files (up to 4000 chars each)
  const existingFilesContent: string[] = [];
  for (const targetPath of normalizedTargets) {
    const fullPath = path.resolve(process.cwd(), targetPath);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 4000);
        existingFilesContent.push(`--- FILE: ${targetPath} ---\n${content}`);
      } catch {}
    }
  }

  const symbolSummary = symbols.map(s => `${s.type} ${s.name} (${s.language})`).join(', ');
  const recentContext = extractedCtx.slice(-3000);

  const userPromptParts: string[] = [
    `USER REQUEST:\n${cleanUserQuery}`,
    `HINT FILES:\n${normalizedTargets.length > 0 ? normalizedTargets.join(', ') : 'None provided'}`,
    `EXISTING SYMBOLS:\n${symbolSummary || 'None found'}`,
  ];

  if (existingFilesContent.length > 0) {
    userPromptParts.push(`EXISTING FILE CONTENTS:\n${existingFilesContent.join('\n\n')}`);
  }

  if (recentContext) {
    userPromptParts.push(`RETRIEVED CONTEXT SNIPPET:\n${recentContext}`);
  }

  if (rejectedPlans.length > 0) {
    userPromptParts.push(`PREVIOUSLY REJECTED PLANS (do NOT repeat these approaches or file structures):\n${rejectedPlans.map((p, i) => `Rejected Plan #${i + 1}: ${p}`).join('\n')}`);
  }

  if (state.rejectionReason) {
    userPromptParts.push(`USER REJECTION FEEDBACK:\n${state.rejectionReason}`);
  }

  const userPrompt = userPromptParts.join('\n\n');

  try {
    const { result } = await runStructured({
      agent: 'PlannerAgent',
      schema: PlannerSchema,
      system: systemPrompt,
      user: userPrompt,
      temperature,
      timeoutMs: 30000,
      validate: (planRes) => {
        // Check for verbatim request restatement
        if (cleanUserQuery.length > 20) {
          const lowerReq = cleanUserQuery.toLowerCase();
          for (const step of planRes.steps) {
            if (step.description.toLowerCase().includes(lowerReq)) {
              return `Step description restates the user request verbatim: "${step.description}"`;
            }
          }
        }

        // Check Jaccard similarity against rejected plans
        const candidateSummary = planRes.steps
          .map(s => `[${normalizeSandboxPath(s.targetFile)}] ${s.description}`)
          .join(' | ');

        for (const rejectedPlan of rejectedPlans) {
          const sim = computeJaccardSimilarity(candidateSummary, rejectedPlan);
          if (sim > 0.7) {
            return `Candidate plan is too similar (Jaccard similarity ${sim.toFixed(2)} > 0.7) to a previously rejected plan: "${rejectedPlan}"`;
          }
        }

        return null;
      }
    });

    const rawSteps = result.steps;
    const planSteps: PlanStep[] = rawSteps.map((step, idx) => {
      const normTarget = normalizeSandboxPath(step.targetFile);
      const isBlocked = isProtectedFile(normTarget);
      const fullPath = path.resolve(process.cwd(), normTarget);
      const isNew = !fs.existsSync(fullPath);
      const stepDeps = (step.dependsOn || [])
        .map(depIdx => rawSteps[depIdx - 1]?.targetFile)
        .filter((tf): tf is string => Boolean(tf))
        .map(normalizeSandboxPath);

      return {
        id: idx + 1,
        step_number: idx + 1,
        description: isBlocked ? `[GUARDRAIL BLOCKED] ${step.description}` : step.description,
        targetFile: normTarget,
        action: step.action,
        isNewFile: isNew,
        dependencies: stepDeps,
        planVersion: attempt + 1,
        status: isBlocked ? 'failed' : 'pending'
      };
    });

    const anyFailed = planSteps.some(s => s.status === 'failed');
    const uniqueTargetFiles = Array.from(new Set(planSteps.map(s => s.targetFile)));

    return {
      plan: planSteps,
      targetFiles: uniqueTargetFiles,
      planAttempt: attempt + 1,
      rejectedPlans,
      rejectionReason: undefined,
      status: anyFailed ? 'SECURITY_VIOLATION_BLOCKED' : 'PLANNED'
    };
  } catch (err: any) {
    const failureReason = err?.message || 'Failed to generate plan via LLM.';
    return {
      status: 'PLAN_FAILED',
      planFailureReason: failureReason,
      rejectedPlans
    };
  }
}
