/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx,html}"],
  theme: {
    extend: {
      colors: {
        // OctoShell palette — aligned to "Material Theme Palenight" (the user's
        // VS Code theme) so the whole app reads as an extension of their editor.
        ink: "#232734", // app / feed frame
        panel: "#1C202B", // panels/bars (sidebars, titlebar, input bar)
        card: "#15181F", // block surfaces — clearly dark, the main reading surface
        well: "#0D0F14", // code wells inside blocks — darkest layer
        edge: "#313747", // borders / selection
        accent: "#7E57C2", // Palenight purple (white text reads well on it)
        muted: "#8087A8", // secondary text (between comment + foreground)
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
