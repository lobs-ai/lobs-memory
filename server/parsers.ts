/**
 * Specialized parsers for non-markdown content (JSONL session files, etc.)
 */

import { basename } from "path";

export interface ParsedContent {
  text: string;
  format: "markdown" | "text";
}

/**
 * Parse lobs session transcript (JSONL format)
 * Each line is a JSON object with a message
 */
export function parseSessionJSONL(content: string, filepath: string): ParsedContent {
  const lines = content.split("\n").filter(line => line.trim().length > 0);
  const filename = basename(filepath);
  
  const output: string[] = [`[Session: ${filename}]`, ""];
  
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      
      // Only process message records
      if (record.type !== "message" || !record.message) {
        continue;
      }
      
      const msg = record.message;
      const role = msg.role;
      
      // Only index user and assistant messages
      if (!role || (role !== "user" && role !== "assistant")) {
        continue;
      }
      
      // Extract content from content array
      let content = "";
      
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Handle content array format (common in lobs sessions)
        const textParts = msg.content
          .filter((p: any) => p.type === "text" && typeof p.text === "string")
          .map((p: any) => p.text);
        content = textParts.join("\n");
      }
      
      // Skip empty content or binary/image data
      if (!content || content.trim().length === 0) continue;
      if (content.startsWith("data:image/") || content.startsWith("[Image:")) continue;
      
      // Truncate very long messages (>500 chars)
      if (content.length > 500) {
        content = content.slice(0, 497) + "...";
      }
      
      // Add to output
      const label = role === "user" ? "User" : "Assistant";
      output.push(`**${label}:** ${content}`, "");
      
    } catch (err) {
      // Malformed JSON line, skip it
      continue;
    }
  }
  
  return {
    text: output.join("\n"),
    format: "markdown", // Format as markdown so chunker handles it normally
  };
}

/**
 * Detect file type and parse accordingly
 */
export function parseFile(content: string, filepath: string): ParsedContent {
  if (filepath.endsWith(".jsonl")) {
    return parseSessionJSONL(content, filepath);
  }
  
  // Default: treat as markdown
  return {
    text: content,
    format: "markdown",
  };
}
