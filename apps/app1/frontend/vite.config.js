import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The path nginx serves this app under. Pages, assets and the HMR websocket all live below it, so one nginx
// location (/app1/) covers the whole frontend. Must start and end with "/".
const base = process.env.BASE_PATH || "/app1/";
const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:8101";

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: true,
    port: Number(process.env.PORT) || 5101,
    strictPort: true,
    // Behind nginx the Host header is the public hostname, not localhost. Dev server only.
    allowedHosts: true,
    // Polling makes file watching reliable across Docker bind mounts.
    watch: { usePolling: process.env.VITE_USE_POLLING === "true" },
    // When opened directly (http://localhost:5101/app1/) rather than through nginx, proxy the API the same way
    // nginx does: /app1/api/* -> backend /api/*.
    proxy: {
      [`${base}api`]: { target: apiTarget, rewrite: (path) => path.slice(base.length - 1) },
    },
  },
});
