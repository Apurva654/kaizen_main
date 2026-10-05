import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import { langfuseTracer } from './langfuseTracer';

export interface RunStructuredOptions<S extends z.ZodTypeAny> {
  agent: string;
  schema: S;
  system: string;
  user: string;
  temperature?: number;
  timeoutMs?: number; // default 30000
  models?: string[];
  validate?: (r: z.infer<S>) => string | null;
}

export async function runStructured<S extends z.ZodTypeAny>(
  opts: RunStructuredOptions<S>
): Promise<{ result: z.infer<S>; model: string }> {
  const apiKey = process.env.GROQ_API_KEY;
  const timeoutMs = opts.timeoutMs ?? 30000;
  
  let modelList: string[] = [];
  if (opts.models && opts.models.length > 0) {
    modelList = opts.models;
  } else if (process.env.GROQ_MODELS) {
    modelList = process.env.GROQ_MODELS.split(',').map(m => m.trim()).filter(Boolean);
  } else {
    modelList = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'];
  }

  if (!apiKey) {
    throw new Error('GROQ_API_KEY environment variable is missing or empty.');
  }

  const errors: string[] = [];

  for (const model of modelList) {
    let timerHandle: NodeJS.Timeout | null = null;
    const startTime = Date.now();
    try {
      const chatModel = new ChatGroq({
        apiKey,
        model,
        temperature: opts.temperature
      });

      const runnable = chatModel.withStructuredOutput(opts.schema, { method: 'jsonMode' });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timerHandle = setTimeout(() => {
          reject(new Error(`Model '${model}' timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const invokePromise = runnable.invoke([
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user }
      ]);

      const rawResult = await Promise.race([invokePromise, timeoutPromise]);
      const latencyMs = Date.now() - startTime;

      if (!rawResult) {
        throw new Error(`Model '${model}' returned empty result`);
      }

      const result = rawResult as z.infer<S>;

      if (opts.validate) {
        const validationError = opts.validate(result);
        if (validationError) {
          throw new Error(`Validation failed for model '${model}': ${validationError}`);
        }
      }

      // Estimate tokens based on 4 characters per token (approximate estimate)
      const approxInputTokens = Math.ceil((opts.system.length + opts.user.length) / 4);
      const approxOutputTokens = Math.ceil(JSON.stringify(result).length / 4);

      await langfuseTracer.recordGeneration(
        opts.agent,
        model,
        opts.user,
        JSON.stringify(result),
        latencyMs,
        approxInputTokens,
        approxOutputTokens
      );

      return { result, model };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      errors.push(`[${model}]: ${errMsg}`);
    } finally {
      if (timerHandle) {
        clearTimeout(timerHandle);
      }
    }
  }

  throw new Error(errors.join(' | '));
}