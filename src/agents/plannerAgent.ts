import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import { KaizenState, PlanStep } from '../state';
import { ASTParserTool, ExtractedSymbol } from '../tools/astParser';
import { isProtectedFile } from './codeGenAgent';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const StepObjectSchema = z.object({
  id: z.number().optional().describe("Unique sequential step identifier"),
  step_number: z.number().optional().describe("Step number"),
  description: z.string().describe("Detailed, actionable task description explaining what will be created, modified, or tested"),
  task: z.string().optional().describe("Detailed task description"),
  targetFile: z.string().nullable().optional().describe("Target source file path for this step"),
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

  // 1. Parse target files directly from filesystem if available
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

  // 2. Parse file blocks from extractedContext
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
  const targetFiles = state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox/main.ts'];

  const existingFiles = targetFiles.filter(tf => fs.existsSync(tf));
  const newFiles = targetFiles.filter(tf => !fs.existsSync(tf));

  const astParser = new ASTParserTool();
  // Parse AST symbols ONLY for existing files in workspace
  const extractedSymbols = extractSymbolsFromWorkspace(existingFiles, state.extractedContext, astParser);

  const symbolSummary = extractedSymbols.length > 0
    ? extractedSymbols.map((s: ExtractedSymbol) => `- [${s.language || 'code'}] ${s.type} ${s.name}`).join('\n')
    : "No existing file AST symbols pre-extracted.";

  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    const modelCandidates = [
      'openai/gpt-oss-120b',
      'groq/compound-mini',
      'qwen/qwen3.8-27b',
      'openai/gpt-oss-20b'
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
Analyze the user prompt, target files, AST symbol facts, and full workspace context below to construct a grounded, step-by-step implementation plan. Respond in valid json format.
Do NOT invent non-existent files or hallucinate steps. Base your plan directly on the target files, source code, and dependency context provided.

=== WORKSPACE TARGET FILES ===
Target Files: ${targetFiles.join(', ')}
New Files to Create: ${newFiles.length > 0 ? newFiles.join(', ') : 'None'}
Existing Workspace Files: ${existingFiles.length > 0 ? existingFiles.join(', ') : 'None'}

=== EXTRACTED AST SYMBOLS (EXISTING FILES ONLY) ===
${symbolSummary}

=== WORKSPACE GRAPH & SOURCE CONTEXT ===
${state.extractedContext || "No context provided."}

MANDATES FOR PLAN GENERATION:
1. For NEW target files that do not exist in the workspace yet (e.g., ${newFiles.join(', ') || 'new files'}), generate implementation steps stating file creation and function/class implementation.
2. Do NOT output internal context retrieval or tool names (such as 'ASTParserTool', 'GraphifyEngine', or 'AST extraction') as user-facing implementation steps.
3. Do NOT execute, modify, or write to any files on disk during planning. Planner only outputs a proposed implementation plan for developer approval.

Create a structured list of logical, sequential implementation steps.`;

        const startTime = Date.now();
        const invokePromise = structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: state.userInput }
        ]);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`ChatGroq model '${modelName}' execution timed out after 8000ms`)), 8000);
        });

        const result = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        await langfuseTracer.recordGeneration(
          'PlannerAgent',
          modelName,
          state.userInput,
          JSON.stringify(result),
          latencyMs,
          120,
          250
        );

        const rawSteps = (result && (result.steps || result.plan)) || [];
        if (rawSteps.length > 0) {
          const verifiedSteps: PlanStep[] = rawSteps.map((step: any, idx: number) => {
            let desc = typeof step === 'string'
              ? step
              : (step.description || step.task || step.details || step.action || step.text || step.summary);

            // Strip internal tool references if generated by LLM
            if (desc && (desc.includes('ASTParserTool') || desc.includes('GraphifyEngine') || desc.includes('AST Context Verified'))) {
              if (newFiles.length > 0) {
                desc = `Create ${newFiles[0]} in the workspace`;
              } else {
                desc = `Inspect existing workspace structure and code in ${targetFiles[0]}`;
              }
            }

            if (!desc || desc.trim().toLowerCase() === 'step 1' || desc.trim().toLowerCase() === `step ${idx + 1}`) {
              if (idx === 0) {
                desc = newFiles.length > 0 
                  ? `Create ${newFiles[0]} in the workspace`
                  : `Inspect workspace structure and existing symbols in ${targetFiles[0]}`;
              } else if (idx === 1) {
                desc = `Implement core requested functionality for query: "${state.userInput.slice(0, 60)}"`;
              } else {
                desc = `Verify code patches and ensure zero syntax/security regressions in ${targetFiles[0]}`;
              }
            }

            const fileToCheck = (typeof step === 'object' && step?.targetFile) ? step.targetFile : targetFiles[0];
            const isBlocked = isProtectedFile(fileToCheck);

            return {
              id: (typeof step === 'object' && (step?.id || step?.step_number)) ? (step.id || step.step_number) : (idx + 1),
              description: isBlocked
                ? `[GUARDRAIL BLOCKED] Security Policy Violation for '${fileToCheck}': ${desc}`
                : desc,
              status: idx === 0 ? 'completed' : (isBlocked ? 'failed' : 'pending')
            };
          });

          return {
            plan: verifiedSteps,
            status: verifiedSteps.some(s => s.status === 'failed') ? "SECURITY_VIOLATION_BLOCKED" : "PLANNED"
          };
        }
      } 
      catch (error: any) {
        console.warn(`ChatGroq planner model '${modelName}' execution failed:`, error?.message || error);
      }
    }
  }

  const firstTarget = targetFiles[0];
  const firstTargetExists = fs.existsSync(firstTarget);

  const fallbackSteps: PlanStep[] = firstTargetExists
    ? [
        {
          id: 1,
          description: `Inspect existing workspace structure and code in ${firstTarget}`,
          status: 'completed'
        },
        {
          id: 2,
          description: `Implement requested refactoring/features for query: "${state.userInput.slice(0, 60)}"`,
          status: 'pending'
        },
        {
          id: 3,
          description: `Verify updated code and ensure zero syntax/security regressions in ${firstTarget}`,
          status: 'pending'
        }
      ]
    : [
        {
          id: 1,
          description: `Create ${firstTarget} in the workspace`,
          status: 'completed'
        },
        {
          id: 2,
          description: `Implement requested functions and module structure for query: "${state.userInput.slice(0, 60)}"`,
          status: 'pending'
        },
        {
          id: 3,
          description: `Verify syntax, type annotations, and module exports in ${firstTarget}`,
          status: 'pending'
        }
      ];

  return {
    plan: fallbackSteps,
    status: "PLANNED"
  };
}



