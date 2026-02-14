export interface FinalDirective {
  kind: "final" | "final_var";
  value: string;
}

export function extractReplCodeBlocks(text: string): string[] {
  const pattern = /```repl\s*\n([\s\S]*?)\n```/g;
  const blocks: string[] = [];

  for (const match of text.matchAll(pattern)) {
    const code = (match[1] ?? "").trim();
    if (code.length > 0) {
      blocks.push(code);
    }
  }

  return blocks;
}

export function extractFinalDirective(text: string): FinalDirective | null {
  const finalVarPattern = /^\s*FINAL_VAR\((.*?)\)/ms;
  const finalVarMatch = text.match(finalVarPattern);
  if (finalVarMatch?.[1]) {
    return {
      kind: "final_var",
      value: finalVarMatch[1].trim().replace(/^['\"]|['\"]$/g, ""),
    };
  }

  const finalPattern = /^\s*FINAL\((.*)\)\s*$/ms;
  const finalMatch = text.match(finalPattern);
  if (finalMatch?.[1]) {
    return {
      kind: "final",
      value: finalMatch[1].trim(),
    };
  }

  return null;
}

export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n... [truncated ${omitted} chars]`;
}
