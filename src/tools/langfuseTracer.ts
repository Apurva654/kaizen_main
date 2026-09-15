import { Langfuse } from 'langfuse';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import * as dotenv from 'dotenv';

dotenv.config();

export interface LLMMetrics {
  agentName: string;
  modelName: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  traceId?: string;
}

// Estimated pricing per 1,000,000 tokens (USD)
const MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
  'openai/gpt-oss-120b': { prompt: 0.15, completion: 0.60 },
  'groq/compound-mini': { prompt: 0.05, completion: 0.08 },
  'qwen/qwen3.8-27b': { prompt: 0.20, completion: 0.50 },
  'openai/gpt-oss-20b': { prompt: 0.07, completion: 0.10 },
  'llama-3.3-70b-versatile': { prompt: 0.59, completion: 0.79 },
  'llama-3.1-8b-instant': { prompt: 0.05, completion: 0.08 }
};

export class LangfuseTracerManager {
  private langfuseClient: Langfuse | null = null;
  private isEnabled: boolean = false;

  constructor() {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const baseUrl = process.env.LANGFUSE_HOST || 'https://cloud.langfuse.com';

    if (publicKey && secretKey && publicKey !== 'your_langfuse_public_key') {
      try {
        this.langfuseClient = new Langfuse({
          publicKey,
          secretKey,
          baseUrl
        });
        this.isEnabled = true;
        console.log(`[Langfuse Tracer] Initialized telemetry tracking for ${baseUrl}`);
      } catch (err) {
        console.warn("[Langfuse Tracer] Failed to initialize Langfuse SDK:", err);
      }
    } else {
      console.log("[Langfuse Tracer] Running in local observability mode (Set LANGFUSE_PUBLIC_KEY & LANGFUSE_SECRET_KEY in .env for Cloud Dashboard)");
    }
  }

  public calculateCost(modelName: string, promptTokens: number, completionTokens: number): number {
    const pricing = MODEL_PRICING[modelName] || { prompt: 0.10, completion: 0.30 };
    const promptCost = (promptTokens / 1_000_000) * pricing.prompt;
    const completionCost = (completionTokens / 1_000_000) * pricing.completion;
    return parseFloat((promptCost + completionCost).toFixed(6));
  }

  public logMetric(metric: LLMMetrics) {
    console.log(`\n--- [LANGFUSE METRICS TRACE] ---`);
    console.log(`Agent:           ${metric.agentName}`);
    console.log(`Model:           ${metric.modelName}`);
    console.log(`Latency:         ${metric.latencyMs} ms`);
    console.log(`Tokens:          ${metric.totalTokens} (Prompt: ${metric.promptTokens}, Completion: ${metric.completionTokens})`);
    console.log(`Estimated Cost:  $${metric.estimatedCostUsd.toFixed(6)} USD`);
    if (metric.traceId) {
      console.log(`Langfuse Trace:  ${metric.traceId}`);
    }
    console.log(`--------------------------------\n`);
  }

  public async recordGeneration(
    agentName: string,
    modelName: string,
    prompt: string,
    output: string,
    latencyMs: number,
    promptTokens: number = 50,
    completionTokens: number = 150
  ): Promise<LLMMetrics> {
    const totalTokens = promptTokens + completionTokens;
    const estimatedCostUsd = this.calculateCost(modelName, promptTokens, completionTokens);
    let traceId: string | undefined = undefined;

    if (this.isEnabled && this.langfuseClient) {
      try {
        const trace = this.langfuseClient.trace({
          name: `Kaizen_${agentName}`,
          metadata: { agent: agentName, model: modelName }
        });
        traceId = trace.id;

        trace.generation({
          name: agentName,
          model: modelName,
          input: prompt,
          output: output,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens
          },
          metadata: {
            latencyMs,
            estimatedCostUsd
          }
        });

        await this.langfuseClient.flushAsync();
      } catch (err) {
        console.warn("[Langfuse Tracer] Warning sending trace event:", err);
      }
    }

    const metrics: LLMMetrics = {
      agentName,
      modelName,
      latencyMs,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedCostUsd,
      traceId
    };

    this.logMetric(metrics);
    return metrics;
  }
}

export const langfuseTracer = new LangfuseTracerManager();
