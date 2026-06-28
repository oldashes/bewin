import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "work/strategy-dashboard/client",
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "../../../public",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4173",
    },
  },
});
