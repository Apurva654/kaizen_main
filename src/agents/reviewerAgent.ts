import { z } from 'zod';
import { runStructured } from '../tools/llmRunner';
import * as dotenv from 'dotenv';
import { KaizenState } from '../state';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export const ReviewerSchema = z.object({
  approved: z.boolean().optional().describe("Whether the code patch is approved for production"),
  codeQualityScore: z.number().optional().describe("Code quality rating from 1 to 100"),
  issues: z.array(z.string()).optional().describe("List of critical syntax, security, or logical issues found"),
  suggestions: z.array(z.string()).optional().describe("List of code improvement or optimization suggestions"),
  summary: z.string().optional().describe("Executive code review summary"),
  overview: z.string().optional().describe("Executive code review summary"),
  feedback: z.string().optional().describe("Executive code review summary")
});

export interface ReviewResult {
  approved: boolean;
  codeQualityScore: number;
  issues: string[];
  suggestions: string[];
  summary: string;
  status: string;
}

import * as fs from 'fs';
import * as path from 'path';
import { validateCodeSyntax } from '../tools/languageResolver';

export async function reviewerAgentNode(state: typeof KaizenState.State): Promise<ReviewResult> {
  const targetFiles = state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox/main.ts'];
  const geminiApiKey = process.env.GEMINI_API_KEY;

  console.log("\n-> Running Code Reviewer Agent (reviewerAgent.ts)...");

  // Resolve actual code patch to review (from state.generatedPatch, state.filePatches, or disk)
  let patchText = state.generatedPatch || '';
  if (!patchText && (state as any).filePatches && (state as any).filePatches.length > 0) {
    patchText = (state as any).filePatches.map((f: any) => `// File: ${f.filePath}\n${f.code}`).join('\n\n');
  }
  if (!patchText) {
    const diskFiles: string[] = [];
    for (const tf of targetFiles) {
      const full = path.resolve(process.cwd(), tf);
      if (fs.existsSync(full)) {
        try {
          diskFiles.push(`// File: ${tf}\n${fs.readFileSync(full, 'utf-8').slice(0, 30000)}`);
        } catch { }
      }
    }
    patchText = diskFiles.join('\n\n');
  }

  if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
    try {
      const systemPrompt = `You are an expert AI Code Reviewer Agent for Kaizen AI. Respond in valid json format.
Your task is to perform an automated code review on the generated code patches across Python, TypeScript, and supported languages.
Evaluate syntax correctness, security, proper typing, completeness, and adherence to user instructions.`;

      const userPrompt = `USER REQUEST: ${state.originalUserRequest || state.userInput}\nTARGET FILES: ${targetFiles.join(', ')}\nGENERATED PATCH:\n${patchText || '(No code content available)'}`;

      const { result: rawResult } = await runStructured({
        agent: 'ReviewerAgent',
        schema: ReviewerSchema,
        system: systemPrompt,
        user: userPrompt,
        temperature: 0
      });

      if (rawResult) {
        const issues: string[] = rawResult.issues || [];
        const hasCriticalIssues = issues.some(i => /syntax|security|vulnerability|breaking|unresolved|type error|undefined/i.test(i));
        const score = typeof rawResult.codeQualityScore === 'number' ? rawResult.codeQualityScore : (hasCriticalIssues ? 60 : 85);
        const approved = rawResult.approved !== undefined ? rawResult.approved : (score >= 75 && !hasCriticalIssues);

        return {
          approved,
          codeQualityScore: score,
          issues,
          suggestions: rawResult.suggestions || [],
          summary: rawResult.summary || rawResult.overview || rawResult.feedback || (approved ? 'Code patch passed verification.' : 'Code patch requires revision.'),
          status: approved ? 'REVIEW_PASSED' : 'CHANGES_REQUESTED'
        };
      }
    } catch (err: any) {
      console.warn('[ReviewerAgent] Structured LLM review failed, falling back to deterministic checker:', err?.message || err);
    }
  }

  // Grounded heuristic review if LLM unavailable
  console.log("[ReviewerAgent] Operating in deterministic code quality checker fallback mode...");

  if (!patchText || patchText.trim().length === 0) {
    return {
      approved: false,
      codeQualityScore: 20,
      issues: ["No generated code or target files found to review."],
      suggestions: ["Ensure CodeGen produces code patches before triggering Reviewer."],
      summary: "Review failed: No code was generated.",
      status: "CHANGES_REQUESTED"
    };
  }

  const detectedIssues: string[] = [];
  const detectedSuggestions: string[] = [];

  // Check for common stub violations
  if (/\/\/\s*(TODO|FIXME|PLACEHOLDER|NOT IMPLEMENTED)/i.test(patchText) || /raise\s+NotImplementedError/i.test(patchText)) {
    detectedIssues.push("Unimplemented placeholder or TODO/FIXME detected in source code.");
  }

  // Check syntax validity for target files
  for (const tf of targetFiles) {
    const ext = tf.split('.').pop()?.toLowerCase() || '';
    const syntaxResult = validateCodeSyntax(patchText, ext, tf);
    if (!syntaxResult.isValid) {
      detectedIssues.push(`Syntax issue in ${tf}: ${syntaxResult.error}`);
    }
  }

  const approved = detectedIssues.length === 0;
  const score = approved ? 88 : 55;

  return {
    approved,
    codeQualityScore: score,
    issues: detectedIssues,
    suggestions: detectedSuggestions.length > 0 ? detectedSuggestions : ["Consider adding explicit parameter and return type annotations."],
    summary: approved ? "Code review passed via AST structural inspection." : `Code review requested changes: ${detectedIssues.join('; ')}`,
    status: approved ? "REVIEW_PASSED" : "CHANGES_REQUESTED"
  };
}
