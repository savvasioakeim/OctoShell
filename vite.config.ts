import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed dev port and does not need to clear the screen.
export default defineConfig({
  // Tailwind 4 runs as a Vite plugin rather than through PostCSS. It only
  // touches stylesheets that use its directives, which is why the font CSS
  // from @fontsource passes through untouched.
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2021",
    sourcemap: true,
  },
});
