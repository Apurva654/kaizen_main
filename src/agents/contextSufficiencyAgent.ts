import { ChatGroq } from '@langchain/groq';
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

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || apiKey === 'your_groq_api_key_here') {
    return fallbackResult;
  }

  try {
    const modelCandidates = [
      'openai/gpt-oss-120b',
      'openai/gpt-oss-20b',
      'qwen/qwen3.8-27b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant'
    ];

    const systemPrompt = `You are Kaizen's Adaptive Context Sufficiency & Ambiguity Evaluation Agent.
Determine if the user's prompt has sufficient context to answer confidently, or if crucial information is missing.

Classifications:
1. SUFFICIENT_CONTEXT: Prompt or retrieved CODEBASE CONTEXT contains enough information.
2. PARTIAL_CONTEXT: Enough info to provide an initial partial answer with explicit assumptions, plus 1 targeted question.
3. INSUFFICIENT_CONTEXT: Request is ambiguous/underspecified (e.g. "Why is my model performing badly?" with no metrics/architecture, "Fix my code" with no code/logs, or asking about a non-existent feature like "Stripe integration" when no Stripe code exists in CODEBASE CONTEXT).

IMPORTANT DIRECTIVES:
- DO NOT address the user as "Alice" or invent user names/personal details.
- DO NOT ask the user for code or information that ALREADY EXISTS in the CODEBASE CONTEXT.
- If the user asks about a specific feature (e.g. Stripe, Firebase) and NO evidence exists in CODEBASE CONTEXT, classify as INSUFFICIENT_CONTEXT and state that no evidence of that feature was found in the codebase.
- For ambiguous questions like "Why is my model performing badly?", DO NOT output a large bulleted checklist. Provide a natural 1-2 sentence response asking for the specific missing metrics (model type, train vs validation accuracy).
- If specific metrics are provided (e.g. "98% train accuracy, 65% val accuracy"), classify as SUFFICIENT_CONTEXT and diagnose overfitting directly without asking basic questions.

Respond in JSON:
{
  "sufficiency": "SUFFICIENT_CONTEXT" | "PARTIAL_CONTEXT" | "INSUFFICIENT_CONTEXT",
  "missingContextSummary": "string",
  "unsupportedSubject": "string or null",
  "conversationalResponse": "string",
  "assumptionsStated": ["string"],
  "suggestedQuestions": ["string"]
}`;

    const userPayload = `[USER PROMPT]:
${rawUserInput}

[CODEBASE CONTEXT RETRIEVED FROM REPOSITORY]:
${extractedContext.slice(0, 3000) || '(No codebase context found)'}

[TARGET FILES]:
${targetFiles.join(', ') || 'None'}`;

    for (const modelName of modelCandidates) {
      try {
        const model = new ChatGroq({ apiKey, model: modelName, temperature: 0 });
        const res: any = await model.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPayload }
        ]);

        const text = typeof res.content === 'string' ? res.content : String(res.content ?? '');
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.sufficiency) {
            return {
              sufficiency: parsed.sufficiency,
              missingContextSummary: parsed.missingContextSummary,
              unsupportedSubject: parsed.unsupportedSubject,
              conversationalResponse: parsed.conversationalResponse,
              assumptionsStated: parsed.assumptionsStated || [],
              suggestedQuestions: parsed.suggestedQuestions || []
            };
          }
        }
      } catch (err) {
        console.warn(`ContextSufficiencyAgent LLM invocation failed for model '${modelName}':`, err);
      }
    }
  } catch (err) {
    console.warn('ContextSufficiencyAgent error, using fallback:', err);
  }

  return fallbackResult;
}
