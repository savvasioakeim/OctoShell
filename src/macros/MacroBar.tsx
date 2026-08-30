import { useMemo, useState } from "react";
import { modStore, useMods } from "../mods/modStore";
import { buildProbe, parseProbe, testCommandFor, testableStackLabels } from "../projects/stacks";
import { invoke } from "@tauri-apps/api/core";
import { AiClient } from "../ai/AiClient";
import type { ShellController } from "../shell/ShellController";
import { SmartPrButton } from "./SmartPrButton";

const client = new AiClient();

/** Strip ```fences``` and whitespace from an AI reply. */
function stripFences(s: string): string {
  return s.replace(/^```[a-zA-Z]*\s*/m, "").replace(/```\s*$/m, "").trim();
}

interface Macro {
  label: string;
  title: string;
  run: (c: ShellController) => Promise<void>;
}

const MACROS: Macro[] = [
  {
    label: "🆚 VSCode",
    title: "Open the project folder in VS Code",
    run: async (controller) => {
      const cwd = controller.getCwd();
      if (!cwd) {
        controller.setInput("# (no project folder yet)");
        return;
      }
      await invoke("open_editor", { path: cwd });
    },
  },
  {
    label: "✨ Git Smart Commit",
    title: "Analyse git status and propose commit+push in the input field",
    run: async (controller) => {
      // Prefer the previous block's output if it was a git status; else capture fresh.
      const last = controller.getLastCommandBlock();
      let status = last && /git\s+status/.test(last.command) ? last.outputText : "";
      if (!status.trim()) {
        status = await invoke<string>("run_capture", {
          cwd: controller.getCwd(),
          command: "git status --porcelain=v1; git diff --stat HEAD",
        });
      }
      if (!status.trim()) {
        controller.setInput("# No changes to commit");
        return;
      }
      const system =
        "You are a CLI agent. Reply with ONE PowerShell command line and nothing else (no markdown).";
      const prompt =
        `Working dir: ${controller.getCwd()}\nGit status:\n${status}\n\n` +
        "Produce a command that stages all changes, commits with a concise " +
        'Conventional Commits message derived from the diff, then pushes.';
      const cmd = stripFences(await client.chat([{ role: "user", content: prompt }], system));
      // Propose into the input field — the user reviews and presses Enter.
      controller.setInput(cmd);
    },
  },
  {
    label: "🧪 Run tests",
    title: "Run the project tests (auto-detect: npm / cargo / pytest / go)",
    run: async (controller) => {
      const cwd = controller.getCwd();
      // One round trip: ask which marker files exist (and, for JS projects, which
      // npm scripts are defined), then decide HERE. The probe is generated from
      // the stack table, so teaching OctoShell a new stack needs no shell code.
      const out = await invoke<string>("run_capture", { cwd, command: buildProbe() });
      const hit = testCommandFor(parseProbe(out));
      if (!hit) {
        controller.setInput(`# No test command found (looked for ${testableStackLabels()})`);
        return;
      }
      // Run it as a real command so its output lands in the feed as a block.
      controller.submit(hit.command);
    },
  },
];

export function MacroBar({ controller, active = true }: { controller: ShellController; active?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Mod-contributed buttons, appended after the built-ins so a mod extends the
  // menu without reordering what the user already knows. useMods() is the
  // subscription; the store applies the enabled/disabled filter.
  const mods = useMods();
  const modMacros: Macro[] = useMemo(
    () =>
      modStore.macros().map((m) => ({
        label: m.label,
        title: m.title ?? m.command,
        // A mod supplies a command, never behaviour: "input" types it out for the
        // user to read first, "submit" runs it. Nothing else is reachable from here.
        run: async (c: ShellController) => {
          if (m.mode === "submit") c.submit(m.command);
          else c.setInput(m.command);
        },
      })),
    [mods],
  );

  const run = async (m: Macro) => {
    setBusy(m.label);
    try {
      await m.run(controller);
    } catch (e) {
      controller.setInput(`# Macro error: ${e}`);
    } finally {
      setBusy(null);
      setMoreOpen(false);
    }
  };

  // All macros live in the "⋯" menu — keeps the toolbar uncluttered.
  return (
    <div className="flex shrink-0 items-center justify-end gap-1">
      <div className="relative">
        <button
          title="Macros"
          disabled={busy !== null}
          onClick={() => setMoreOpen((o) => !o)}
          className="rounded-md bg-edge/70 px-2.5 py-1 text-xs hover:bg-accent/30 disabled:opacity-50"
        >
          {busy !== null ? <span className="octo-spinner" aria-hidden /> : "⋯"}
        </button>
        {moreOpen && (
          <ul
            className="absolute right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-edge bg-panel shadow-lg"
            style={{ minWidth: "12rem" }}
          >
            <SmartPrButton controller={controller} active={active} asMenuItem />
            {[...MACROS, ...modMacros].map((m) => (
              <li key={m.label}>
                <button
                  title={m.title}
                  disabled={busy !== null}
                  onClick={() => run(m)}
                  className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-edge disabled:opacity-70"
                >
                  <span className="inline-flex items-center gap-1.5">
                    {busy === m.label && <span className="octo-spinner" aria-hidden />}
                    {m.label}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
