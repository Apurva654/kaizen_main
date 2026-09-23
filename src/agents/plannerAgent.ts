import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { KaizenState, PlanStep } from '../state';
import { ASTParserTool, ExtractedSymbol } from '../tools/astParser';
import { isProtectedFile } from './codeGenAgent';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export function normalizeSandboxPath(pathStr: string): string {
  if (!pathStr) return 'src/sandbox/main.ts';
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

export const StepObjectSchema = z.object({
  id: z.number().optional().describe("Unique sequential step identifier"),
  step_number: z.number().optional().describe("Step number"),
  description: z.string().describe("Detailed, actionable task description explaining what will be created, modified, or tested"),
  task: z.string().optional().describe("Detailed task description"),
  targetFile: z.string().nullable().optional().describe("Target source file path for this step (must be under src/sandbox/...)"),
  action: z.string().nullable().optional().describe("Action type (create, modify, test)"),
  isNewFile: z.boolean().nullable().optional().describe("Whether target file is new"),
  assignedTool: z.string().nullable().optional().describe("Tool or agent module")
});

export const StepItemSchema = z.union([
  z.string().describe("Actionable task description string for this step"),
  StepObjectSchema
]);

export const PlannerSchema = z.object({
  steps: z.array(StepItemSchema).describe("List of detailed sequential implementation steps"),
  plan: z.array(StepItemSchema).optional().describe("List of detailed sequential implementation steps")
});

function extractSymbolsFromWorkspace(targetFiles: string[], extractedContext: string, astParser: ASTParserTool): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];
  const seenNames = new Set<string>();

  for (const tf of targetFiles) {
    if (fs.existsSync(tf)) {
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

export async function plannerAgentNode(state: typeof KaizenState.State) {
  const targetFiles = (state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox/main.ts'])
    .map(f => normalizeSandboxPath(f));

  const existingFiles = targetFiles.filter(tf => fs.existsSync(tf));
  const newFiles = targetFiles.filter(tf => !fs.existsSync(tf));

  const astParser = new ASTParserTool();
  const extractedSymbols = extractSymbolsFromWorkspace(existingFiles, state.extractedContext, astParser);

  const symbolSummary = extractedSymbols.length > 0
    ? extractedSymbols.map((s: ExtractedSymbol) => `- [${s.language || 'code'}] ${s.type} ${s.name}`).join('\n')
    : "No existing file AST symbols pre-extracted.";

  const cleanUserQuery = state.originalUserRequest || state.userInput;

  console.log(`[PLANNER][INPUT] originalUserRequest: "${state.originalUserRequest}"`);
  console.log(`[PLANNER][INPUT] userInput: "${state.userInput}"`);
  console.log(`[PLANNER][INPUT] cleanUserQuery: "${cleanUserQuery}"`);
  console.log(`[PLANNER][INPUT] targetFiles: [${targetFiles.join(', ')}]`);
  console.log(`[PLANNER][CONTEXT] extractedContext length: ${state.extractedContext.length} chars`);

  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    const modelCandidates = [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant'
    ];

    for (const modelName of modelCandidates) {
      try {
        const model = new ChatGroq({
          apiKey: apiKey,
          model: modelName,
          temperature: 0
        });

        const structuredModel = model.withStructuredOutput(PlannerSchema, { method: 'jsonMode' });

        const systemPrompt = `You are an expert technical software planner for Kaizen AI.
Construct a grounded, step-by-step implementation plan for the user request. Respond in valid JSON format.

=== ORIGINAL USER REQUEST ===
${cleanUserQuery}

=== WORKSPACE CONTEXT ===
Target Directory: src/sandbox/
Existing Files: ${existingFiles.length > 0 ? existingFiles.join(', ') : 'None'}
New Files to Create: ${newFiles.length > 0 ? newFiles.join(', ') : 'None'}

=== RELEVANT FILES ===
${targetFiles.join(', ')}

=== AST/SYMBOL CONTEXT ===
${symbolSummary}

=== GRAPHIFY DEPENDENCIES ===
${(state.extractedContext || "No context provided.").slice(-4000)}

=== CONSTRAINTS ===
1. All target files MUST reside inside 'src/sandbox/' (e.g., 'src/sandbox/OOPSsample.cpp').
2. ADAPTIVE GRANULARITY: For simple requests, quick scripts, C++/Python files, or refactoring tasks (e.g. removing comments, fixing namespace, adding functions), generate concise 1-3 targeted steps. Do NOT force 6-step enterprise web architecture (models/repositories/controllers) unless the user explicitly requests an enterprise multi-module system.
3. Every step MUST include an explicit targetFile under 'src/sandbox/'.
4. Do NOT modify any files on disk during planning.

=== PLANNING REQUIREMENTS ===
1. Produce grounded, actionable steps with targetFile, action, isNewFile, and dependencies.
2. Step Descriptions must be clear, concise, and professional without repeating raw user prompts or using internal class names like ASTParserTool.`;

        const startTime = Date.now();
        const invokePromise = structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: cleanUserQuery }
        ]);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`ChatGroq model '${modelName}' execution timed out after 8000ms`)), 8000);
        });

        const result = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        console.log(`[PLANNER][LLM_RAW] Model '${modelName}' returned structured output successfully in ${latencyMs}ms.`);

        await langfuseTracer.recordGeneration(
          'PlannerAgent',
          modelName,
          cleanUserQuery,
          JSON.stringify(result),
          latencyMs,
          120,
          250
        );

        const rawSteps = (result && (result.steps || result.plan)) || [];
        if (rawSteps.length > 0) {
          const parsedSteps: Array<{ id: number; description: string; targetFile: string; isNewFile?: boolean }> = [];

          for (let idx = 0; idx < rawSteps.length; idx++) {
            const step = rawSteps[idx];
            let desc = typeof step === 'string'
              ? step
              : (step.description || step.task || (step as any).details || step.action || (step as any).text || (step as any).summary);

            if (desc && (desc.includes('ASTParserTool') || desc.includes('GraphifyEngine') || desc.includes('AST Context Verified'))) {
              desc = idx === 0 ? `Inspect workspace structure and models in ${targetFiles[0]}` : `Implement module logic for query: "${cleanUserQuery.slice(0, 50)}"`;
            }

            if (!desc || desc.trim().toLowerCase() === 'step 1' || desc.trim().toLowerCase() === `step ${idx + 1}`) {
              desc = `Implement step ${idx + 1} for query: "${cleanUserQuery.slice(0, 50)}"`;
            }

            let stepTargetFile = (typeof step === 'object' && step?.targetFile) ? step.targetFile : undefined;

            // Extract file path from description string if omitted
            if (!stepTargetFile && desc) {
              const pathMatch = desc.match(/\b(src\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+|\b[a-zA-Z0-9_\-]+\.(ts|py|js|tsx|jsx|json))\b/i);
              if (pathMatch && pathMatch[1]) {
                stepTargetFile = pathMatch[1];
              }
            }

            if (!stepTargetFile) {
              stepTargetFile = targetFiles[Math.min(idx, targetFiles.length - 1)];
            }

            const normalizedTarget = normalizeSandboxPath(stepTargetFile);

            const stepId = (typeof step === 'object' && (step?.id || step?.step_number)) ? (step.id || step.step_number || (idx + 1)) : (idx + 1);

            parsedSteps.push({
              id: stepId,
              description: desc,
              targetFile: normalizedTarget,
              isNewFile: (typeof step === 'object' && step?.isNewFile !== undefined) ? !!step.isNewFile : !fs.existsSync(normalizedTarget)
            });
          }

          // Plan Validation: Detect single-file collapse on multi-step plans (>3 steps)
          const uniqueTargetFiles = new Set(parsedSteps.map(s => s.targetFile));
          if (parsedSteps.length > 3 && uniqueTargetFiles.size === 1) {
            console.warn(`[PLANNER][VALIDATION] Detected ${parsedSteps.length} steps collapsed into single file '${Array.from(uniqueTargetFiles)[0]}'. Auto-decomposing modular targets...`);

            parsedSteps.forEach((step, idx) => {
              const d = step.description.toLowerCase();
              if (d.includes('user') || d.includes('auth') || d.includes('profile')) {
                step.targetFile = 'src/sandbox/models/User.ts';
              } else if (d.includes('registration') || d.includes('attendee')) {
                step.targetFile = 'src/sandbox/models/Registration.ts';
              } else if (d.includes('repo') || d.includes('storage') || d.includes('db')) {
                step.targetFile = d.includes('user') ? 'src/sandbox/repositories/UserRepository.ts' : 'src/sandbox/repositories/OrderRepository.ts';
              } else if (d.includes('service') || d.includes('business')) {
                step.targetFile = d.includes('attendee') ? 'src/sandbox/services/AttendeeService.ts' : 'src/sandbox/services/OrderService.ts';
              } else if (d.includes('notification') || d.includes('email')) {
                step.targetFile = 'src/sandbox/notifications/NotificationService.ts';
              } else if (d.includes('controller') || d.includes('route') || d.includes('api')) {
                step.targetFile = 'src/sandbox/controllers/OrderController.ts';
              } else if (d.includes('test') || d.includes('spec') || d.includes('verify')) {
                step.targetFile = 'src/sandbox/tests/OrderService.test.ts';
              } else {
                step.targetFile = `src/sandbox/models/Order.ts`;
              }
            });
          }

          const verifiedSteps: PlanStep[] = parsedSteps.map((step, idx) => {
            const isBlocked = isProtectedFile(step.targetFile);
            const actionType = step.isNewFile ? 'create' : (step.targetFile.includes('/tests/') || step.targetFile.includes('.test.') ? 'test' : 'modify');
            return {
              id: step.id,
              targetFile: step.targetFile,
              action: actionType,
              isNewFile: step.isNewFile,
              dependencies: idx > 0 ? [parsedSteps[idx - 1].targetFile] : [],
              description: isBlocked
                ? `[GUARDRAIL BLOCKED] Security Policy Violation for '${step.targetFile}': ${step.description}`
                : step.description,
              status: isBlocked ? 'failed' : 'pending'
            };
          });

          console.log(`[PLANNER][NORMALIZED] Produced ${verifiedSteps.length} steps across targets: [${Array.from(new Set(verifiedSteps.map(s => s.targetFile))).join(', ')}]`);

          return {
            plan: verifiedSteps,
            targetFiles: Array.from(new Set(verifiedSteps.map(s => s.targetFile!))),
            status: verifiedSteps.some(s => s.status === 'failed') ? "SECURITY_VIOLATION_BLOCKED" : "PLANNED"
          };
        }
      }
      catch (error: any) {
        console.warn(`[PLANNER][GROQ_WARN] Model '${modelName}' execution failed: ${error?.message || error}`);
      }
    }
  }

  console.warn(`[PLANNER][FALLBACK] Groq API models unavailable or timed out. Generating dynamic modular fallback plan for query: "${cleanUserQuery}"`);

  const fallbackSteps = buildModularFallbackPlan(cleanUserQuery, targetFiles);
  const fallbackTargets = Array.from(new Set(fallbackSteps.map(s => s.targetFile!)));

  console.log(`[PLANNER][FINAL_STATE] Fallback plan generated ${fallbackSteps.length} modular steps across: [${fallbackTargets.join(', ')}]`);

  return {
    plan: fallbackSteps,
    targetFiles: fallbackTargets,
    status: "PLANNED"
  };
}

function formatSmartStepDescription(userQuery: string, targetFile: string, idx: number): string {
  const queryLower = userQuery.toLowerCase().trim();

  if (queryLower.includes('remove std') || queryLower.includes('using namespace std')) {
    return `Refactor \`using namespace std;\` in ${targetFile}`;
  }
  if (queryLower.includes('remove comment') || queryLower.includes('delete comment') || queryLower.includes('clean comment')) {
    return `Remove inline comments and clean code in ${targetFile}`;
  }
  if (queryLower.includes('oops') || queryLower.includes('class') || queryLower.includes('object')) {
    return `Implement Object-Oriented C++ structure in ${targetFile}`;
  }
  if (queryLower.includes('description') || queryLower.includes('nole')) {
    return `Write character description and utility logic in ${targetFile}`;
  }

  let verb = 'Implement';
  if (/\b(add|create|make|write|generate)\b/i.test(queryLower)) verb = 'Create';
  else if (/\b(remove|delete|clean|clear|strip)\b/i.test(queryLower)) verb = 'Refactor';
  else if (/\b(fix|debug|repair|correct)\b/i.test(queryLower)) verb = 'Fix';
  else if (/\b(update|modify|change|edit)\b/i.test(queryLower)) verb = 'Update';
  else if (/\b(test|spec|verify)\b/i.test(queryLower)) verb = 'Test';

  let subject = userQuery.replace(/^(please|pls|can you|help me|make|create|write|add|remove|delete|update|fix)\s+/i, '').slice(0, 40).trim();
  if (!subject) subject = 'requested changes';

  return `${verb} ${subject} in ${targetFile}`;
}

function buildModularFallbackPlan(userQuery: string, targetFiles: string[]): PlanStep[] {
  const queryLower = userQuery.toLowerCase();

  // Check if target file or prompt specifies non-TypeScript language (C++, Python, Java, Rust, Go, C#, PHP)
  const isCpp = /\b(c\+\+|cpp|cplusplus)\b/i.test(queryLower) || targetFiles.some(f => f.endsWith('.cpp') || f.endsWith('.h') || f.endsWith('.hpp'));
  const isPython = /\b(python|py)\b/i.test(queryLower) || targetFiles.some(f => f.endsWith('.py'));
  const isJava = /\b(java)\b/i.test(queryLower) || targetFiles.some(f => f.endsWith('.java'));
  const isRust = /\b(rust|rs)\b/i.test(queryLower) || targetFiles.some(f => f.endsWith('.rs'));
  const isGo = /\b(golang|go)\b/i.test(queryLower) || targetFiles.some(f => f.endsWith('.go'));

  if (isCpp || isPython || isJava || isRust || isGo || (targetFiles.length > 0 && !targetFiles[0].endsWith('.ts'))) {
    let mainTarget = targetFiles[0];
    if (!mainTarget || mainTarget.endsWith('.ts')) {
      const ext = isCpp ? '.cpp' : (isPython ? '.py' : (isJava ? '.java' : (isRust ? '.rs' : (isGo ? '.go' : '.cpp'))));
      const slug = userQuery.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'solution';
      mainTarget = `src/sandbox/${slug}${ext}`;
    }

    const steps: PlanStep[] = targetFiles.length > 0 ? targetFiles.map((tf, idx) => ({
      id: idx + 1,
      targetFile: tf,
      action: fs.existsSync(tf) ? 'modify' : 'create',
      isNewFile: !fs.existsSync(tf),
      dependencies: idx > 0 ? [targetFiles[idx - 1]] : [],
      description: formatSmartStepDescription(userQuery, tf, idx),
      status: 'pending'
    })) : [
      {
        id: 1,
        targetFile: mainTarget,
        action: 'create',
        isNewFile: !fs.existsSync(mainTarget),
        dependencies: [],
        description: formatSmartStepDescription(userQuery, mainTarget, 0),
        status: 'pending'
      }
    ];

    return steps;
  }

  // If target files exist or specific target files are provided, create concise targeted plan steps
  const validTargets = targetFiles.length > 0 ? targetFiles : ['src/sandbox/main.ts'];
  
  // Check if query asks for a small edit / modification (e.g. remove comments, add feature, refactor)
  const isModification = /\b(add|remove|fix|update|modify|change|refactor|clean|namespace|comment|comments|use|using)\b/i.test(queryLower);

  if (isModification || validTargets.length <= 2) {
    const steps: PlanStep[] = validTargets.map((tf, idx) => ({
      id: idx + 1,
      targetFile: tf,
      action: fs.existsSync(tf) ? 'modify' : 'create',
      isNewFile: !fs.existsSync(tf),
      dependencies: idx > 0 ? [validTargets[idx - 1]] : [],
      description: formatSmartStepDescription(userQuery, tf, idx),
      status: 'pending'
    }));
    return steps;
  }

  // Enterprise multi-module fallback ONLY if user explicitly requests domain architecture
  const entityMatch = queryLower.match(/\b(order|event|user|product|item|inventory|payment|registration|auth|notification|customer|booking)\b/i);
  const rawEntity = entityMatch ? entityMatch[1] : 'App';
  const entity = rawEntity.charAt(0).toUpperCase() + rawEntity.slice(1);

  const mainFile = `src/sandbox/${entity.toLowerCase()}Service.ts`;
  const testFile = `src/sandbox/tests/${entity.toLowerCase()}.test.ts`;

  return [
    {
      id: 1,
      targetFile: mainFile,
      action: 'create',
      isNewFile: !fs.existsSync(mainFile),
      dependencies: [],
      description: formatSmartStepDescription(userQuery, mainFile, 0),
      status: 'pending'
    },
    {
      id: 2,
      targetFile: testFile,
      action: 'test',
      isNewFile: !fs.existsSync(testFile),
      dependencies: [mainFile],
      description: `Implement unit test suite for ${entity} module`,
      status: 'pending'
    }
  ];
}
