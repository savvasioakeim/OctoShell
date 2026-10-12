// JetBrains Mono, bundled so it renders identically offline (the app font).
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./App";
import { QaWindow } from "./qa/QaWindow";
import { ShellController } from "./shell/ShellController";
import { initPlatform } from "./platform/platform";
import { settingsStore } from "./settings/settingsStore";
import { applyCachedPalette } from "./util/theme";

async function bootstrap() {
  // The colours from the last run, before anything is drawn. The chosen theme
  // loads asynchronously (see util/theme) and will confirm or correct this; the
  // point is that the window never opens in the wrong palette first.
  applyCachedPalette();
  // Same for the interface size, which is read straight from settings (those are
  // in localStorage, so they are already in hand). Without this the window opens
  // at the default size and resizes itself once React mounts.
  document.documentElement.style.fontSize = `${settingsStore.getSnapshot().appearance.fontSize}px`;

  // Which OS, which shells: everything platform-specific reads this synchronously
  // later, so it must be in place before the first render or the first PTY.
  await initPlatform();

  // The floating QA window loads the same bundle; render its UI instead of
  // the full app (no shell/PTY) when we're in that webview.
  if (getCurrentWindow().label === "qa") {
    createRoot(document.getElementById("root")!).render(<QaWindow />);
    return;
  }

  const controller = new ShellController("main");
  // Listeners must be registered before the shell emits its first prompt.
  await controller.init();

  createRoot(document.getElementById("root")!).render(<App initial={controller} />);
}

bootstrap().catch((err) => {
  console.error("OctoShell failed to start:", err);
  document.getElementById("root")!.innerHTML = `<pre class="p-4 text-red-400">${err}</pre>`;
});
