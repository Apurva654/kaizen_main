import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import * as dotenv from 'dotenv';
import { KaizenStateType } from '../state';

dotenv.config();

export interface ContextSufficiencyResult {
  sufficiency: 'SUFFICIENT_CONTEXT' | 'PARTIAL_CONTEXT' | 'INSUFFICIENT_CONTEXT';
  missingContextSummary?: string;
  unsupportedSubject?: string | null;
  conversationalResponse?: string;
  assumptionsStated?: string[];
  suggestedQuestions?: string[];
}

/**
 * Fallback deterministic rules for context sufficiency check
 */
export function evaluateContextSufficiencyFallback(
  rawUserInput: string,
  extractedContext: string = '',
  targetFiles: string[] = []
): ContextSufficiencyResult {
  const lower = rawUserInput.toLowerCase().trim();

  // Case 4 Check: Explicit request for specific integration/technology in codebase (e.g. Stripe, Firebase, Redis)
  const integrationMatch = lower.match(/\b(how does|where is|explain|show)\s+(the\s+)?([a-z0-9_\-]+)\s+(integration|auth|service|module|payment|api|sdk)?\s*(work|exist|implemented)?\s*(in\s+this\s+codebase|in\s+the\s+project|in\s+this\s+repo)?/i);
  
  if (integrationMatch) {
    const candidateSubject = (integrationMatch[3] || '').toLowerCase();
    const commonGenericWords = ['codebase', 'project', 'app', 'application', 'system', 'backend', 'frontend', 'server', 'client', 'code', 'authentication', 'auth', 'it', 'this'];

    if (candidateSubject && !commonGenericWords.includes(candidateSubject)) {
      const hasRepoEvidence = extractedContext.toLowerCase().includes(candidateSubject) ||
        targetFiles.some(f => f.toLowerCase().includes(candidateSubject));

      if (!hasRepoEvidence) {
        return {
          sufficiency: 'INSUFFICIENT_CONTEXT',
          unsupportedSubject: candidateSubject,
          conversationalResponse: `I searched the codebase, but I couldn't find any evidence or files for ${candidateSubject} integration in this project.`
        };
      }
    }
  }

  // Case 1 Check: Underspecified model performance questions ("why is my model performing badly")
  if (/^why\s+is\s+my\s+model\s+(performing\s+badly|misbehaving|failing|underperforming|not\ working|slow|bad)/i.test(lower) ||
      /^my\s+model\s+is\s+(performing\s+badly|not\ working|failing|underperforming)/i.test(lower)) {
    // Check if prompt has specific metrics (like Case 2)
    const hasMetrics = /\b(\d+%|\d+\.\d+|accuracy|loss|val_loss|train_loss)\b/i.test(lower) &&
                       /\b(train|training|val|validation|test|epoch)\b/i.test(lower);
    if (!hasMetrics) {
      return {
        sufficiency: 'INSUFFICIENT_CONTEXT',
        missingContextSummary: 'Model/task type and training vs. validation metrics',
        conversationalResponse: `I can help diagnose it, but I need a little more context first. What model/task are you working with, and what are your training and validation/test metrics? If you have loss or accuracy curves, feel free to share those too.`
      };
    }
  }

  // Case 5 Check: "Fix my code" with no code or active file context
  if (/^fix\s+(my\s+)?(code|bug|error|issue)\.?$/i.test(lower)) {
    const hasCodeContext = extractedContext && extractedContext.length > 50;
    if (!hasCodeContext && targetFiles.length === 0) {
      return {
        sufficiency: 'INSUFFICIENT_CONTEXT',
        missingContextSummary: 'Target code snippet or error logs',
        conversationalResponse: `I'd be glad to help fix your code! Could you share the specific code snippet or error message you're seeing?`
      };
    }
  }

  // Case 2 Check: Overfitting diagnosis prompt with concrete training & validation metrics
  if (/\b(\d+%|\d+\.\d+)\s*(train|training)\b/i.test(lower) && /\b(\d+%|\d+\.\d+)\s*(val|validation|test)\b/i.test(lower)) {
    return {
      sufficiency: 'SUFFICIENT_CONTEXT'
    };
  }

  // Case 3 Check: Codebase feature explanation request (e.g., "How does authentication work in this codebase?")
  if (/\b(how\s+does|explain|where\s+is)\s+.*?\b(work|implemented|handle|auth|authentication|routing|database|server)\b/i.test(lower)) {
    return {
      sufficiency: 'SUFFICIENT_CONTEXT'
    };
  }

  return {
    sufficiency: 'SUFFICIENT_CONTEXT'
  };
}

/**
 * Evaluates prompt & retrieved codebase context sufficiency before committing to final answer.
 */
export async function evaluateContextSufficiency(state: KaizenStateType): Promise<ContextSufficiencyResult> {
  const rawUserInput = state.userInput || state.originalUserRequest || '';
  const extractedContext = state.extractedContext || '';
  const targetFiles = state.targetFiles || [];

  // Run fallback check first to catch high-precision cases cleanly
  const fallbackResult = evaluateContextSufficiencyFallback(rawUserInput, extractedContext, targetFiles);
  if (fallbackResult.sufficiency === 'INSUFFICIENT_CONTEXT') {
    return fallbackResult;
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
    const geminiCandidates = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-3.5-flash-lite'];
    for (const modelName of geminiCandidates) {
      try {
        const model = new ChatGoogleGenerativeAI({ apiKey: geminiApiKey, model: modelName, temperature: 0 });
        const userPayload = `USER PROMPT: "${rawUserInput}"\n\nTARGET FILES: ${targetFiles.join(', ') || 'None'}\n\nRETRIEVED CODEBASE CONTEXT:\n${extractedContext.slice(0, 10000)}`;
        const res: any = await model.invoke([
          { role: 'system', content: `Analyze prompt sufficiency. Return JSON with keys: sufficiency (SUFFICIENT_CONTEXT|PARTIAL_CONTEXT|INSUFFICIENT_CONTEXT), missingContextSummary, conversationalResponse, assumptionsStated.` },
          { role: 'user', content: userPayload }
        ]);
        const text = typeof res.content === 'string' ? res.content : JSON.stringify(res.content);
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed && parsed.sufficiency) {
            return {
              sufficiency: parsed.sufficiency,
              missingContextSummary: parsed.missingContextSummary,
              unsupportedSubject: parsed.unsupportedSubject,
              conversationalResponse: parsed.conversationalResponse,
              assumptionsStated: parsed.assumptionsStated,
              suggestedQuestions: parsed.suggestedQuestions
            };
          }
        }
      } catch (err: any) {
        console.warn(`Gemini context sufficiency model '${modelName}' failed:`, err?.message || err);
      }
    }
  }

  return fallbackResult;

  return fallbackResult;
}
