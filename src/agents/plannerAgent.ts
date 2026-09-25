import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
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
      } catch {}
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
  const cleanUserQuery = state.originalUserRequest || state.userInput;
  const isWebReq = /\b(html|website|webpage|landing\s+page|web|frontend)\b/i.test(cleanUserQuery) ||
    state.targetFiles.some(f => f.endsWith('.html'));

  let rawTargets = state.targetFiles.length > 0
    ? state.targetFiles
    : (isWebReq ? ['src/sandbox/index.html', 'src/sandbox/style.css', 'src/sandbox/script.js'] : ['src/sandbox/main.ts']);

  if (isWebReq) {
    const hasCss = rawTargets.some(f => f.endsWith('.css'));
    const hasJs = rawTargets.some(f => f.endsWith('.js'));
    if (!hasCss) rawTargets.push('src/sandbox/style.css');
    if (!hasJs) rawTargets.push('src/sandbox/script.js');
  }

  const targetFiles = Array.from(new Set(rawTargets)).map(f => normalizeSandboxPath(f));

  const existingFiles = targetFiles.filter(tf => fs.existsSync(tf));
  const newFiles = targetFiles.filter(tf => !fs.existsSync(tf));

  const astParser = new ASTParserTool();
  const extractedSymbols = extractSymbolsFromWorkspace(existingFiles, state.extractedContext, astParser);

  const symbolSummary = extractedSymbols.length > 0
    ? extractedSymbols.map((s: ExtractedSymbol) => `- [${s.language || 'code'}] ${s.type} ${s.name}`).join('\n')
    : "No existing file AST symbols pre-extracted.";

  console.log(`[PLANNER][INPUT] originalUserRequest: "${state.originalUserRequest}"`);
  console.log(`[PLANNER][INPUT] userInput: "${state.userInput}"`);
  console.log(`[PLANNER][INPUT] cleanUserQuery: "${cleanUserQuery}"`);
  console.log(`[PLANNER][INPUT] targetFiles: [${targetFiles.join(', ')}]`);
  console.log(`[PLANNER][CONTEXT] extractedContext length: ${state.extractedContext.length} chars`);

  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    const modelCandidates = [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'mixtral-8x7b-32768',
      'gemma2-9b-it'
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
1. All target files MUST reside inside 'src/sandbox/' (e.g., 'src/sandbox/models/Order.ts').
2. Do NOT collapse modular architectures (such as Order/Event management) into a single file. Decompose into models, repositories, services, controllers, and unit tests.
3. Every step MUST include an explicit targetFile under 'src/sandbox/'.
4. Do NOT modify any files on disk during planning.

=== PLANNING REQUIREMENTS ===
1. Produce modular steps with targetFile, action, isNewFile, and dependencies.
2. Step Descriptions must be clear and actionable without using internal class names like ASTParserTool.`;

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
              : (step.description || step.task || step.details || step.action || step.text || step.summary);

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

            parsedSteps.push({
              id: (typeof step === 'object' && (step?.id || step?.step_number)) ? (step.id || step.step_number) : (idx + 1),
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

function buildModularFallbackPlan(userQuery: string, targetFiles: string[]): PlanStep[] {
  const queryLower = userQuery.toLowerCase();
  
  const isWebProject = /\b(html|website|webpage|landing\s+page|web|frontend)\b/i.test(queryLower) ||
    targetFiles.some(f => f.endsWith('.html') || f.endsWith('.css'));

  if (isWebProject) {
    const htmlFile = 'src/sandbox/index.html';
    const cssFile = 'src/sandbox/style.css';
    const jsFile = 'src/sandbox/script.js';

    return [
      {
        id: 1,
        targetFile: htmlFile,
        action: 'create',
        isNewFile: !fs.existsSync(htmlFile),
        dependencies: [],
        description: `Create semantic HTML5 landing page structure in ${htmlFile} with hero section, features grid, call to action, and footer`,
        status: 'pending'
      },
      {
        id: 2,
        targetFile: cssFile,
        action: 'create',
        isNewFile: !fs.existsSync(cssFile),
        dependencies: [htmlFile],
        description: `Create responsive CSS styling in ${cssFile} with modern typography, dark mode theme, glassmorphism card layouts, and hover effects`,
        status: 'pending'
      },
      {
        id: 3,
        targetFile: jsFile,
        action: 'create',
        isNewFile: !fs.existsSync(jsFile),
        dependencies: [htmlFile, cssFile],
        description: `Create interactive JavaScript behavior in ${jsFile} for dynamic button interactions, form validation, and animations`,
        status: 'pending'
      }
    ];
  }

  const entityMatch = queryLower.match(/\b(order|event|user|product|item|inventory|payment|registration|auth|notification|customer|booking)\b/i);

  if (entityMatch) {
    const rawEntity = entityMatch[1];
    const entity = rawEntity.charAt(0).toUpperCase() + rawEntity.slice(1);

    const modelFile = `src/sandbox/models/${entity}.ts`;
    const typeFile = `src/sandbox/types/${entity.toLowerCase()}Types.ts`;
    const repoFile = `src/sandbox/repositories/${entity}Repository.ts`;
    const serviceFile = `src/sandbox/services/${entity}Service.ts`;
    const controllerFile = `src/sandbox/controllers/${entity}Controller.ts`;
    const testFile = `src/sandbox/tests/${entity}Service.test.ts`;

    return [
      {
        id: 1,
        targetFile: modelFile,
        action: 'create',
        isNewFile: !fs.existsSync(modelFile),
        dependencies: [],
        description: `Define core ${entity} domain data model structure, properties, and interface contracts`,
        status: 'pending'
      },
      {
        id: 2,
        targetFile: typeFile,
        action: 'create',
        isNewFile: !fs.existsSync(typeFile),
        dependencies: [modelFile],
        description: `Create shared TypeScript types, enums, status codes, and error definitions for ${entity} management`,
        status: 'pending'
      },
      {
        id: 3,
        targetFile: repoFile,
        action: 'create',
        isNewFile: !fs.existsSync(repoFile),
        dependencies: [modelFile, typeFile],
        description: `Implement ${entity}Repository for data storage operations, queries, and persistence management`,
        status: 'pending'
      },
      {
        id: 4,
        targetFile: serviceFile,
        action: 'create',
        isNewFile: !fs.existsSync(serviceFile),
        dependencies: [repoFile],
        description: `Implement ${entity}Service containing core business logic, validation rules, and operations`,
        status: 'pending'
      },
      {
        id: 5,
        targetFile: controllerFile,
        action: 'create',
        isNewFile: !fs.existsSync(controllerFile),
        dependencies: [serviceFile],
        description: `Implement ${entity}Controller route handlers and API request/response processing`,
        status: 'pending'
      },
      {
        id: 6,
        targetFile: testFile,
        action: 'test',
        isNewFile: !fs.existsSync(testFile),
        dependencies: [serviceFile],
        description: `Implement ${entity}Service automated unit tests verifying business logic and edge cases`,
        status: 'pending'
      }
    ];
  }

  const steps: PlanStep[] = [];
  const normalizedTargets = targetFiles.length > 0 ? targetFiles.map(normalizeSandboxPath) : ['src/sandbox/main.ts'];

  for (let idx = 0; idx < normalizedTargets.length; idx++) {
    const tf = normalizedTargets[idx];
    const isTest = tf.includes('/tests/') || tf.includes('.test.') || tf.includes('/test_') || tf.startsWith('src/sandbox/test_');
    const ext = path.extname(tf);
    const fileName = path.basename(tf);

    let desc = '';
    if (isTest) {
      if (ext === '.py') {
        desc = `Create pytest automated unit tests in ${fileName} to verify implementation`;
      } else {
        desc = `Create automated unit tests in ${fileName} to verify module logic`;
      }
    } else {
      if (queryLower.includes('divide')) {
        desc = `Implement function divide(a, b) returning a / b in ${fileName}`;
      } else {
        desc = `Implement core functionality and exported symbols in ${fileName} for request: "${userQuery.slice(0, 60)}"`;
      }
    }

    steps.push({
      id: idx + 1,
      targetFile: tf,
      action: !fs.existsSync(tf) ? 'create' : (isTest ? 'test' : 'modify'),
      isNewFile: !fs.existsSync(tf),
      dependencies: idx > 0 ? [normalizedTargets[idx - 1]] : [],
      description: desc,
      status: 'pending'
    });
  }

  return steps;
}
