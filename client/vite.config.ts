import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: "artifact-runtime",
    resolveId(id) { if (id === "virtual:artifact-runtime") return "\0artifact-runtime"; },
    async load(id) {
      if (id !== "\0artifact-runtime") return;
      const result = await build({ entryPoints: [fileURLToPath(new URL("./src/previewRuntime.ts", import.meta.url))], bundle: true, write: false,
        format: "iife", globalName: "OpenChatPreview", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
      return "export default " + JSON.stringify(result.outputFiles[0].text);
    },
  }],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
