import { z } from 'zod';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { workspaceManager } from '../tools/workspaceManager';
import * as path from 'path';
import { KaizenState, PlanStep } from '../state';
import { ASTParserTool, ExtractedSymbol } from '../tools/astParser';
import { isProtectedFile, normalizeSandboxPath } from '../tools/sandboxPathUtils';
import { runStructured } from '../tools/llmRunner';

dotenv.config();

export { normalizeSandboxPath };

export const PlannerStepSchema = z.object({
  description: z.string().min(10).describe("Specific, actionable step description naming specific functions, classes, or code sections"),
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

const SIMILARITY_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'then', 'will', 'all',
  'src', 'sandbox', 'implement', 'export', 'exports', 'create', 'modify', 'update', 'add',
  'file', 'files', 'function', 'functions', 'class', 'classes', 'method', 'code', 'new',
  'test', 'tests', 'using', 'use', 'make', 'ensure'
]);

function extractTokens(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/);
  return new Set(words.filter(w => w.length > 2 && !SIMILARITY_STOPWORDS.has(w)));
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


function parsePlanSummary(summary: string): { files: Set<string>; text: string } {
  const files = new Set<string>();
  for (const m of summary.matchAll(/\[([^\]]+)\]/g)) {
    files.add(m[1].trim());
  }
  const text = summary.replace(/\[[^\]]*\]/g, ' ');
  return { files, text };
}

function sameFileSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const f of a) {
    if (!b.has(f)) return false;
  }
  return true;
}

export async function plannerAgentNode(state: typeof KaizenState.State) {
  const cleanUserQuery = state.originalUserRequest || state.userInput || "";
  const stateTargets = state.targetFiles || [];
  const extractedCtx = state.extractedContext || "";

  const MAX_PLAN_ATTEMPTS = 3;
  const attempt = state.planAttempt ?? 0;

  const isFeedback = state.planApprovalStatus === 'FEEDBACK_SUBMITTED' ||
    Boolean(state.planFeedback) ||
    (Boolean(state.rejectionReason) && Boolean(state.plan && state.plan.length > 0) && state.planApprovalStatus !== 'REJECTED');
  const feedbackText = (state.planFeedback || state.rejectionReason || "").trim();

  const rejectedPlans: string[] = [...(state.rejectedPlans || [])];
  if (
    state.planApprovalStatus === 'REJECTED' &&
    state.plan &&
    state.plan.length > 0
  ) {
    const lastSummary = summarizePlan(state.plan);
    if (lastSummary && !rejectedPlans.includes(lastSummary)) {
      rejectedPlans.push(lastSummary);
    }
  }

  if (!isFeedback && attempt >= MAX_PLAN_ATTEMPTS) {
    return {
      status: 'PLAN_RETRY_LIMIT',
      planFailureReason: 'Plan rejected 3 times. Please refine the request.',
      rejectedPlans
    };
  }

  const astParser = new ASTParserTool();
  const normalizedTargets = stateTargets.map(normalizeSandboxPath).filter(Boolean);
  const symbols = extractSymbolsFromWorkspace(normalizedTargets, extractedCtx, astParser);

  // Strategy lens & temperature selection based on attempt and feedback mode
  let strategyLens = "";
  let temperature = 0.2;

  if (isFeedback) {
    strategyLens = `Plan Modification Strategy: The user has reviewed the plan and submitted specific feedback. Carefully modify and refine the plan to directly address and incorporate the user's feedback. Preserve existing steps that remain valid, update modified steps, and add or remove steps as requested.`;
    temperature = 0.2;
  } else if (attempt === 0) {
    strategyLens = "Direct Implementation Strategy (attempt 0/3): Focus on the most direct, minimal, and concise change set to fulfill the request cleanly.";
    temperature = 0.2;
  } else if (attempt === 1) {
    strategyLens = "Alternative Decomposition Strategy (attempt 1/3): The previous plan was rejected. Produce a DELIBERATELY DIFFERENT decomposition, file layout, or technique than the rejected plans.";
    temperature = 0.6;
  } else {
    strategyLens = "Robustness-First Strategy (attempt 2/3): Focus on robustness-first design, comprehensive data structures, edge case validation, and verification, completely different from the rejected plans.";
    temperature = 0.9;
  }

  const systemPrompt = `You are KAIZEN's Lead Software Architect and Task Planning Agent.

Your responsibility is to analyze a user's coding request, understand the current workspace and task context, and produce a precise, minimal, dependency-aware implementation plan for KAIZEN's downstream agents.

You are a PLANNER, not a CODE GENERATOR. Do not write implementation code. Produce a plan that the Code Generation, Test Runner, Debugger, and Code Review agents can execute and verify.

STRATEGY LENS:
${strategyLens}

AVAILABLE CONTEXT:
Use the workspace information, active file, existing source code summaries, dependency graph, previous plan, conversation history, requested language, and other context supplied to you. Some context sources may be unavailable; never assume that missing information exists.

## 1. UNDERSTAND THE USER'S ACTUAL INTENT

Before creating a plan, determine internally:

- What outcome does the user actually want?
- Is this a new project, a feature addition, a bug fix, a refactor, a test request, a documentation request, or a follow-up modification?
- Which existing files and functions are relevant?
- What existing behavior must be preserved?
- Which dependencies, interfaces, or modules could be affected?
- What would count as successful completion?

Distinguish between creating a new application and modifying an existing application.

For follow-up requests, treat the current workspace as the primary source of truth. Reuse existing implementations and preserve previously implemented features unless the user explicitly asks to remove or replace them.

Never plan a complete rewrite when a focused modification is sufficient.

## 2. WORKSPACE-GROUNDED PLANNING

1. Prefer modifying existing relevant files over creating duplicate implementations.
2. Use the active file, workspace context, AST information, and dependency graph when available.
3. Reference only files that are known to exist or that the plan explicitly creates.
4. Do not invent functions, classes, APIs, dependencies, or existing functionality.
5. Do not rely exclusively on conversation history when the current source code is available.
6. If the user manually changed code, plan against the latest available source rather than stale cached content.
7. If workspace information is insufficient, keep the plan conservative and state the limitation in the approach.
8. Avoid unrelated changes, unnecessary abstractions, and broad refactors.

## 3. STRICT FILE-PATH RULES

Every path assigned to targetFile MUST be relative to the project workspace and start with \`src/sandbox/\`.

Valid examples:
- src/sandbox/main.py
- src/sandbox/student_result.py
- src/sandbox/services/auth.ts
- src/sandbox/games/star_catcher.py
- src/sandbox/tests/test_student_result.py

Invalid examples:
- main.py
- src/main.py
- tests/test_app.py
- C:\\\\project\\\\main.py
- /tmp/generated.py

Additional requirements:

- Preserve an explicitly requested target path exactly when valid.
- If an explicit target path is outside \`src/sandbox/\`, do not silently violate the path rule. Report the conflict in the approach and select a compliant path only when appropriate.
- Do not create duplicate files when a suitable implementation already exists.
- Do not create extra HTML, CSS, configuration, test, mock, or documentation files unless requested or necessary.
- If multiple files must be changed, create appropriately scoped steps with valid targetFile paths.
- Do not include absolute paths or traversal segments such as \`../\`.

## 4. LANGUAGE AND TECHNOLOGY SELECTION

Determine the implementation language using this priority:

1. Explicit language or framework requested by the user.
2. Existing target file extension and surrounding implementation.
3. Established project technology and relevant dependencies.
4. A sensible default only when the request provides no stronger signal.

Respect the user's requested framework and library. Do not replace Pygame with a browser game, React with plain HTML, or an existing backend framework with another stack unless explicitly requested or technically necessary.

For vague requests where the user gives you freedom, choose the simplest suitable technology and explain the choice briefly in \`approach\`.

Do not introduce a new dependency when the standard library or an existing project dependency is sufficient. If a new library is necessary, identify it as a dependency requirement in the relevant plan description.

## 5. CONTINUATION AND PLAN MODIFICATION

When the user asks to add, modify, fix, or extend something already implemented:

- Identify the existing implementation and its relevant interfaces.
- Preserve previously requested features unless the user explicitly changes them.
- Update only the affected portions of the existing plan.
- Account for dependencies between the new change and existing functionality.
- Include regression verification when the modification could break existing behavior.
- Avoid recreating the application or changing its technology stack unnecessarily.
- Do not mark a feature as implemented merely because a previous plan included it.

When the user changes a requirement, distinguish the new requirement from existing requirements that remain valid.

If the user requests an investigation or verification rather than a modification, plan the inspection and verification first. Do not automatically rewrite code when diagnosis alone is requested.

## 6. TASK COMPLEXITY AND PLAN SIZE

Use the smallest plan that fully covers the task.

- Small, focused requests: 1–3 steps maximum.
- Medium tasks: usually 3–5 steps.
- Large, multi-module tasks: use as many steps as necessary, generally 4–8, without artificial decomposition.
- Bug fixes: identify the likely affected implementation, the required correction, and appropriate verification.
- Multi-file changes: respect dependency order.
- Test-only requests: focus on the requested tests and avoid unnecessary production-code changes.
- Investigation-only requests: inspect and report before proposing modifications.

Do not create one step per trivial operation. Do not combine unrelated changes into a vague step.

Each step must represent a meaningful, actionable unit of work.

## 7. STEP DESCRIPTION QUALITY

Every step must:

- Have a specific description of at least 10 characters.
- Identify the actual files, functions, classes, modules, or behavior to create or modify.
- Explain the technical purpose of the step.
- Include relevant dependency ordering.
- Describe a concrete implementation outcome.
- Be understandable to a coding agent without requiring it to infer the entire task from the original prompt.

Never use generic descriptions such as:
- "Implement requested functionality."
- "Write the code."
- "Fix the application."
- "Make necessary changes."
- A verbatim restatement of the user's request.

Prefer specific descriptions such as:
"Modify the existing StarCatcher update loop to spawn bonus stars at a lower frequency, apply type-specific collision effects, and remove collected objects safely."

## 8. DEPENDENCIES AND EXECUTION AWARENESS

Order steps so that prerequisites come before dependent implementation.

Consider, when relevant:

- Dependency installation and import compatibility.
- Existing interfaces and data models.
- Shared state and event handling.
- File paths and working-directory assumptions.
- Runtime entry points.
- Input/output behavior.
- Error handling and edge cases.
- Test execution and regression risks.
- Integration with existing agents and tools.

Do not add execution or testing steps mechanically to every trivial task. Include them when requested, necessary, or proportionate to the risk of the change.

If the request requires a graphical application, game, web page, or other interactive system, plan verification of actual behavior where the execution environment permits it. A successful build alone is not proof of functional correctness.

Do not claim that execution, tests, or browser verification have already succeeded. You only create the plan.

## 9. TESTING AND ACCEPTANCE CRITERIA

When testing is requested or necessary:

- Identify the specific behaviors that must be verified.
- Prefer existing test infrastructure.
- Add test files only when justified.
- Keep all targetFile paths within \`src/sandbox/\`.
- Include regression checks for important existing features affected by the change.
- Consider boundary cases and failure paths, not only successful execution.

Plan tests that verify actual behavior rather than merely checking whether a file exists or a function has been declared.

## 10. SECURITY AND SAFE DESIGN

Do not plan unsafe execution, unrestricted filesystem access, credential exposure, or bypasses of KAIZEN's permission controls.

For tasks involving destructive operations, external commands, Git mutations, network access, or sensitive information, preserve the existing security middleware, approval workflow, and sandbox restrictions.

Do not weaken security controls merely to make an implementation easier.

## 11. AMBIGUITY HANDLING

Do not ask unnecessary clarification questions.

If a reasonable, low-risk assumption allows progress, use it and briefly state it in \`approach\`.

If a missing requirement materially changes the architecture, security, expected behavior, or compatibility, identify the ambiguity rather than inventing a consequential requirement. Use the existing clarification mechanism if one is available. Otherwise, make the safest conservative plan and explicitly state the unresolved assumption in \`approach\`.

Do not invent unsupported fields in the output schema to request clarification.

## 12. STRICT OUTPUT CONTRACT

Return ONLY valid JSON. Do not include Markdown fences, introductory prose, comments, or trailing commas.

Use the following top-level structure:

{
  "approach": "A concise explanation of the chosen implementation strategy, relevant assumptions, and important constraints.",
  "steps": [
    {
      "description": "A concrete, technically specific implementation step of at least 10 characters.",
      "targetFile": "src/sandbox/relative/path/to/file.ext",
      "action": "create | modify | test",
      "dependsOn": [1]
    }
  ]
}

Output requirements:

- \`approach\` must be a non-empty string.
- \`steps\` must be a non-empty array of actionable steps.
- Every step must contain \`description\`, \`targetFile\`, and \`action\` ('create', 'modify', or 'test'). Optionally add \`dependsOn\`: 1-indexed numbers of earlier steps it needs.
- Every \`targetFile\` must start with \`src/sandbox/\`.
- Use only fields supported by the existing planner output schema.
- Do not add unrecognized fields such as \`priority\`, \`dependencies\`, \`language\`, or \`acceptanceCriteria\` unless the application schema explicitly supports them.
- Keep the plan minimal, complete, dependency-aware, and grounded in the supplied context.
- Ensure the JSON is syntactically valid and can be parsed by the downstream pipeline.

FINAL SELF-CHECK BEFORE RESPONDING:

1. Did I identify the user's actual intent?
2. Did I account for the existing workspace and preserve relevant behavior?
3. Did I choose the correct language and technology?
4. Are all targetFile paths compliant?
5. Are the steps concrete, ordered, and proportionate to task complexity?
6. Did I avoid duplicate files and unnecessary changes?
7. Does the JSON match the required schema exactly?

Return the final JSON plan only.`;


  const existingFilesContent: string[] = [];
  for (const targetPath of normalizedTargets) {
    const fullPath = workspaceManager.resolvePath(targetPath);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 50000);
        existingFilesContent.push(`--- FILE: ${targetPath} ---\n${content}`);
      } catch { }
    }
  }

  const symbolSummary = symbols.map(s => `${s.type} ${s.name} (${s.language})`).join(', ');
  const recentContext = extractedCtx.length > 12000 ? extractedCtx.slice(0, 12000) + '\n...[Context truncated for brevity]' : extractedCtx;

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

  if (isFeedback) {
    const currentPlanFormatted = state.plan && state.plan.length > 0
      ? state.plan.map((s, idx) => `Step ${s.id || idx + 1}: [Action: ${s.action || 'modify'}, Target: ${s.targetFile}] ${s.description}`).join('\n')
      : 'None';

    userPromptParts.push(`PREVIOUS PLAN BEING MODIFIED:\n${currentPlanFormatted}`);
    userPromptParts.push(`USER FEEDBACK / MODIFICATION INSTRUCTIONS:\n${feedbackText}`);
    userPromptParts.push(`MODIFICATION TASK:\nCarefully modify the previous plan to directly address and implement the user's feedback. You may modify existing steps, add new steps, remove unnecessary steps, or update file targets as required by the feedback.`);
  } else {
    if (rejectedPlans.length > 0) {
      userPromptParts.push(`PREVIOUSLY REJECTED PLANS (do NOT repeat these approaches or file structures):\n${rejectedPlans.map((p, i) => `Rejected Plan #${i + 1}: ${p}`).join('\n')}`);
    }

    if (state.rejectionReason) {
      userPromptParts.push(`USER REJECTION FEEDBACK:\n${state.rejectionReason}`);
    }
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
      
        if (cleanUserQuery.length > 20) {
          const lowerReq = cleanUserQuery.toLowerCase().replace(/\s+/g, ' ').trim();
          for (const step of planRes.steps) {
            const lowerDesc = step.description.toLowerCase().replace(/\s+/g, ' ').trim();
            const isExact = lowerDesc === lowerReq;
            const isNearCopy = computeJaccardSimilarity(lowerDesc, lowerReq) >= 0.9;
            if (isExact || isNearCopy) {
              return `Step description restates the user request verbatim: "${step.description}"`;
            }
          }
        }

        // Check similarity against rejected plans (do not check against modified plan when in feedback mode)
        if (!isFeedback) {
          const candidateSummary = planRes.steps
            .map(s => `[${normalizeSandboxPath(s.targetFile)}] ${s.description}`)
            .join(' | ');
          const candidate = parsePlanSummary(candidateSummary);

          for (const rejectedPlan of rejectedPlans) {
            const rejected = parsePlanSummary(rejectedPlan);

            // A different file layout is a legitimately different plan
            if (!sameFileSet(candidate.files, rejected.files)) continue;

            // Compare descriptions only (paths removed, boilerplate words ignored)
            const sim = computeJaccardSimilarity(candidate.text, rejected.text);
            if (sim > 0.75) {
              return `Candidate plan is too similar (Jaccard similarity ${sim.toFixed(2)} > 0.75) to a previously rejected plan: "${rejectedPlan}"`;
            }
          }
        }

        return null;
      }
    });

    const rawSteps = result.steps;
    const planSteps: PlanStep[] = rawSteps.map((step, idx) => {
      const normTarget = normalizeSandboxPath(step.targetFile);
      const isBlocked = isProtectedFile(normTarget);
      const fullPath = normTarget ? workspaceManager.resolvePath(normTarget) : '';
      const isNew = !fullPath || !fs.existsSync(fullPath);
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
    const uniqueTargetFiles = Array.from(new Set(planSteps.map(s => s.targetFile).filter((f): f is string => Boolean(f))));

    return {
      plan: planSteps,
      targetFiles: uniqueTargetFiles,
      planAttempt: attempt + 1,
      rejectedPlans,
      rejectionReason: undefined,
      planFeedback: undefined,
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