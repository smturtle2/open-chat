import { useMemo } from "react";
import { transform } from "sucrase";
import runtime from "virtual:artifact-runtime";

export default function ReactPreview({ content }: { content: string }) {
  const result = useMemo(() => {
    try {
      const { code } = transform(content, { transforms: ["typescript", "jsx", "imports"], production: true });
      const script = runtime + "\nOpenChatPreview.render(" + JSON.stringify(code) + ");";
      return { html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:system-ui}button,input,select,textarea{font:inherit}</style></head><body><div id="root"></div><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>` };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }, [content]);
  if (result.error) return <pre role="alert" className="p-5 text-sm whitespace-pre-wrap text-red-600">{result.error}</pre>;
  return <iframe srcDoc={result.html} sandbox="allow-scripts" className="w-full h-full border-0 bg-white" title="React Artifact Preview" />;
}
