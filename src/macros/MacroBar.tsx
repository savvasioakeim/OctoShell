import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AiClient } from "../ai/AiClient";
import type { ShellController } from "../shell/ShellController";

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
    title: "Άνοιξε το project folder στο VS Code",
    run: async (controller) => {
      const cwd = controller.getCwd();
      if (!cwd) {
        controller.setInput("# (δεν υπάρχει ακόμα φάκελος project)");
        return;
      }
      await invoke("open_editor", { path: cwd });
    },
  },
  {
    label: "✨ Git Smart Commit",
    title: "Ανάλυσε το git status και πρότεινε commit+push στο input field",
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
        controller.setInput("# Δεν υπάρχουν αλλαγές για commit");
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
    title: "Τρέξε τα tests του project (auto-detect: npm / cargo / pytest / go)",
    run: async (controller) => {
      const cwd = controller.getCwd();
      // Detect the right test command from project marker files (cheap probe).
      const probe =
        "if(Test-Path package.json){try{$j=Get-Content package.json -Raw|ConvertFrom-Json;" +
        "if($j.scripts.test){'npm test'}else{'#none'}}catch{'npm test'}}" +
        "elseif(Test-Path Cargo.toml){'cargo test'}" +
        "elseif((Test-Path pyproject.toml)-or(Test-Path pytest.ini)-or(Test-Path setup.py)){'pytest'}" +
        "elseif(Test-Path go.mod){'go test ./...'}else{'#none'}";
      const cmd = (await invoke<string>("run_capture", { cwd, command: probe })).trim();
      if (!cmd || cmd === "#none") {
        controller.setInput("# Δεν βρέθηκε test command (npm/cargo/pytest/go)");
        return;
      }
      // Run it as a real command so its output lands in the feed as a block.
      controller.submit(cmd);
    },
  },
];

/** Show at most this many macros inline; the rest collapse into a "⋯" menu so
 *  the top bar stays clean as more macros are added. */
const MAX_INLINE = 3;

export function MacroBar({ controller }: { controller: ShellController }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);

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

  const inline = MACROS.slice(0, MAX_INLINE);
  const overflow = MACROS.slice(MAX_INLINE);

  return (
    <div className="flex items-center gap-1">
      {inline.map((m) => (
        <button
          key={m.label}
          title={m.title}
          disabled={busy !== null}
          onClick={() => run(m)}
          className="whitespace-nowrap rounded-md bg-edge/70 px-2.5 py-1 text-xs hover:bg-accent/30 disabled:opacity-50"
        >
          {busy === m.label ? "…" : m.label}
        </button>
      ))}

      {overflow.length > 0 && (
        <div className="relative">
          <button
            title="Περισσότερα"
            disabled={busy !== null}
            onClick={() => setMoreOpen((o) => !o)}
            className="rounded-md bg-edge/70 px-2 py-1 text-xs hover:bg-accent/30 disabled:opacity-50"
          >
            ⋯
          </button>
          {moreOpen && (
            <ul
              className="absolute right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-edge bg-panel shadow-lg"
              style={{ minWidth: "11rem" }}
            >
              {overflow.map((m) => (
                <li key={m.label}>
                  <button
                    title={m.title}
                    disabled={busy !== null}
                    onClick={() => run(m)}
                    className="block w-full whitespace-nowrap px-3 py-1.5 text-left text-xs text-gray-200 hover:bg-edge disabled:opacity-50"
                  >
                    {busy === m.label ? "…" : m.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
