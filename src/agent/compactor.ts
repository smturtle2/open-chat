// ---------------------------------------------------------------------------
// Directional, line-aware truncation with archive reference.
//
// Tool outputs are archived in full (tool_outputs table); only the model-facing
// surface is compacted. Bias follows where the information lives:
//   - "head": files declare things at the top (imports, types), search results
//     lead with the best matches.
//   - "tail": command output puts errors at the end (stack traces, exit codes).
// Cutting happens on line boundaries; oversized single lines get a mid-line cut.

export type TruncateBias = "head" | "tail";

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

export function truncateDirectional(text: string, bias: TruncateBias, outputId: number, maxChars: number = 60000): string {
  if (!text || text.length <= maxChars) return text;

  const lines = text.split("\n");
  const totalLines = lines.length;
  const totalSize = text.length;

  const kept: string[] = [];
  let keptChars = 0;
  let startLine = 1;
  let endLine = 0;

  const fits = (line: string) => kept.length === 0 || keptChars + line.length + 1 <= maxChars;

  if (bias === "head") {
    for (let i = 0; i < totalLines; i++) {
      if (!fits(lines[i])) break;
      kept.push(lines[i]);
      keptChars += lines[i].length + 1;
      endLine = i + 1;
    }
    startLine = 1;
  } else {
    startLine = totalLines;
    for (let i = totalLines - 1; i >= 0; i--) {
      if (!fits(lines[i])) break;
      kept.unshift(lines[i]);
      keptChars += lines[i].length + 1;
      startLine = i + 1;
    }
    endLine = totalLines;
  }

  let body = kept.join("\n");
  let midCut = "";
  if (body.length > maxChars) {
    // Single line larger than the whole budget: hard-slice it.
    body = body.slice(0, maxChars);
    midCut = " [mid-line cut]";
  }

  const notice =
    `\n\n[truncated: showing lines ${startLine}-${endLine}${midCut} of ${totalLines}` +
    ` (${fmtSize(body.length)} of ${fmtSize(totalSize)} total).` +
    ` Full copy archived as output #${outputId}.` +
    (bias === "head"
      ? ` Continue with read_output {"id": ${outputId}, "offset": ${endLine + 1}}]`
      : ` Read earlier parts with read_output {"id": ${outputId}}]`);

  return body + notice;
}

// Shared line pager (1-based offset). Mirrors fs_runner.py read semantics.
export function pageLines(text: string, offsetRaw?: number, limitRaw?: number): string {
  const lines = text.split("\n");
  const total = lines.length;

  let start = Math.trunc(Number(offsetRaw));
  if (!Number.isFinite(start)) start = 1;
  start = Math.max(start, 1);
  if (total > 0 && start > total) {
    return `Error: offset ${start} is beyond end of output (${total} lines)`;
  }

  let limit = Math.trunc(Number(limitRaw));
  if (!Number.isFinite(limit)) limit = 0;
  const end = limit <= 0 ? total + 1 : Math.min(total + 1, start + limit);

  const body = lines.slice(start - 1, end - 1).join("\n");
  if (end - 1 < total) {
    return `${body}\n[showing lines ${start}-${end - 1} of ${total} total; use offset=${end} for next page]`;
  }
  return body;
}
