// JetBrains Mono, bundled so it renders identically offline (the app font).
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ShellController } from "./shell/ShellController";

async function bootstrap() {
  const controller = new ShellController("main");
  // Listeners must be registered before the shell emits its first prompt.
  await controller.init();

  createRoot(document.getElementById("root")!).render(<App initial={controller} />);
}

bootstrap().catch((err) => {
  console.error("OctoShell failed to start:", err);
  document.getElementById("root")!.innerHTML = `<pre class="p-4 text-red-400">${err}</pre>`;
});
