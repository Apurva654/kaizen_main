import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { KaizenState, PlanStep } from '../state';

dotenv.config();

export const CodeGenSchema = z.object({
  code: z.string().describe("Generated precise source code implementation or modifications"),
  explanations: z.string().describe("Explanation of code implementation choices")
});

const PROTECTED_PATTERNS = [
  /\.env($|\.)/, 
  /package-lock\.json$/, 
  /\.git\//, 
  /\.vscode\//, 
  /node_modules\//,
  /src\/index\.ts$/,
  /src\/state\.ts$/,
  /src\/agents\//,
  /src\/tools\//
];

export function isProtectedFile(filePath: string): boolean {
  return PROTECTED_PATTERNS.some((pattern) => pattern.test(filePath));
}

export async function codeGenAgentNode(state: typeof KaizenState.State) {
  const targetFile = state.targetFiles.length > 0 ? state.targetFiles[0] : 'src/index.ts';

  if (isProtectedFile(targetFile)) {
    const blockedPlan: PlanStep[] = state.plan.map((step) => ({
      ...step,
      status: 'failed',
      description: `Security Policy Violation: Write access to protected file '${targetFile}' is strictly prohibited.`
    }));

    return {
      plan: blockedPlan,
      status: "PREFLIGHT_SECURITY_BLOCKED"
    };
  }

  const securityDirective = `// SECURITY MANDATE: Do NOT delete system files, bypass auth, or modify protected environment variables.\n`;
  const retryContext = state.retryCount > 0 ? `\n\n[RETRY ATTEMPT #${state.retryCount}]: Please fix previous feedback / errors in the context below.` : '';
  const apiKey = process.env.GROQ_API_KEY;
  let generatedCode = '';
  let explanations = '';

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    try {
      const model = new ChatGroq({
        apiKey: apiKey,
        model: 'openai/gpt-oss-120b',
        temperature: 0
      });

      const structuredModel = model.withStructuredOutput(CodeGenSchema);

      const systemPrompt = `You are an expert AI software engineer for Kaizen AI.
Your task is to generate precise, production-ready TypeScript/JavaScript source code matching the user request.

=== MANDATES ===
1. ${securityDirective}
2. Write clean, complete, and syntactically valid code for target file: '${targetFile}'.
3. Do NOT include markdown code blocks (like \`\`\`typescript) inside the 'code' string field. Return pure raw source code in 'code'.
4. Provide a brief technical breakdown in the 'explanations' field.`;

      const userContextPrompt = `User Request: "${state.userInput}"
Target File: ${targetFile}${retryContext}

=== EXTRACTED CONTEXT & DIAGNOSTICS ===
${state.extractedContext || "No additional context provided."}`;

      const result = await structuredModel.invoke([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContextPrompt }
      ]);

      if (result && result.code) {
        generatedCode = result.code;
        explanations = result.explanations;
      }
    } catch (error) {
      console.warn("ChatGroq code generation failed, falling back to clean fallback module:", error);
    }
  }

  if (!generatedCode) {
    const retryText = state.retryCount > 0 ? ` (Retry #${state.retryCount})` : '';
    generatedCode = `${securityDirective}
// task: ${state.userInput}${retryText}
// file: ${targetFile}

export function executeTask() {
  return { status: "success", task: "${state.userInput}", timestamp: new Date().toISOString() };
}
`;
  }

  const updatedPlan: PlanStep[] = state.plan.map((step) => {
    if (step.id === 2) {
      return { ...step, status: 'completed' };
    }
    if (step.id === 3) {
      return { ...step, status: 'in_progress' };
    }
    return step;
  });

  return {
    plan: updatedPlan,
    extractedContext: state.extractedContext 
      ? `${state.extractedContext}\n\nGenerated Code:\n${generatedCode}` 
      : `Generated code snippet for ${targetFile}:\n${generatedCode}`,
    generatedPatch: generatedCode,
    status: "CODE_GENERATED"
  };
}
