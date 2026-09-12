import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const API_TARGET = process.env.API_TARGET ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    port: Number(process.env.PORT ?? 5174),
    // Proxy /api to the server so the app can use relative URLs everywhere —
    // including rendered-clip downloads streamed straight from the API.
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
