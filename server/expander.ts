/**
 * Query expansion using LM Studio chat API
 * Expands queries into lex/vec/hyde variants for improved hybrid search
 */

import type { Config } from "./types.js";

export interface ExpandedQuery {
  type: 'lex' | 'vec' | 'hyde';
  text: string;
}

let config: Config | null = null;

// Simple LRU cache for expanded queries
const expansionCache = new Map<string, ExpandedQuery[]>();
const MAX_CACHE_SIZE = 500;

export function initExpander(cfg: Config): void {
  config = cfg;
}

export async function expandQuery(query: string): Promise<ExpandedQuery[]> {
  if (!config || !config.search.queryExpansion.enabled) return [];
  
  // Check cache first
  if (expansionCache.has(query)) {
    return expansionCache.get(query)!;
  }
  
  const url = `${config.lmstudio.baseUrl}/chat/completions`;
  const model = config.lmstudio.chatModel;
  
  const systemPrompt = `Rewrite the search query 3 ways:
1. As keywords (start with "lex:")
2. As a question (start with "vec:")  
3. As a document excerpt (start with "hyde:")`;

  const userPrompt = query;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 250,
        temperature: 0.5,
        top_p: 0.9,
        stop: ["\n\n", "Note:", "Explanation:"],
      }),
    });

    if (!response.ok) {
      console.warn(`Query expansion failed: ${response.status}`);
      return [];
    }

    const data = await response.json() as any;
    const text = data.choices?.[0]?.message?.content || '';
    
    let expansions = parseExpansions(text, query);
    
    // Fallback: if no valid expansions found, create basic variants
    if (expansions.length === 0) {
      console.warn(`No valid expansions parsed from LLM response for query: "${query}"`);
      // At minimum, try to use the original query for both search types
      expansions = [
        { type: 'vec', text: query },  // Use original for vector search too
      ];
    }
    
    // Cache the result
    cacheExpansion(query, expansions);
    
    return expansions;
  } catch (err) {
    console.warn('Query expansion error:', err);
    return [];
  }
}

function parseExpansions(text: string, originalQuery: string): ExpandedQuery[] {
  const lines = text.trim().split('\n');
  const results: ExpandedQuery[] = [];
  const queryLower = originalQuery.toLowerCase();
  
  for (const line of lines) {
    // More lenient matching - find lex:/vec:/hyde: anywhere in the line
    const match = line.match(/(lex|vec|hyde):\s*(.+)/i);
    if (!match) continue;
    
    const type = match[1].toLowerCase() as 'lex' | 'vec' | 'hyde';
    let content = match[2].trim();
    
    // Remove common trailing junk (quotes, brackets, etc.)
    content = content.replace(/^["'\[\(]+|["'\]\)]+$/g, '').trim();
    
    // Skip if it's just the original query repeated
    if (content.toLowerCase() === queryLower) continue;
    // Skip empty or too short
    if (content.length < 3) continue;
    // Skip if it looks like placeholder text
    if (content.startsWith('[') || content.toLowerCase().includes('placeholder')) continue;
    
    results.push({ type, text: content });
  }
  
  return results;
}

function cacheExpansion(query: string, expansions: ExpandedQuery[]): void {
  // Simple LRU: if cache is full, delete oldest entry
  if (expansionCache.size >= MAX_CACHE_SIZE) {
    const firstKey = expansionCache.keys().next().value;
    expansionCache.delete(firstKey);
  }
  
  expansionCache.set(query, expansions);
}

/**
 * Clear expansion cache (useful for testing or after config changes)
 */
export function clearExpansionCache(): void {
  expansionCache.clear();
}
