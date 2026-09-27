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

async function bootstrap() {
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
