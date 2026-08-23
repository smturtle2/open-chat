// Lenient JSON utilities for LLM tool-call argument parsing.
// Handles the common malformations models emit: raw newlines/tabs inside
// strings, single-quoted strings, Python literals (True/False/None),
// trailing commas, unquoted keys, and markdown code fences.

export function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json|jsonc|javascript|js)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export function repairJsonText(raw: string): string {
  const out: string[] = [];
  const n = raw.length;
  let i = 0;
  let mode: "none" | "dq" | "sq" = "none";

  while (i < n) {
    const ch = raw[i];

    if (mode === "dq") {
      if (ch === "\\") {
        out.push(ch);
        if (i + 1 < n) {
          out.push(raw[i + 1]);
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (ch === '"') {
        mode = "none";
        out.push(ch);
        i++;
        continue;
      }
      if (ch === "\n") {
        out.push("\\n");
        i++;
        continue;
      }
      if (ch === "\r") {
        out.push("\\r");
        i++;
        continue;
      }
      if (ch === "\t") {
        out.push("\\t");
        i++;
        continue;
      }
      out.push(ch);
      i++;
      continue;
    }

    if (mode === "sq") {
      if (ch === "\\") {
        out.push(ch);
        if (i + 1 < n) {
          out.push(raw[i + 1]);
          i += 2;
        } else {
          i++;
        }
        continue;
      }
      if (ch === "'") {
        mode = "none";
        out.push('"');
        i++;
        continue;
      }
      if (ch === '"') {
        out.push('\\"');
        i++;
        continue;
      }
      if (ch === "\n") {
        out.push("\\n");
        i++;
        continue;
      }
      if (ch === "\r") {
        out.push("\\r");
        i++;
        continue;
      }
      if (ch === "\t") {
        out.push("\\t");
        i++;
        continue;
      }
      out.push(ch);
      i++;
      continue;
    }

    // mode === "none"
    if (ch === '"') {
      mode = "dq";
      out.push(ch);
      i++;
      continue;
    }
    if (ch === "'") {
      mode = "sq";
      out.push('"');
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$.]/.test(raw[j])) j++;
      const word = raw.slice(i, j);
      if (word === "true" || word === "false" || word === "null") {
        out.push(word);
      } else if (word === "True") {
        out.push("true");
      } else if (word === "False") {
        out.push("false");
      } else if (word === "None" || word === "NULL") {
        out.push("null");
      } else {
        // Bare word: if followed by ':' it was meant to be an unquoted key.
        let k = j;
        while (k < n && /\s/.test(raw[k])) k++;
        if (k < n && raw[k] === ":") {
          out.push(`"${word}"`);
        } else {
          out.push(word);
        }
      }
      i = j;
      continue;
    }
    if (ch === ",") {
      let k = i + 1;
      while (k < n && /\s/.test(raw[k])) k++;
      if (k < n && (raw[k] === "}" || raw[k] === "]")) {
        i++;
        continue;
      }
      out.push(ch);
      i++;
      continue;
    }
    out.push(ch);
    i++;
  }

  return out.join("");
}

function safeParse(text: string): any | undefined {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(repairJsonText(text));
    } catch {
      return undefined;
    }
  }
}

// Depth-scans text for complete top-level JSON objects, tolerating junk
// between them and malformed contents (via repair).
function scanTopLevelObjects(text: string): any[] {
  const results: any[] = [];

  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const sub = text.slice(start, i + 1);
          const parsed = safeParse(sub);
          if (parsed !== undefined) results.push(parsed);
          start = -1;
        }
      }
    }
  }

  // Recover a truncated trailing object (stream cut mid-object).
  if (depth > 0 && start !== -1) {
    const parsed = safeParse(text.slice(start));
    if (parsed !== undefined && typeof parsed === "object") results.push(parsed);
  }

  return results;
}

// Extracts all top-level JSON objects from a (possibly messy) string.
// A single complete object always yields exactly one result; multiple
// results indicate concatenated objects (provider demux bug).
export function extractJsonObjects(text: string): any[] {
  if (!text) return [];

  const cleaned = stripCodeFences(text);
  const primary = scanTopLevelObjects(cleaned);
  if (primary.length > 0) return primary;

  // Corrupted-prefix recovery: some gateways double-emit the opening '{"',
  // producing strings like '{"{"url":"..."}' whose real object starts at a
  // later '{'. Retry scanning from every later brace until one yields.
  for (let i = 1; i < cleaned.length; i++) {
    if (cleaned[i] !== "{") continue;
    const recovered = scanTopLevelObjects(cleaned.slice(i));
    if (recovered.length > 0) return recovered;
  }

  return [];
}

// Parse a tool-arguments string into a plain args object.
export function parseToolArguments(argumentsStr: string | undefined | null): Record<string, any> {
  if (!argumentsStr || !argumentsStr.trim()) return {};
  const direct = safeParse(argumentsStr.trim());
  if (direct !== undefined && typeof direct === "object" && !Array.isArray(direct)) {
    return direct;
  }
  const extracted = extractJsonObjects(argumentsStr);
  if (extracted.length > 0 && typeof extracted[0] === "object" && !Array.isArray(extracted[0])) {
    return extracted[0];
  }
  return { raw: argumentsStr };
}
