import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { KaizenState, PlanStep } from '../state';
import { ASTParserTool, ExtractedSymbol } from '../tools/astParser';
import { isProtectedFile } from './codeGenAgent';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const StepItemSchema = z.union([
  z.string(),
  z.object({
    id: z.number().optional().describe("Unique sequential step identifier"),
    step_number: z.number().optional().describe("Step number"),
    description: z.string().optional().describe("Detailed task description"),
    task: z.string().optional().describe("Detailed task description"),
    targetFile: z.string().nullable().optional().describe("Target source file"),
    assignedTool: z.string().nullable().optional().describe("Tool or agent module")
  })
]);

export const PlannerSchema = z.object({
  steps: z.array(StepItemSchema).optional().describe("Step-by-step implementation tasks"),
  plan: z.array(StepItemSchema).optional().describe("Step-by-step implementation tasks")
});

export async function plannerAgentNode(state: typeof KaizenState.State) {
  const targetFiles = state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox/main.ts'];

  const astParser = new ASTParserTool();
  const extractedSymbols = state.extractedContext
    ? astParser.extractTopLevelSymbols(state.extractedContext)
    : [];

  const symbolSummary = extractedSymbols.length > 0
    ? extractedSymbols.map((s: ExtractedSymbol) => `- ${s.type} ${s.name}`).join('\n')
    : "No AST symbols pre-extracted. Target files: " + targetFiles.join(', ');

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
Analyze the user prompt, target files, and AST symbol facts below to construct a grounded, step-by-step implementation plan. Respond in valid json format.
Do NOT invent non-existent files or hallucinate steps.

=== WORKSPACE AST FACTS ===
Target Files: ${targetFiles.join(', ')}
Extracted Symbols:
${symbolSummary}

Create a structured list of logical, sequential implementation steps.`;

        const startTime = Date.now();
        const result = await structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: state.userInput }
        ]);
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
            const desc = typeof step === 'string'
              ? step
              : (step.description || step.task || `Step ${idx + 1}`);
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

  const fallbackSteps: PlanStep[] = [
    {
      id: 1,
      description: `Analyze input: "${state.userInput}" against target files (${targetFiles.join(', ')})`,
      status: 'completed'
    },
    {
      id: 2,
      description: extractedSymbols.length > 0
        ? `AST Context Verified: Found ${extractedSymbols.length} top-level symbol(s) (${extractedSymbols.slice(0, 3).map((s: ExtractedSymbol) => s.name).join(', ')})`
        : `Extract syntax & symbol references via ASTParserTool for ${targetFiles[0]}`,
      status: 'pending'
    },
    {
      id: 3,
      description: `Draft and apply target modifications to ${targetFiles[0]}`,
      status: 'pending'
    }
  ];

  return {
    plan: fallbackSteps,
    status: "PLANNED"
  };
}
