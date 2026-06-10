import { invoke } from "@tauri-apps/api/core";

/** One completion candidate from PowerShell's engine. */
export interface CMatch {
  t: string; // completionText — what to insert
  l: string; // listItemText — what to show
  k: string; // resultType — Command / ParameterName / ProviderItem / …
}

export interface CompletionResult {
  ri: number; // replacementIndex — where the replaced token starts
  rl: number; // replacementLength — length of the replaced token
  m: CMatch[];
}

/** Ask the backend (PowerShell `TabExpansion2`) to complete a line at a caret. */
export async function requestCompletion(cwd: string, line: string, cursor: number): Promise<CompletionResult> {
  try {
    const raw = await invoke<string>("shell_complete", { cwd, line, cursor });
    const p = JSON.parse(raw);
    return { ri: p.ri ?? 0, rl: p.rl ?? 0, m: Array.isArray(p.m) ? p.m : [] };
  } catch {
    return { ri: 0, rl: 0, m: [] };
  }
}

/** Longest common prefix of the candidates (case-insensitive compare, first casing kept). */
export function longestCommonPrefix(items: string[]): string {
  if (items.length === 0) return "";
  let prefix = items[0];
  for (let s = 1; s < items.length; s++) {
    const other = items[s];
    let i = 0;
    while (i < prefix.length && i < other.length && prefix[i].toLowerCase() === other[i].toLowerCase()) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  return prefix;
}

/** Short human label for a PowerShell completion result type. */
export function kindLabel(k: string): string {
  switch (k) {
    case "Command": return "cmd";
    case "ParameterName": return "param";
    case "ProviderItem": return "file";
    case "ProviderContainer": return "dir";
    case "Variable": return "var";
    case "Property": return "prop";
    case "Method": return "method";
    case "Type": return "type";
    case "Keyword": return "kw";
    default: return k.toLowerCase();
  }
}
