import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/web",
  publicDir: "../../public",
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@shared": new URL("./src/shared", import.meta.url).pathname,
      "@": new URL("./src/web", import.meta.url).pathname,
    },
  },
});
