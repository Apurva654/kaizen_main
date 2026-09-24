import * as dotenv from 'dotenv';

dotenv.config();

export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
  timestamp: string; // ISO timestamp of when result was fetched
  source: 'google' | 'bing' | 'duckduckgo'; // Which search engine provided this
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
 * Search using Google Custom Search API (if available)
 * Requires: GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_ENGINE_ID in .env
 */
async function searchGoogle(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID;

  if (!apiKey || !engineId) {
    return [];
  }

  try {
    emitSearchProgress(`🔍 Searching Google for "${query}"...`);

    const searchUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${engineId}&num=5`;
    const response = await fetch(searchUrl);

    if (!response.ok) {
      console.warn(`[WebSearch] Google API returned ${response.status}`);
      return [];
    }

    const data: any = await response.json();
    const timestamp = new Date().toISOString();

    if (!data.items || data.items.length === 0) {
      return [];
    }

    emitSearchProgress(`📄 Found ${data.items.length} results from Google`);

    return data.items.slice(0, 5).map((item: any) => ({
      title: item.title || '',
      snippet: item.snippet || '',
      url: item.link || '',
      timestamp,
      source: 'google' as const
    }));
  } catch (err) {
    console.warn('[WebSearch] Google search failed:', err);
    return [];
  }
}

/**
 * Search using Bing Search API (if available)
 * Requires: BING_SEARCH_API_KEY in .env
 */
async function searchBing(query: string): Promise<WebSearchResult[]> {
  const apiKey = process.env.BING_SEARCH_API_KEY;

  if (!apiKey) {
    return [];
  }

  try {
    emitSearchProgress(`🔍 Searching Bing for "${query}"...`);

    const searchUrl = `https://api.bing.microsoft.com/v7.0/search?q=${encodeURIComponent(query)}&count=5`;
    const response = await fetch(searchUrl, {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey
      }
    });

    if (!response.ok) {
      console.warn(`[WebSearch] Bing API returned ${response.status}`);
      return [];
    }

    const data: any = await response.json();
    const timestamp = new Date().toISOString();

    if (!data.webPages || data.webPages.value.length === 0) {
      return [];
    }

    emitSearchProgress(`📄 Found ${data.webPages.value.length} results from Bing`);

    return data.webPages.value.slice(0, 5).map((item: any) => ({
      title: item.name || '',
      snippet: item.snippet || '',
      url: item.url || '',
      timestamp,
      source: 'bing' as const
    }));
  } catch (err) {
    console.warn('[WebSearch] Bing search failed:', err);
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
 * Tries multiple search engines in order until one returns results
 */
export async function performWebSearch(query: string): Promise<WebSearchResult[]> {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const cleanQuery = query.trim().slice(0, 200); // Limit to 200 chars

  emitSearchProgress(`🌐 Initiating web search for: "${cleanQuery}"`);

  // Try search engines in order
  const searchStrategies = [
    { name: 'Google', fn: () => searchGoogle(cleanQuery) },
    { name: 'Bing', fn: () => searchBing(cleanQuery) },
    { name: 'DuckDuckGo', fn: () => searchDuckDuckGo(cleanQuery) }
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