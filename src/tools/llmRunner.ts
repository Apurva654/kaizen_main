import { z } from 'zod';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { langfuseTracer } from './langfuseTracer';

export interface RunStructuredOptions<S extends z.ZodTypeAny> {
  agent: string;
  schema: S;
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number; // default 8000
  models?: string[];
  validate?: (r: z.infer<S>) => string | null;
}

export async function runStructured<S extends z.ZodTypeAny>(
  opts: RunStructuredOptions<S>
): Promise<{ result: z.infer<S>; model: string }> {
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const errors: string[] = [];

  if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
    const geminiModels = opts.models && opts.models.length > 0
      ? opts.models
      : ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-3.5-flash-lite'];

    for (const model of geminiModels) {
      let timerHandle: NodeJS.Timeout | null = null;
      const startTime = Date.now();
      try {
        const chatModel = new ChatGoogleGenerativeAI({
          apiKey: geminiApiKey,
          model,
          temperature: opts.temperature ?? 0
        });

        const runnable = chatModel.withStructuredOutput(opts.schema);

        const timeoutPromise = new Promise<never>((_, reject) => {
          timerHandle = setTimeout(() => {
            reject(new Error(`Gemini Model '${model}' timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        const invokePromise = runnable.invoke([
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user }
        ]);

        const rawResult = await Promise.race([invokePromise, timeoutPromise]);
        const latencyMs = Date.now() - startTime;

        if (rawResult) {
          const result = rawResult as z.infer<S>;
          if (opts.validate) {
            const validationError = opts.validate(result);
            if (validationError) {
              errors.push(`[Validation:${model}]: ${validationError}`);
              // If validation fails on the output structure, trying every single fallback model
              // without prompt feedback wastes minutes. Allow at most 1 fallback, then fail fast.
              const validationFailures = errors.filter(e => e.startsWith('[Validation:'));
              if (validationFailures.length >= 2) {
                throw new Error(`Output validation failed: ${validationError}`);
              }
              continue;
            }
          }
          await langfuseTracer.recordGeneration(opts.agent, model, opts.user, JSON.stringify(result), latencyMs);
          return { result, model };
        }
      } catch (err: any) {
        errors.push(`[Gemini:${model}]: ${err?.message || String(err)}`);
        // If an explicit validation error was thrown, propagate it
        if (err?.message?.startsWith('Output validation failed:')) {
          throw err;
        }
      } finally {
        if (timerHandle) clearTimeout(timerHandle);
      }
    }
  }

  throw new Error(errors.join(' | ') || 'No Gemini LLM model succeeded.');
}