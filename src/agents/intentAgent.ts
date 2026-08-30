import { z } from 'zod';
import { ChatGroq } from '@langchain/groq';
import * as dotenv from 'dotenv';
import { KaizenState } from '../state';

dotenv.config();

export const IntentSchema = z.object({
  intent: z.enum(['GENERATE_CODE', 'DEBUG_ERROR', 'EXPLAIN_CODE', 'REFACTOR'])
    .describe("The classified intent of the user request"),
  targetFiles: z.array(z.string())
    .describe("Target source files identified for the task")
});

export async function intentAgentNode(state: typeof KaizenState.State) {
  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    try {
      const model = new ChatGroq({
        apiKey: apiKey,
        model: 'openai/gpt-oss-120b',
        temperature: 0
      });

      const structuredModel = model.withStructuredOutput(IntentSchema);

      const systemPrompt = `You are an intent classification agent for a software engineering assistant (Kaizen AI).
Analyze the user's prompt (which may be in English, Hinglish, slang, or natural developer phrasing) and classify their intent into one of:
- GENERATE_CODE: Creating new features, boilerplate, or implementing requested functionality.
- DEBUG_ERROR: Fixing bugs, addressing runtime errors, broken builds, or troubleshooting code.
- EXPLAIN_CODE: Explaining how code works, answering architecture/codebase questions.
- REFACTOR: Cleaning up code, optimizing performance, renaming, or restructuring existing code.

Extract any target file paths explicitly mentioned or implied in the request.`;

      const result = await structuredModel.invoke([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: state.userInput }
      ]);

      const intent = result.intent || 'GENERATE_CODE';
      const targetFiles = result.targetFiles && result.targetFiles.length > 0
        ? result.targetFiles
        : (state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox.ts']);

      return {
        status: `ROUTED_${intent}`,
        targetFiles
      };
    } catch (error) {
      console.warn("ChatGroq execution failed, falling back to deterministic intent classifier:", error);
    }
  }

  const input = state.userInput.toLowerCase();
  let intent: z.infer<typeof IntentSchema>['intent'] = 'GENERATE_CODE';

  if (input.includes('fix') || input.includes('bug') || input.includes('error') || input.includes('kar de')) {
    intent = 'DEBUG_ERROR';
  } else if (input.includes('explain') || input.includes('how') || input.includes('samjha')) {
    intent = 'EXPLAIN_CODE';
  } else if (input.includes('refactor') || input.includes('clean')) {
    intent = 'REFACTOR';
  }

  return {
    status: `ROUTED_${intent}`,
    targetFiles: state.targetFiles.length > 0 ? state.targetFiles : ['src/sandbox.ts']
  };
}