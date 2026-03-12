/**
 * Markdown chunking with heading boundary awareness
 */

import type { ChunkingConfig } from "./types.js";

export interface ChunkResult {
  text: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

/**
 * Estimate token count from text (simple heuristic: split on whitespace, ~0.75 tokens per word)
 */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  return Math.ceil(words.length * 0.75);
}

/**
 * Chunk markdown text respecting heading boundaries where possible
 */
export function chunkMarkdown(text: string, config: ChunkingConfig): ChunkResult[] {
  const lines = text.split("\n");
  const chunks: ChunkResult[] = [];

  let currentChunk: string[] = [];
  let chunkStartLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    currentChunk.push(line);

    const currentText = currentChunk.join("\n");
    const tokenCount = estimateTokens(currentText);

    // Check if we've reached target size
    if (tokenCount >= config.targetTokens) {
      // Look ahead for a heading boundary to break at
      let breakPoint = currentChunk.length;
      for (let j = currentChunk.length - 1; j >= Math.max(0, currentChunk.length - 10); j--) {
        if (currentChunk[j].match(/^#{1,6}\s/)) {
          breakPoint = j;
          break;
        }
      }

      // Create chunk
      const chunkLines = currentChunk.slice(0, breakPoint);
      const chunkText = chunkLines.join("\n");
      chunks.push({
        text: chunkText,
        startLine: chunkStartLine,
        endLine: chunkStartLine + chunkLines.length - 1,
        tokenCount: estimateTokens(chunkText),
      });

      // Start new chunk with overlap
      const overlapTokens = config.overlapTokens;
      const overlapLines: string[] = [];
      let overlapCount = 0;

      // Take lines from the end until we hit overlap target
      for (let j = breakPoint - 1; j >= 0 && overlapCount < overlapTokens; j--) {
        overlapLines.unshift(chunkLines[j]);
        overlapCount = estimateTokens(overlapLines.join("\n"));
      }

      currentChunk = [...overlapLines, ...currentChunk.slice(breakPoint)];
      chunkStartLine = chunkStartLine + breakPoint - overlapLines.length;
    }
  }

  // Add final chunk if any content remains
  if (currentChunk.length > 0 && currentChunk.some(line => line.trim().length > 0)) {
    const chunkText = currentChunk.join("\n");
    chunks.push({
      text: chunkText,
      startLine: chunkStartLine,
      endLine: lines.length,
      tokenCount: estimateTokens(chunkText),
    });
  }

  return chunks;
}

/**
 * Extract a snippet around the best matching line (for search results)
 */
export function extractSnippet(text: string, startLine: number, endLine: number, maxLength = 200): string {
  const lines = text.split("\n").slice(startLine - 1, endLine);
  let snippet = lines.join(" ").replace(/\s+/g, " ").trim();

  if (snippet.length > maxLength) {
    snippet = snippet.slice(0, maxLength) + "...";
  }

  return snippet;
}

/**
 * Create citation in format: path:startLine-endLine
 */
export function createCitation(path: string, startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `${path}:${startLine}`;
  }
  return `${path}:${startLine}-${endLine}`;
}
