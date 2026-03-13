/**
 * Header-aware semantic chunking for markdown
 * Preserves heading context and splits intelligently at section/paragraph boundaries
 */

import type { ChunkingConfig } from "./types.js";

export interface ChunkResult {
  text: string;
  startLine: number;
  endLine: number;
  tokenCount: number;
}

interface Section {
  heading: string;       // Full heading text (e.g. "## Approval Tiers")
  headingLevel: number;  // 1-6
  lines: string[];       // Content lines (not including the heading itself)
  startLine: number;     // 1-indexed line number where heading appears
  endLine: number;       // Last line of this section
}

/**
 * Estimate token count from text (simple heuristic: ~0.75 tokens per word)
 */
function estimateTokens(text: string): number {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  return Math.ceil(words.length * 0.75);
}

/**
 * Parse markdown into sections based on heading boundaries
 */
function parseMarkdownSections(text: string): Section[] {
  const lines = text.split("\n");
  const sections: Section[] = [];
  let currentSection: Section | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);

    if (headingMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.endLine = i;
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        heading: line,
        headingLevel: headingMatch[1].length,
        lines: [],
        startLine: i + 1, // 1-indexed
        endLine: i + 1,
      };
    } else if (currentSection) {
      currentSection.lines.push(line);
    } else {
      // Content before first heading — create implicit section
      if (sections.length === 0 || sections[sections.length - 1].heading !== "") {
        currentSection = {
          heading: "",
          headingLevel: 0,
          lines: [line],
          startLine: i + 1,
          endLine: i + 1,
        };
      } else {
        sections[sections.length - 1].lines.push(line);
      }
    }
  }

  // Save final section
  if (currentSection) {
    currentSection.endLine = lines.length;
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Build heading context path for a section (e.g. "MEMORY.md > People > Rafe")
 */
function buildHeadingContext(sections: Section[], index: number, filename: string): string {
  const current = sections[index];
  if (!current.heading) return ""; // No heading

  const hierarchy: string[] = [];
  
  // Walk backwards to find parent headings
  for (let i = index; i >= 0; i--) {
    const section = sections[i];
    if (!section.heading) continue;

    // Add this heading if it's a parent (lower level number = higher in hierarchy)
    if (hierarchy.length === 0 || section.headingLevel < sections[index].headingLevel) {
      // Extract heading text without the # markers
      const headingText = section.heading.replace(/^#+\s+/, '');
      hierarchy.unshift(headingText);
      
      // Stop when we reach a top-level heading
      if (section.headingLevel === 1) break;
    }
  }

  // Prepend filename if we have a hierarchy
  if (hierarchy.length > 0) {
    const fileBaseName = filename.split('/').pop() || filename;
    hierarchy.unshift(fileBaseName);
  }

  return hierarchy.length > 0 ? `[${hierarchy.join(' > ')}]\n` : '';
}

/**
 * Split section content at paragraph boundaries (blank lines)
 */
function splitAtParagraphs(lines: string[], targetTokens: number): string[][] {
  const paragraphs: string[][] = [];
  let currentParagraph: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      if (currentParagraph.length > 0) {
        paragraphs.push(currentParagraph);
        currentParagraph = [];
      }
      paragraphs.push([line]); // Keep blank line
    } else {
      currentParagraph.push(line);
    }
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph);
  }

  // Group paragraphs into chunks that fit target size
  const groups: string[][] = [];
  let currentGroup: string[] = [];
  let currentTokens = 0;

  for (const para of paragraphs) {
    const paraText = para.join("\n");
    const paraTokens = estimateTokens(paraText);

    if (currentTokens + paraTokens > targetTokens && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [...para];
      currentTokens = paraTokens;
    } else {
      currentGroup.push(...para);
      currentTokens += paraTokens;
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups.length > 0 ? groups : [lines];
}

/**
 * Chunk markdown with header-aware semantic splitting
 */
export function chunkMarkdown(text: string, config: ChunkingConfig, filename = ""): ChunkResult[] {
  const sections = parseMarkdownSections(text);
  const chunks: ChunkResult[] = [];
  const minTokens = 80;
  const maxTokens = 600;

  // If no sections (no headings), fall back to paragraph-based splitting
  if (sections.length === 0 || sections.every(s => !s.heading)) {
    return chunkByParagraphs(text, config);
  }

  let i = 0;
  while (i < sections.length) {
    const section = sections[i];
    const sectionText = section.lines.join("\n");
    const sectionTokens = estimateTokens(sectionText);

    // Build heading context prefix
    const contextPrefix = buildHeadingContext(sections, i, filename);

    if (sectionTokens < minTokens && i < sections.length - 1) {
      // Section too small — merge with next sibling
      const nextSection = sections[i + 1];
      const mergedText = contextPrefix + sectionText + "\n" + nextSection.lines.join("\n");
      const mergedTokens = estimateTokens(mergedText);

      chunks.push({
        text: mergedText,
        startLine: section.startLine,
        endLine: nextSection.endLine,
        tokenCount: mergedTokens,
      });

      i += 2; // Skip next section since we merged it
    } else if (sectionTokens > maxTokens) {
      // Section too large — split at paragraph boundaries
      const groups = splitAtParagraphs(section.lines, config.targetTokens);
      
      for (let j = 0; j < groups.length; j++) {
        const groupText = contextPrefix + groups[j].join("\n");
        const groupTokens = estimateTokens(groupText);
        
        // Calculate line numbers for this group
        const linesBeforeGroup = groups.slice(0, j).reduce((sum, g) => sum + g.length, 0);
        const startLine = section.startLine + linesBeforeGroup;
        const endLine = startLine + groups[j].length - 1;

        chunks.push({
          text: groupText,
          startLine,
          endLine,
          tokenCount: groupTokens,
        });
      }
      i++;
    } else {
      // Section is good size — use as-is
      chunks.push({
        text: contextPrefix + sectionText,
        startLine: section.startLine,
        endLine: section.endLine,
        tokenCount: estimateTokens(contextPrefix + sectionText),
      });
      i++;
    }
  }

  return chunks;
}

/**
 * Fallback for non-markdown or heading-less content: split at paragraph boundaries
 */
function chunkByParagraphs(text: string, config: ChunkingConfig): ChunkResult[] {
  const lines = text.split("\n");
  const chunks: ChunkResult[] = [];
  
  const groups = splitAtParagraphs(lines, config.targetTokens);
  let currentLine = 1;

  for (const group of groups) {
    const groupText = group.join("\n");
    const tokenCount = estimateTokens(groupText);

    chunks.push({
      text: groupText,
      startLine: currentLine,
      endLine: currentLine + group.length - 1,
      tokenCount,
    });

    currentLine += group.length;
  }

  return chunks;
}

/**
 * Extract a snippet with heading context if available
 */
export function extractSnippet(text: string, startLine: number, endLine: number, maxLength = 200): string {
  const lines = text.split("\n").slice(startLine - 1, endLine);
  let snippet = lines.join(" ").replace(/\s+/g, " ").trim();

  // Extract heading context if present (pattern: [Something > Something])
  const contextMatch = snippet.match(/^\[([^\]]+)\]/);
  let context = "";
  
  if (contextMatch) {
    context = contextMatch[1] + ": ";
    snippet = snippet.slice(contextMatch[0].length).trim();
  }

  // Truncate content but keep context
  if (context.length + snippet.length > maxLength) {
    const availableLength = maxLength - context.length - 3; // -3 for "..."
    snippet = snippet.slice(0, availableLength) + "...";
  }

  return context + snippet;
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
