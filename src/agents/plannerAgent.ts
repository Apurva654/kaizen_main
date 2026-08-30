import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { KaizenState, PlanStep } from '../state';
import { ASTParserTool, ExtractedSymbol } from '../tools/astParser';
import { isProtectedFile } from './codeGenAgent';

dotenv.config();

export const StepSchema = z.object({
  id: z.number().describe("Unique sequential step identifier"),
  description: z.string().describe("Detailed, actionable task description"),
  targetFile: z.string().optional().describe("Target source file associated with this task"),
  assignedTool: z.string().optional().describe("Tool or agent module assigned to execute this step")
});

export const PlannerSchema = z.object({
  steps: z.array(StepSchema).describe("Step-by-step implementation tasks derived from AST context and user requirements")
});

export async function plannerAgentNode(state: typeof KaizenState.State) {
  const targetFiles = state.targetFiles.length > 0 ? state.targetFiles : ['src/index.ts'];

  const astParser = new ASTParserTool();
  const extractedSymbols = state.extractedContext
    ? astParser.extractTopLevelSymbols(state.extractedContext)
    : [];

  const symbolSummary = extractedSymbols.length > 0
    ? extractedSymbols.map((s: ExtractedSymbol) => `- ${s.type} ${s.name}`).join('\n')
    : "No AST symbols pre-extracted. Target files: " + targetFiles.join(', ');

  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    try {
      const model = new ChatGroq({
        apiKey: apiKey,
        model: 'openai/gpt-oss-120b',
        temperature: 0
      });

      const structuredModel = model.withStructuredOutput(PlannerSchema);

      const systemPrompt = `You are an expert technical software planner for Kaizen AI.
Analyze the user prompt, target files, and AST symbol facts below to construct a grounded, step-by-step implementation plan.
Do NOT invent non-existent files or hallucinate steps.

=== WORKSPACE AST FACTS ===
Target Files: ${targetFiles.join(', ')}
Extracted Symbols:
${symbolSummary}

Create a structured list of logical, sequential implementation steps.`;

      const result = await structuredModel.invoke([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: state.userInput }
      ]);

      if (result && result.steps && result.steps.length > 0) {
        const verifiedSteps: PlanStep[] = result.steps.map((step: z.infer<typeof StepSchema>, idx: number) => {
          const fileToCheck = step.targetFile || targetFiles[0];
          const isBlocked = isProtectedFile(fileToCheck);

          return {
            id: step.id || (idx + 1),
            description: isBlocked
              ? `[GUARDRAIL BLOCKED] Security Policy Violation for '${fileToCheck}': ${step.description}`
              : step.description,
            status: idx === 0 ? 'completed' : (isBlocked ? 'failed' : 'pending')
          };
        });

        return {
          plan: verifiedSteps,
          status: "PLANNED"
        };
      }
    } catch (error) {
      console.warn("ChatGroq planner execution failed, falling back to tool-guided plan:", error);
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
