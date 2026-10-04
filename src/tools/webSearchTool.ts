import * as dotenv from 'dotenv';

dotenv.config();

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
  timestamp: string; // ISO timestamp of when result was fetched
  source: 'google' | 'duckduckgo'; // Which search engine provided this
}

// SSE emitter callback - will be set by server.ts
let globalSSEEmitter: ((eventType: string, data: any) => void) | null = null;

export function setSSEEmitter(emitter: (eventType: string, data: any) => void) {
  globalSSEEmitter = emitter;
}

function emitSearchProgress(message: string) {
  if (globalSSEEmitter) {
    globalSSEEmitter('agent_step', {
      agent: 'IntentAgent',
      status: 'thinking',
      message: message
    });
  }
}

/**
 * Search using Google Gemini API with Google Search Grounding enabled
 * Requires: GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY in .env
 */
async function searchGemini(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;

  if (!apiKey) {
    return [];
  }

  try {
    emitSearchProgress(`🔍 Searching Google via Gemini AI Grounding for "${query}"...`);

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: `Perform a web search and return standard search findings for query: "${query}". Format response clearly.`
              }
            ]
          }
        ],
        tools: [
          {
            google_search: {}
          }
        ]
      })
    });

    if (!response.ok) {
      console.warn(`[WebSearch] Gemini API returned ${response.status}`);
      return [];
    }

    const data: any = await response.json();
    const timestamp = new Date().toISOString();
    const results: WebSearchResult[] = [];

    const candidate = data.candidates?.[0];
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks;

    if (Array.isArray(groundingChunks) && groundingChunks.length > 0) {
      for (const chunk of groundingChunks) {
        if (chunk.web) {
          results.push({
            title: chunk.web.title || 'Google Search Result',
            snippet: chunk.web.title ? `Web source: ${chunk.web.title}` : '',
            url: chunk.web.uri || '',
            timestamp,
            source: 'google' as const
          });
        }
      }
    }

    if (results.length === 0 && candidate?.content?.parts?.[0]?.text) {
      const textResponse = candidate.content.parts[0].text;
      results.push({
        title: `Google Gemini Grounded Search Summary`,
        snippet: textResponse.slice(0, 300),
        url: 'https://google.com',
        timestamp,
        source: 'google' as const
      });
    }

    if (results.length > 0) {
      emitSearchProgress(`📄 Found ${results.length} results from Google Gemini Search Grounding`);
    }

    return results.slice(0, 5);
  } catch (err) {
    console.warn('[WebSearch] Gemini search failed:', err);
    return [];
  }
}

/**
 * Fallback: Search using DuckDuckGo Instant Answer API (no HTML scraping)
 * This is a lightweight JSON-based API that doesn't require authentication
 */
async function searchDuckDuckGo(query: string): Promise<WebSearchResult[]> {
  try {
    emitSearchProgress(`🔍 Searching DuckDuckGo for "${query}"...`);

    // DuckDuckGo Instant Answer API - returns JSON, no HTML parsing needed
    const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1`;

    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) {
      return [];
    }

    const data: any = await response.json();
    const timestamp = new Date().toISOString();
    const results: WebSearchResult[] = [];

    // Extract from RelatedTopics array (backup results)
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (let i = 0; i < Math.min(5, data.RelatedTopics.length); i++) {
        const topic = data.RelatedTopics[i];
        if (topic.Text) {
          results.push({
            title: topic.Text.split(' - ')[0] || 'Result',
            snippet: topic.Text || '',
            url: topic.FirstURL || '',
            timestamp,
            source: 'duckduckgo' as const
          });
        }
      }
    }

    // If we got results, emit progress
    if (results.length > 0) {
      emitSearchProgress(`📄 Found ${results.length} results from DuckDuckGo`);
    }

    return results.slice(0, 5);
  } catch (err) {
    console.warn('[WebSearch] DuckDuckGo search failed:', err);
    return [];
  }
}

/**
 * Main Web Search Function
 * Uses Gemini Search Grounding (with DuckDuckGo as keyless fallback)
 */
export async function performWebSearch(query: string, customEmitter?: (eventType: string, data: any) => void): Promise<WebSearchResult[]> {
  if (customEmitter) {
    setSSEEmitter(customEmitter);
  }
  if (!query || query.trim().length === 0) {
    return [];
  }

  const cleanQuery = query.trim().slice(0, 200); // Limit to 200 chars

  emitSearchProgress(`🌐 Initiating web search for: "${cleanQuery}"`);

  // Try search strategies in order
  const searchStrategies = [
    { name: 'Gemini Search Grounding', fn: () => searchGemini(cleanQuery) },
    { name: 'DuckDuckGo Fallback', fn: () => searchDuckDuckGo(cleanQuery) }
  ];

  for (const strategy of searchStrategies) {
    try {
      const results = await strategy.fn();
      if (results && results.length > 0) {
        emitSearchProgress(`✅ Search complete: ${results.length} results`);
        return results;
      }
    } catch (err) {
      console.warn(`[WebSearch] ${strategy.name} search error:`, err);
      continue;
    }
  }

  // No results from any engine
  emitSearchProgress(`⚠️ No results found for "${cleanQuery}"`);
  return [];
}

/**
 * Validate freshness of search results
 * Results older than MAX_AGE_HOURS are considered stale
 */
export function isResultFresh(result: WebSearchResult, maxAgeHours: number = 24): boolean {
  try {
    const resultTime = new Date(result.timestamp).getTime();
    const now = new Date().getTime();
    const ageMs = now - resultTime;
    const ageHours = ageMs / (1000 * 60 * 60);
    return ageHours <= maxAgeHours;
  } catch {
    return false;
  }
}

/**
 * Filter results by freshness
 */
export function filterFreshResults(
  results: WebSearchResult[],
  maxAgeHours: number = 24
): WebSearchResult[] {
  return results.filter(r => isResultFresh(r, maxAgeHours));
}