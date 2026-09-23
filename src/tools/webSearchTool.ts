export interface WebSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export async function performWebSearch(query: string): Promise<WebSearchResult[]> {
  try {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
    
    const response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (!response.ok) {
      return [];
    }

    const html = await response.text();
    const results: WebSearchResult[] = [];

    // Extract search result title, snippet, and link using regex parsing
    const resultBlocks = html.split('<div class="result__body"');
    for (let i = 1; i < Math.min(resultBlocks.length, 6); i++) {
      const block = resultBlocks[i];
      const titleMatch = block.match(/<a class="result__a"[^>]*>(.*?)<\/a>/s);
      const snippetMatch = block.match(/<a class="result__snippet"[^>]*>(.*?)<\/a>/s);
      const urlMatch = block.match(/href="([^"]+)"/);

      if (titleMatch && snippetMatch) {
        const cleanTitle = titleMatch[1].replace(/<[^>]+>/g, '').trim();
        const cleanSnippet = snippetMatch[1].replace(/<[^>]+>/g, '').trim();
        let rawUrl = urlMatch ? urlMatch[1] : '';

        if (rawUrl.includes('uddg=')) {
          const match = rawUrl.match(/uddg=([^&]+)/);
          if (match) rawUrl = decodeURIComponent(match[1]);
        }

        if (cleanTitle && cleanSnippet) {
          results.push({
            title: cleanTitle,
            snippet: cleanSnippet,
            url: rawUrl
          });
        }
      }
    }

    return results;
  } catch (err) {
    console.warn('[WebSearch] Search query failed:', err);
    return [];
  }
}
