import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { langfuseTracer } from './langfuseTracer';

dotenv.config();

const DEFAULT_MODELS = (process.env.GROQ_MODELS || 'openai/gpt-oss-120b,llama-3.3-70b-versatile')
    .split(',').map((s) => s.trim()).filter(Boolean);

export interface RunStructuredOptions<S extends z.ZodTypeAny> {
    agent: string;
    schema: S;
    system: string;
    user: string;
    temperature?: number;
    timeoutMs?: number;
    models?: string[];
    validate?: (result: z.infer<S>) => string | null;
}

export async function runStructured<S extends z.ZodTypeAny>(
    opts: RunStructuredOptions<S>
): Promise<{ result: z.infer<S>; model: string }> {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey || apiKey === 'your_groq_api_key_here') throw new Error('GROQ_API_KEY is not configured');

    const timeoutMs = opts.timeoutMs ?? 30000;
    const errors: string[] = [];

    for (const modelName of opts.models ?? DEFAULT_MODELS) {
        let timer: NodeJS.Timeout | undefined;
        try {
            const model = new ChatGroq({ apiKey, model: modelName, temperature: opts.temperature ?? 0 });
            const structured = model.withStructuredOutput(opts.schema, { method: 'jsonMode' });
            const started = Date.now();
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
            });

            const result = (await Promise.race([
                structured.invoke([
                    { role: 'system', content: opts.system },
                    { role: 'user', content: opts.user }
                ]),
                timeout
            ])) as z.infer<S>;

            const output = JSON.stringify(result);
            await langfuseTracer.recordGeneration(
                opts.agent, modelName, opts.user, output, Date.now() - started,
                Math.ceil((opts.system.length + opts.user.length) / 4),
                Math.ceil(output.length / 4)
            );

            const problem = opts.validate?.(result);
            if (problem) { errors.push(`${modelName}: rejected - ${problem}`); continue; }
            return { result, model: modelName };
        } catch (err: any) {
            errors.push(`${modelName}: ${err?.message || err}`);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
    throw new Error(errors.join(' | '));
}