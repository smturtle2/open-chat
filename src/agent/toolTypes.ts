// Shared tool-layer types and tiny pure helpers. Kept dependency-free so
// both the tool registry and low-level modules (filesys) can import without
// cycles.

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

// Multipart observation (e.g. view_image): text summary plus content parts
// replayed verbatim into the tool message on the wire.
export interface ToolObservation {
  text: string;
  kind?: "image";
  path?: string;
}

// Envelope persisted in the tool record's content column. Image BYTES are not
// stored — only a path; buildHistory re-reads the file at prompt-build time
// and degrades to plain text if it has vanished.
export function serializeObservation(obs: ToolObservation | string): string {
  if (typeof obs === "string") return obs;
  return JSON.stringify({ __obs__: obs.kind ?? "image", text: obs.text, path: obs.path });
}

export function parseObservation(content: string): ToolObservation | null {
  if (!content.startsWith("{")) return null;
  try {
    const o = JSON.parse(content);
    if (o && o.__obs__ === "image" && typeof o.path === "string") {
      return { text: typeof o.text === "string" ? o.text : "", kind: "image", path: o.path };
    }
  } catch {}
  return null;
}

// Content-sniffing beats extensions: uploads are frequently misnamed
// (screenshot saved as .bin, JPEG named .png).
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  const head = buf.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
