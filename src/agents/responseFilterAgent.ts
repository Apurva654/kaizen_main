import { ChatGroq } from '@langchain/groq';

export interface ResponseFilterOptions {
  userQuery: string;
  extractedContext: string;
  targetFiles?: string[];
}

/**
 * Filters and synthesizes retrieved codebase context as internal evidence,
 * returning ONLY the information necessary to directly answer the user's query.
 */
export async function generateFilteredResponse(
  userQuery: string,
  extractedContext: string,
  targetFiles: string[] = []
): Promise<string> {
  const queryText = (userQuery || '').trim();
  const rawContext = (extractedContext || '').trim();

  if (!queryText) {
    return "Please provide a query or question to answer.";
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (apiKey && apiKey !== 'your_groq_api_key_here') {
    const modelCandidates = [
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'qwen/qwen3.8-27b',
      'llama-3.1-8b-instant'
    ];

    const systemPrompt = `You are Kaizen AI's Relevance-Based Response Filter & Synthesizer.
Your sole job is to answer the user's specific query using the provided workspace context strictly as INTERNAL EVIDENCE.

CRITICAL RESPONSE DIRECTIVES:
1. INTERNAL EVIDENCE ONLY: Treat the provided workspace context, code snippets, AST symbols, and graph facts strictly as internal evidence for your reasoning. Do NOT copy or output internal context headers (e.g. '=== PRE-EXISTING FILE CONTENT ===', '=== WORKSPACE GRAPH SUMMARY ===', '=== STATED ASSUMPTIONS ===', '=== FALLBACK WORKSPACE CONTEXT ===').
2. RELEVANCE FILTERING: Extract and return ONLY the precise information, symbols, file paths, and facts directly required to answer the user's query. Do NOT output unrequested workspace file lists, full dependency trees, raw full source files, or internal context metadata.
3. CONCISE & FOCUSED: For questions like "What does X depend on?", output only the relevant symbols (classes, methods, functions) and their exact file paths.
4. NO CODE BLOCKS UNLESS REQUESTED: Do NOT output full code blocks or file contents unless the user explicitly requested code snippets or file implementation details.
5. NO HALLUCINATION: Rely strictly on the evidence provided in the workspace context.`;

    const userPayload = `USER QUERY: "${queryText}"

RELEVANT TARGET FILES:
${targetFiles.length > 0 ? targetFiles.join(', ') : 'None specified'}

INTERNAL EVIDENCE / WORKSPACE CONTEXT:
${rawContext.slice(0, 12000)}`;

    for (const modelName of modelCandidates) {
      try {
        const model = new ChatGroq({ apiKey, model: modelName, temperature: 0.1 });
        const res: any = await model.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPayload }
        ]);
        const responseText = typeof res.content === 'string' ? res.content.trim() : String(res.content ?? '').trim();
        if (responseText && responseText.length > 0) {
          return responseText;
        }
      } catch (err: any) {
        console.warn(`[ResponseFilterAgent][WARN] Model '${modelName}' execution failed:`, err?.message || err);
      }
    }
  }

  // Grounded deterministic fallback relevance filter for offline execution
  return fallbackRelevanceFilter(queryText, rawContext, targetFiles);
}

/**
 * Grounded deterministic fallback relevance filter for offline execution
 */
export function fallbackRelevanceFilter(
  userQuery: string,
  extractedContext: string,
  targetFiles: string[] = []
): string {
  if (!extractedContext || extractedContext.trim().length === 0) {
    return "No relevant codebase context was found to answer your query.";
  }

  // Strip internal system headers cleanly
  const cleanedContext = extractedContext
    .replace(/===\s*PRE-EXISTING FILE CONTENT FOR [^=]+===/g, '')
    .replace(/===\s*WORKSPACE GRAPH SUMMARY\s*===/g, '')
    .replace(/===\s*STATED ASSUMPTIONS & PARTIAL CONTEXT\s*===/g, '')
    .replace(/===\s*CACHED WORKSPACE GRAPH[^=]+===/g, '')
    .replace(/===\s*FALLBACK WORKSPACE CONTEXT\s*===/g, '')
    .trim();

  // Extract query keywords (e.g. AuthService, authenticate, depend, etc.)
  const keywords = userQuery
    .replace(/[^\w\s.]/g, ' ')
    .split(/\s+/)
    .filter(k => k.length > 2 && !['what', 'does', 'the', 'and', 'for', 'with', 'from', 'that', 'this', 'have', 'how', 'directly'].includes(k.toLowerCase()));

  const lines = cleanedContext.split('\n');
  const matchedLines: string[] = [];
  const foundFiles = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('===')) continue;

    const lineLower = trimmed.toLowerCase();
    const isKeywordMatch = keywords.some(kw => lineLower.includes(kw.toLowerCase()));
    const isImportOrDef = /\b(import|from|class|def|function|interface)\b/.test(trimmed);

    if (isKeywordMatch || (keywords.length > 0 && isImportOrDef && keywords.some(kw => lineLower.includes(kw.toLowerCase().split('.')[0])))) {
      const pathMatch = trimmed.match(/\b(src\/sandbox\/[a-zA-Z0-9_\-\/]+\.[a-zA-Z0-9]+)\b/);
      if (pathMatch) {
        foundFiles.add(pathMatch[1]);
      }
      matchedLines.push(trimmed);
    }
  }

  if (matchedLines.length > 0) {
    const uniqueLines = Array.from(new Set(matchedLines)).slice(0, 15);
    const formattedLines = uniqueLines.map(l => `- \`${l}\``).join('\n');

    const relevantFilesList = foundFiles.size > 0
      ? Array.from(foundFiles)
      : targetFiles;

    const fileSection = relevantFilesList.length > 0
      ? `\n\n**Relevant File(s):**\n${relevantFilesList.map(f => `- \`${f}\``).join('\n')}`
      : '';

    return `Based on the codebase analysis, here is the relevant information for "${userQuery}":\n\n${formattedLines}${fileSection}`;
  }

  // Generic clean snippet fallback without internal context headers
  const cleanSnippet = lines
    .filter(l => l.trim() && !l.startsWith('===') && !l.startsWith('Target Files:') && !l.startsWith('AST Symbols:'))
    .slice(0, 8)
    .join('\n');

  return `Based on the codebase analysis for "${userQuery}":\n\n${cleanSnippet}`;
}
