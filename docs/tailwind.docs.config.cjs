// Tailwind config for the static landing page (docs/index.html). Mirrors the
// inline `tailwind.config` that the CDN build used, so the compiled stylesheet
// (assets/tw.css) carries the same custom theme — letting us drop the
// cdn.tailwindcss.com prototyping script for production.
module.exports = {
  content: ["./docs/index.html"],
  theme: {
    extend: {
      colors: {
        slatebg: "#101216",
        chrome: "#14161C",
        panel: "#1C202B",
        card: "#15181F",
        edge: "#1f232d",
        neonpurple: "#A855F7",
        neoncyan: "#38BDF8",
        muted: "#8A93A6",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
};
