import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { z } from 'zod';
import * as dotenv from 'dotenv';
import { langfuseTracer } from './langfuseTracer';

dotenv.config();

export interface ModelOptions {
  temperature?: number;
  geminiModelCandidates?: string[];
  timeoutMs?: number;
  agent?: string;
}

export const DEFAULT_GEMINI_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
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
 * Creates and invokes a model using Google Gemini with model candidate fallback,
 * timeout handling, and optional Langfuse tracing.
 */
export async function invokeModel(
  systemPrompt: string,
  userPrompt: string,
  options: ModelOptions = {}
): Promise<string> {
  const temp = options.temperature ?? 0.3;
  const timeoutMs = options.timeoutMs ?? 10000;
  const agentName = options.agent || 'ModelProvider';
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
    const geminiCandidates = options.geminiModelCandidates || DEFAULT_GEMINI_MODELS;
    const errors: string[] = [];

    for (const modelName of geminiCandidates) {
      let timer: NodeJS.Timeout | null = null;
      const startTime = Date.now();
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiKey,
          model: modelName,
          temperature: temp
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Model '${modelName}' timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        const invokePromise = model.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]);

        const res: any = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        const text = typeof res.content === 'string' ? res.content : String(res.content ?? '');
        if (text && text.trim()) {
          const trimmed = text.trim();
          await langfuseTracer.recordGeneration(agentName, modelName, userPrompt, trimmed, latencyMs);
          return trimmed;
        }
      } catch (err: any) {
        errors.push(`[${modelName}]: ${err?.message || err}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error(`All Gemini models failed for ${agentName}: ${errors.join(' | ')}`);
  }

  throw new Error('No LLM model provider (Gemini) succeeded: API key missing or unconfigured.');
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
  const timeoutMs = options.timeoutMs ?? 10000;
  const agentName = options.agent || 'ModelProvider';
  const geminiKey = process.env.GEMINI_API_KEY;

  if (geminiKey && geminiKey !== 'your_gemini_api_key_here') {
    const geminiCandidates = options.geminiModelCandidates || DEFAULT_GEMINI_MODELS;
    const errors: string[] = [];

    for (const modelName of geminiCandidates) {
      let timer: NodeJS.Timeout | null = null;
      const startTime = Date.now();
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiKey,
          model: modelName,
          temperature: temp
        });

        const structuredModel = model.withStructuredOutput(schema);

        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Structured model '${modelName}' timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        const invokePromise = structuredModel.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ]);

        const result = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        if (result) {
          await langfuseTracer.recordGeneration(agentName, modelName, userPrompt, JSON.stringify(result), latencyMs);
          return result as z.infer<S>;
        }
      } catch (err: any) {
        errors.push(`[${modelName}]: ${err?.message || err}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error(`All structured models failed for ${agentName}: ${errors.join(' | ')}`);
  }

  throw new Error('No structured LLM model provider (Gemini) succeeded: API key missing or unconfigured.');
}
