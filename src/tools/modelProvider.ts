import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';
import * as dotenv from 'dotenv';

dotenv.config();

export interface ModelOptions {
  temperature?: number;
  geminiModelCandidates?: string[];
}

export const DEFAULT_GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-3.5-flash-lite'
];

export function getActiveModelProvider(): 'gemini' | 'none' {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
    return 'gemini';
  }
  return 'none';
}

/**
 * Creates and invokes a model using Google Gemini.
 */
export async function invokeModel(
  systemPrompt: string,
  userPrompt: string,
  options: ModelOptions = {}
): Promise<string> {
  const temp = options.temperature ?? 0.3;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
    const geminiCandidates = options.geminiModelCandidates || DEFAULT_GEMINI_MODELS;
    for (const modelName of geminiCandidates) {
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiKey,
          model: modelName,
          temperature: temp
        });

        const res: any = await model.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]);

        const text = typeof res.content === 'string' ? res.content : String(res.content ?? '');
        if (text && text.trim()) {
          return text.trim();
        }
      } catch (err: any) {
        console.warn(`[ModelProvider] Gemini model '${modelName}' invocation failed:`, err?.message || err);
      }
    }
  }

  throw new Error('No LLM model provider (Gemini) succeeded.');
}

/**
 * Creates and invokes a structured JSON output model using Google Gemini.
 */
export async function invokeStructuredModel<S extends z.ZodTypeAny>(
  schema: S,
  systemPrompt: string,
  userPrompt: string,
  options: ModelOptions = {}
): Promise<z.infer<S>> {
  const temp = options.temperature ?? 0;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
    const geminiCandidates = options.geminiModelCandidates || DEFAULT_GEMINI_MODELS;
    for (const modelName of geminiCandidates) {
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiKey,
          model: modelName,
          temperature: temp
        });

        const structuredModel = model.withStructuredOutput(schema);
        const result = await structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]);

        if (result) {
          return result as z.infer<S>;
        }
      } catch (err: any) {
        console.warn(`[ModelProvider] Gemini structured model '${modelName}' failed:`, err?.message || err);
      }
    }
  }

  throw new Error('No structured LLM model provider (Gemini) succeeded.');
}
