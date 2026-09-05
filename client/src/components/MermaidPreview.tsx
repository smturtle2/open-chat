import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import DOMPurify from "dompurify";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true,
  htmlLabels: false, flowchart: { htmlLabels: false },
  secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "flowchart"] });
let nextId = 0;
export default function MermaidPreview({ content }: { content: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setError("");
    if (host.current) host.current.innerHTML = "";
    mermaid.render(`openchat-diagram-${++nextId}`, content).then(({ svg }) => {
      if (!cancelled && host.current) host.current.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
    }).catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [content]);
  return <div className="p-6 overflow-auto"><div ref={host} data-mermaid-preview />{error && <pre role="alert" className="text-sm whitespace-pre-wrap text-red-600">{error}</pre>}</div>;
}
