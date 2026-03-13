/**
 * Knowledge graph: entity relationships extracted from text
 */

export interface Relationship {
  entity1: string;
  entity1Type: string;
  relation: string;
  entity2: string;
  entity2Type: string;
  sourceChunkId: number;
  confidence: number;
}

// Relation extraction patterns
const RELATION_PATTERNS = [
  {
    // "X teaches/works on/owns/uses/manages/created/built Y"
    regex: /(\w+)\s+(teaches|works on|owns|uses|deployed on|manages|created|built|maintains|develops)\s+(.+)/gi,
    extract: (match: RegExpMatchArray, chunkId: number): Relationship | null => {
      const entity1 = match[1].trim();
      const relation = match[2].toLowerCase().trim();
      const entity2 = match[3].trim().split(/[,;.]/)[0].trim(); // Stop at punctuation

      if (entity2.length < 2 || entity2.length > 50) return null;

      return {
        entity1,
        entity1Type: guessEntityType(entity1),
        relation,
        entity2,
        entity2Type: guessEntityType(entity2),
        sourceChunkId: chunkId,
        confidence: 0.7,
      };
    },
  },
  {
    // "X → Y" arrow notation — only when both sides are known entities (prevents junk from markdown formatting)
    regex: /(\b\w[\w\s-]{0,30}\w)\s*→\s*(\w[\w\s-]{0,30}\w)/gi,
    extract: (match: RegExpMatchArray, chunkId: number): Relationship | null => {
      const entity1 = match[1].trim();
      const entity2 = match[2].trim();

      // Only keep if at least one side is a known entity
      const type1 = guessEntityType(entity1);
      const type2 = guessEntityType(entity2);
      if (type1 === "concept" && type2 === "concept") return null;

      return {
        entity1,
        entity1Type: type1,
        relation: "connects-to",
        entity2,
        entity2Type: type2,
        sourceChunkId: chunkId,
        confidence: 0.5,
      };
    },
  },
  {
    // "X is Y's Z" (possessive)
    regex: /(\w+)\s+is\s+(\w+)'s\s+(.+)/gi,
    extract: (match: RegExpMatchArray, chunkId: number): Relationship | null => {
      const entity1 = match[1].trim();
      const entity2 = match[2].trim();
      const relation = match[3].trim().split(/[,;.]/)[0].trim();

      if (relation.length > 30) return null;

      return {
        entity1,
        entity1Type: guessEntityType(entity1),
        relation,
        entity2,
        entity2Type: guessEntityType(entity2),
        sourceChunkId: chunkId,
        confidence: 0.7,
      };
    },
  },
];

/**
 * Extract relationships from text
 */
export function extractRelationships(text: string, chunkId: number): Relationship[] {
  const relationships: Relationship[] = [];
  const seen = new Set<string>();

  for (const pattern of RELATION_PATTERNS) {
    const matches = Array.from(text.matchAll(pattern.regex));
    
    for (const match of matches) {
      const rel = pattern.extract(match, chunkId);
      if (!rel) continue;

      // Dedup by normalized key
      const key = `${rel.entity1.toLowerCase()}:${rel.relation}:${rel.entity2.toLowerCase()}`;
      if (seen.has(key)) continue;

      relationships.push(rel);
      seen.add(key);

      // Limit per chunk
      if (relationships.length >= 20) break;
    }
  }

  return relationships;
}

/**
 * Guess entity type based on known lists and heuristics
 */
function guessEntityType(entity: string): string {
  const lower = entity.toLowerCase();

  // Known people
  if (["rafe", "marcus", "virt", "lobs", "andrea"].includes(lower)) {
    return "person";
  }

  // Known projects
  if (["paw", "nexus", "lobs-memory", "lobs-core", "flock", "bot-shared",
       "paw-hub", "paw-portal", "ship-api", "lobs-sail", "lobs-sets-sail"].includes(lower)) {
    return "project";
  }

  // Known tools
  if (["openclaw", "lm studio", "docker", "tailscale", "github", "discord",
       "cloudflare", "sqlite", "bun", "vite", "react"].includes(lower)) {
    return "tool";
  }

  // Heuristics
  if (entity.match(/^[A-Z][a-z]+$/)) return "person"; // TitleCase
  if (entity.match(/^[a-z-]+$/)) return "project"; // kebab-case
  if (entity.match(/[A-Z]{2,}/)) return "tool"; // ALLCAPS or CamelCase

  return "concept";
}
