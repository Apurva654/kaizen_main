import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import * as dotenv from 'dotenv';
import { langfuseTracer } from '../tools/langfuseTracer';

dotenv.config();

export interface EnhancedPromptResult {
  originalPrompt: string;
  enhancedPrompt: string;
  isEnhanced: boolean;
  enhancementReason?: string;
}

export function isVagueOrShortPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;

  // Don't enhance explicit terminal execution or git commands
  if (/^\s*(git|pytest|python|npm|node|npx|tsc|rm|del|dir|ls|cat|pwd|mkdir)\b/i.test(trimmed)) {
    return false;
  }

  // Don't enhance short greetings or memory reads
  if (/^(hello|hi|hey|greetings|what do you remember|show memory)\b/i.test(trimmed)) {
    return false;
  }

  // If prompt is under 60 characters or matches common vague request patterns
  if (trimmed.length < 60) return true;

  const vaguePatterns = [
    /\b(make|create|build|generate|write)\s+(a\s+)?(website|webpage|landing page|app|3d earth|planet|game|calculator|dashboard)\b/i,
    /\b(fix|debug|solve)\s+(the\s+)?(bug|error|issue|problem|failing test)\b/i,
    /\b(refactor|clean|optimize)\s+(the\s+)?(code|project|file)\b/i
  ];

  return vaguePatterns.some(pattern => pattern.test(trimmed));
}

export async function enhanceUserPrompt(rawPrompt: string): Promise<EnhancedPromptResult> {
  const prompt = rawPrompt.trim();
  if (!prompt || !isVagueOrShortPrompt(prompt)) {
    return { originalPrompt: rawPrompt, enhancedPrompt: rawPrompt, isEnhanced: false };
  }

  // Rule-based fast-track enhancements for common underspecified queries
  const lower = prompt.toLowerCase();

  if (/\b(earth|3d earth|planet)\b/i.test(lower) && !/\b(nasa|texture|orbitcontrols|bump)\b/i.test(lower)) {
    const enhanced = `${prompt}\n\n[PROMPT ENHANCER DIRECTIVES]:\n` +
      `- Use photorealistic 3D graphics (Three.js / WebGL / PyVista) with high-resolution texture maps.\n` +
      `- Add separate rotating atmospheric cloud mesh and smooth OrbitControls.\n` +
      `- Ensure balanced lighting (ambient fill + directional sunlight) to prevent overexposure or dark spots.`;
    return {
      originalPrompt: rawPrompt,
      enhancedPrompt: enhanced,
      isEnhanced: true,
      enhancementReason: 'Enriched 3D planet creation request with graphics standards.'
    };
  }

  if (/\b(website|webpage|landing page|portfolio)\b/i.test(lower) && !/\b(responsive|css|theme|navbar)\b/i.test(lower)) {
    const enhanced = `${prompt}\n\n[PROMPT ENHANCER DIRECTIVES]:\n` +
      `- Build a clean, responsive layout with modern typography and sleek dark mode color tokens.\n` +
      `- Include interactive UI components (navbar, hero section, features grid, contact form with validation).\n` +
      `- Ensure interactive hover states and dynamic micro-animations.`;
    return {
      originalPrompt: rawPrompt,
      enhancedPrompt: enhanced,
      isEnhanced: true,
      enhancementReason: 'Enriched web application request with modern design system guidelines.'
    };
  }

  const geminiApiKey = process.env.GEMINI_API_KEY;
  if (geminiApiKey && geminiApiKey !== 'your_gemini_api_key_here') {
    const geminiCandidates = ['gemini-2.5-flash', 'gemini-3.5-flash-lite', 'gemini-2.0-flash'];

    for (const modelName of geminiCandidates) {
      try {
        const model = new ChatGoogleGenerativeAI({
          apiKey: geminiApiKey,
          model: modelName,
          temperature: 0.2
        });

        const systemPrompt = `You are an expert software engineering prompt enhancer.
Your task is to take a vague user prompt and expand it into a clear, structured specification.

CRITICAL RULES:
1. Preserve ALL original user requirements, details, constraints, file names, and tech stack choices.
2. Add necessary technical clarity, edge-case coverage, UI/UX standards, and implementation requirements.
3. Do NOT invent unrelated features outside the scope of the user's intent.
4. Output ONLY the enhanced prompt specification.`;

        const startTime = Date.now();
        const response = await model.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Original User Request:\n"${prompt}"` }
        ]);

        const latencyMs = Date.now() - startTime;
        const resultText = (typeof response.content === 'string' ? response.content : JSON.stringify(response.content)).trim();

        if (resultText && resultText.length > prompt.length) {
          await langfuseTracer.recordGeneration('PromptEnhancerAgent', modelName, prompt, resultText, latencyMs, 40, 60);

          const enhanced = `${prompt}\n\n[PROMPT ENHANCER DIRECTIVES]:\n${resultText}`;
          return {
            originalPrompt: rawPrompt,
            enhancedPrompt: enhanced,
            isEnhanced: true,
            enhancementReason: `Enhanced using LLM model '${modelName}'.`
          };
        }
      } catch (err: any) {
        console.warn(`PromptEnhancer model '${modelName}' failed:`, err?.message || err);
      }
    }
  }

  return { originalPrompt: rawPrompt, enhancedPrompt: rawPrompt, isEnhanced: false };
}
