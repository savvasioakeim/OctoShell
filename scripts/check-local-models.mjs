// Local-model capability matrix for OctoShell's three agent roles.
//
// For every model it probes the SAME Ollama HTTP surface the app uses, and prints
// a ✓/✗ matrix for each role:
//   • orchestrator — plain `/api/chat` returns text (mirrors ai.rs chat_via_ollama).
//     Every model should pass; this is the pure-planner path.
//   • agent / reviewer — `/api/chat` with a `tools` array actually emits a
//     `tool_calls` response. Agents & reviewers drive tools (via OpenCode), so a
//     model that never tool-calls (or errors "does not support tools") can't fill
//     those roles. Ollama reports this natively, so we don't need OpenCode here.
//
// Usage (Ollama must be running, models pulled):
//   node scripts/check-local-models.mjs                 # all installed models
//   node scripts/check-local-models.mjs qwen2.5-coder:7b gemma3:4b
//   OLLAMA_HOST=http://localhost:11434 node scripts/check-local-models.mjs
//
// Exit code: non-zero if any model FAILS the orchestrator check (a hard break) or
// can't be reached. Tool-calling gaps are reported, not failed — they're an
// inherent model property, not a bug in OctoShell.

const BASE = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 120000);

/** POST JSON with a timeout; returns { ok, status, json|text|error }. */
async function post(path, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { /* leave undefined */ }
    return { ok: res.ok, status: res.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(t);
  }
}

async function get(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${BASE}${path}`, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Liveness: a plain chat turn must come back with non-empty text. */
async function checkAlive(model) {
  const r = await post("/api/chat", {
    model,
    stream: false,
    messages: [{ role: "user", content: "Reply with exactly the word: ready" }],
    options: { temperature: 0 },
  });
  if (!r.ok) return { pass: false, note: r.error || `HTTP ${r.status}: ${(r.text || "").slice(0, 80)}` };
  const content = r.json?.message?.content?.trim() || "";
  return content ? { pass: true } : { pass: false, note: "empty reply" };
}

/** The REAL orchestrator requirement: OctoShell's orchestrator performs actions
 *  (dispatch, open QA) NOT via tool-calls but by emitting a fenced ```octo-actions
 *  block of JSON in its plain-text reply, which OctoShell then parses. So a usable
 *  orchestrator model must reliably produce that exact format on demand. A model
 *  can chat fine yet mangle the block — then dispatches/QA silently never fire. */
async function checkOrchestrator(model) {
  const system =
    "You are OctoShell's orchestrator. To dispatch work to a project's agent you MUST append " +
    "EXACTLY one fenced block to your reply, in this exact form:\n" +
    "```octo-actions\n" +
    '[{"action":"dispatch","project":"<name>","prompt":"<task>"}]\n' +
    "```\n" +
    "Write one short sentence to the user, then the block. Emit nothing after the block.";
  const r = await post("/api/chat", {
    model,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: 'Tell the project named "web" to add a README file.' },
    ],
    options: { temperature: 0 },
  });
  if (!r.ok) return { pass: false, note: r.error || `HTTP ${r.status}` };
  const content = r.json?.message?.content || "";
  const m = content.match(/```octo-actions\s*([\s\S]*?)```/);
  if (!m) return { pass: false, note: "no octo-actions block" };
  try {
    const arr = JSON.parse(m[1].trim());
    if (Array.isArray(arr) && arr[0]?.action === "dispatch" && arr[0]?.project && arr[0]?.prompt) {
      return { pass: true, note: "valid dispatch block" };
    }
    return { pass: false, note: "block JSON missing fields" };
  } catch {
    return { pass: false, note: "block JSON invalid" };
  }
}

/** The agent/reviewer path: given a tool, does the model actually call it? */
async function checkTools(model) {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file from the repository and return its contents.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Path to the file" } },
          required: ["path"],
        },
      },
    },
  ];
  const r = await post("/api/chat", {
    model,
    stream: false,
    tools,
    messages: [
      {
        role: "user",
        content: "Read the file README.md using the read_file tool. Call the tool; do not answer in prose.",
      },
    ],
    options: { temperature: 0 },
  });
  if (!r.ok) {
    const msg = (r.text || r.error || "").toLowerCase();
    if (msg.includes("does not support tools") || msg.includes("tools"))
      return { pass: false, note: "no tool support" };
    return { pass: false, note: r.error || `HTTP ${r.status}` };
  }
  const calls = r.json?.message?.tool_calls;
  if (Array.isArray(calls) && calls.length > 0) {
    const name = calls[0]?.function?.name || "?";
    return { pass: true, note: `called ${name}` };
  }
  return { pass: false, note: "returned prose, no tool_call" };
}

async function main() {
  // Resolve the model list: argv, else every installed model.
  let models = process.argv.slice(2).map((m) => m.replace(/^ollama\//, ""));
  if (models.length === 0) {
    const tags = await get("/api/tags");
    if (!tags) {
      console.error(`✗ Could not reach Ollama at ${BASE}. Is it running?`);
      process.exit(2);
    }
    models = (tags.models || []).map((m) => m.name).sort();
  }
  if (models.length === 0) {
    console.error("No models to test. Pull one first (e.g. `ollama pull qwen2.5-coder:7b`).");
    process.exit(2);
  }

  console.log(`\nOllama: ${BASE}`);
  console.log(`Testing ${models.length} model(s) across 3 roles…\n`);

  const rows = [];
  let hardFail = false;
  for (const model of models) {
    process.stdout.write(`• ${model} … `);
    const alive = await checkAlive(model);
    if (!alive.pass) {
      hardFail = true;
      rows.push({ model, orch: { pass: false, note: alive.note || "unreachable" }, tool: { pass: false, note: "skipped" } });
      process.stdout.write(`✗ unreachable\n`);
      continue;
    }
    // Both roles matter independently: orchestrator = format-following, agent = tools.
    const orch = await checkOrchestrator(model);
    const tool = await checkTools(model);
    rows.push({ model, orch, tool });
    process.stdout.write(`${orch.pass ? "✓" : "✗"} orch, ${tool.pass ? "✓" : "✗"} tools\n`);
  }

  // Matrix.
  const w = Math.max(...rows.map((r) => r.model.length), 5);
  const pad = (s) => s.padEnd(w);
  console.log(`\n${pad("MODEL")}  ORCHESTRATOR   AGENT/REVIEWER (tools)`);
  console.log("-".repeat(w + 2 + 14 + 24));
  for (const { model, orch, tool } of rows) {
    const o = orch.pass ? "✓" : "✗";
    const t = tool.pass ? "✓" : "✗";
    console.log(`${pad(model)}  ${o} ${pad2(orch.note, 12)}  ${t} ${tool.note}`);
  }
  console.log(
    "\nNotes:" +
      "\n• ORCHESTRATOR tests format-following: OctoShell's orchestrator acts by emitting a" +
      "\n  fenced ```octo-actions JSON block (not tool-calls). A ✗ means the model chats but" +
      "\n  mangles that block, so dispatch/QA would silently never fire." +
      "\n• AGENT/REVIEWER share one requirement — real tool-calling. A ✗ means don't assign it" +
      "\n  as a coding/reviewer agent. Prefer qwen2.5-coder ≥7b for both roles.",
  );

  process.exit(hardFail ? 1 : 0);
}

function pad2(s, n) {
  s = String(s || "");
  return (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);
}

main();
