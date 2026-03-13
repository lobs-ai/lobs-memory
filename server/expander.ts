/**
 * Query expansion — hybrid approach:
 * 1. Template-based expansion (instant, no LLM needed)
 * 2. Optional LLM expansion for complex queries (async, cached)
 * 
 * Template expansion generates keyword variants and semantic rephrases
 * using simple NLP heuristics. This covers 80% of cases at 0ms cost.
 */

import type { Config } from "./types.js";

export interface ExpandedQuery {
  type: 'lex' | 'vec' | 'hyde';
  text: string;
}

let config: Config | null = null;

// LRU cache for LLM expansions
const llmCache = new Map<string, ExpandedQuery[]>();
const MAX_CACHE_SIZE = 500;

export function initExpander(cfg: Config): void {
  config = cfg;
}

/**
 * Expand a query into typed variants for multi-query search.
 * 
 * Strategy:
 * - Always: generate template-based lex/vec variants (0ms)
 * - If LLM enabled and query is complex: also generate HyDE passage (200-500ms)
 */
export async function expandQuery(query: string): Promise<ExpandedQuery[]> {
  if (!config || !config.search.queryExpansion.enabled) return [];

  const expansions: ExpandedQuery[] = [];

  // 1. Template-based expansion (instant)
  expansions.push(...templateExpand(query));

  // 2. LLM-based HyDE expansion (optional, for complex queries)
  if (shouldUseLLM(query)) {
    const hyde = await generateHyDE(query);
    if (hyde) expansions.push(hyde);
  }

  return expansions;
}

/**
 * Template-based expansion — generates keyword and semantic variants
 * using simple heuristics. No LLM needed, runs in <1ms.
 */
function templateExpand(query: string): ExpandedQuery[] {
  const results: ExpandedQuery[] = [];
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  // Stop words to filter from keyword variants
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
    'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
    'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
    'it', 'its', 'my', 'your', 'his', 'her', 'our', 'their', 'me', 'him',
    'us', 'them', 'and', 'but', 'or', 'if', 'about', 'up', 'down',
  ]);

  // Extract content words (non-stop words)
  const contentWords = words.filter(w => !stopWords.has(w) && w.length > 2);

  // Lex variant 1: just content words (removes noise for BM25)
  if (contentWords.length > 0 && contentWords.length < words.length) {
    results.push({ type: 'lex', text: contentWords.join(' ') });
  }

  // Lex variant 2: Add common synonyms/related terms for known patterns
  const synonymExpansion = expandSynonyms(contentWords);
  if (synonymExpansion) {
    results.push({ type: 'lex', text: synonymExpansion });
  }

  // Vec variant: rephrase as a question if it isn't one already
  if (!query.includes('?')) {
    const questionForm = toQuestion(query, contentWords);
    if (questionForm && questionForm.toLowerCase() !== query.toLowerCase()) {
      results.push({ type: 'vec', text: questionForm });
    }
  }

  // Vec variant: rephrase as a statement if it's a question
  if (query.includes('?') || query.toLowerCase().startsWith('what') || 
      query.toLowerCase().startsWith('how') || query.toLowerCase().startsWith('where')) {
    const statement = toStatement(query, contentWords);
    if (statement) {
      results.push({ type: 'vec', text: statement });
    }
  }

  return results;
}

/**
 * Expand known synonyms for common workspace/tech terms
 */
function expandSynonyms(words: string[]): string | null {
  const synonymMap: Record<string, string[]> = {
    'pr': ['pull request', 'PR'],
    'prs': ['pull requests', 'PRs'],
    'ci': ['continuous integration', 'CI', 'github actions'],
    'cd': ['continuous deployment', 'CD'],
    'gsi': ['graduate student instructor', 'GSI', 'teaching assistant'],
    'auth': ['authentication', 'authorization', 'OAuth'],
    'oauth': ['OAuth', 'authentication', 'credentials', 'token'],
    'config': ['configuration', 'settings', 'setup'],
    'env': ['environment', 'environment variables'],
    'db': ['database', 'SQLite', 'DB'],
    'api': ['API', 'endpoint', 'REST'],
    'ui': ['user interface', 'UI', 'frontend'],
    'bot': ['agent', 'bot', 'assistant'],
    'lobs': ['Lobs', 'agent', 'assistant'],
    'virt': ['Virt', 'Marcus', 'bot'],
    'paw': ['PAW', 'Personal AI Workforce', 'orchestrator'],
    'nexus': ['Nexus', 'dashboard', 'web UI'],
    'discord': ['Discord', 'chat', 'messaging'],
    'cron': ['cron', 'scheduled', 'timer', 'heartbeat'],
    'deploy': ['deployment', 'deploy', 'Docker', 'release'],
    'timeout': ['timeout', 'time limit', 'max duration', 'killed'],
    'safety': ['safety', 'rules', 'constraints', 'guardrails'],
    'approval': ['approval', 'review', 'sign-off', 'tier'],
    'schedule': ['schedule', 'calendar', 'timetable', 'classes'],
    'worker': ['worker', 'agent', 'subagent', 'spawned'],
    'memory': ['memory', 'recall', 'notes', 'daily log'],
    'knowledge': ['knowledge', 'shared memory', 'docs', 'vault'],
  };

  const expanded: string[] = [...words];
  let didExpand = false;

  for (const word of words) {
    const synonyms = synonymMap[word];
    if (synonyms) {
      expanded.push(...synonyms.filter(s => !words.includes(s.toLowerCase())));
      didExpand = true;
    }
  }

  return didExpand ? expanded.join(' ') : null;
}

/**
 * Convert a statement/phrase to question form for semantic search
 */
function toQuestion(query: string, contentWords: string[]): string | null {
  if (contentWords.length < 2) return null;

  // Common patterns
  const q = query.toLowerCase();
  if (q.includes('yesterday') || q.includes('today') || q.includes('last week')) {
    return `What happened ${query.toLowerCase().includes('yesterday') ? 'yesterday' : 'recently'}?`;
  }
  if (q.includes('schedule') || q.includes('calendar')) {
    return `What is the schedule for ${contentWords.filter(w => w !== 'schedule' && w !== 'calendar').join(' ')}?`;
  }

  return `What is ${contentWords.join(' ')}?`;
}

/**
 * Convert a question to statement form for semantic search
 */
function toStatement(query: string, contentWords: string[]): string | null {
  if (contentWords.length < 2) return null;
  return `Information about ${contentWords.join(' ')}`;
}

/**
 * Decide if we should use LLM for HyDE generation.
 * Only for queries where template expansion is insufficient.
 */
function shouldUseLLM(_query: string): boolean {
  // Disabled for now — LM Studio Qwen takes 7-20s per call which is too slow.
  // Template expansion covers 80%+ of cases at 0ms cost.
  // Re-enable when we have a faster local model or dedicated expansion model.
  return false;
}

/**
 * Generate a HyDE (Hypothetical Document Embedding) passage.
 * This creates a fake answer that gets embedded for better vector matching.
 */
async function generateHyDE(query: string): Promise<ExpandedQuery | null> {
  if (!config) return null;

  // Check cache
  const cached = llmCache.get(query);
  if (cached) {
    const hyde = cached.find(e => e.type === 'hyde');
    return hyde || null;
  }

  const url = `${config.lmstudio.baseUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.lmstudio.chatModel,
        messages: [
          { role: 'user', content: `/no_think\nWrite a 1-2 sentence document excerpt that answers: ${query}` },
          { role: 'assistant', content: 'Based on the notes:' },
        ],
        max_tokens: 100,
        temperature: 0.3,
        stop: ['\n\n'],
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as any;
    const text = (data.choices?.[0]?.message?.content || '').trim();
    
    // Clean up
    const cleaned = text
      .replace(/<\/?think>/g, '')
      .replace(/^based on the notes:\s*/i, '')
      .trim();

    if (cleaned.length < 10) return null;

    const expansion: ExpandedQuery = { type: 'hyde', text: 'Based on the notes: ' + cleaned };
    
    // Cache it
    if (llmCache.size >= MAX_CACHE_SIZE) {
      const firstKey = llmCache.keys().next().value;
      if (firstKey !== undefined) llmCache.delete(firstKey);
    }
    llmCache.set(query, [expansion]);
    
    return expansion;
  } catch (err) {
    console.warn('HyDE generation failed:', err);
    return null;
  }
}

export function clearExpansionCache(): void {
  llmCache.clear();
}
