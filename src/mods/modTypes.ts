// The mod manifest: what a mod may declare, and how a declaration is checked.
//
// Two rules shape everything here, and both are deliberate:
//
// 1. A mod is DATA. There is no code to run, no entry point, no bundle. It
//    contributes entries to the same tables the app already fills in itself
//    (agent providers, project stacks, MCP servers). VS Code's extension host
//    exists because its extensions are code; ours don't need one, because the
//    moment a mod needs real logic it should be an MCP server or an ACP agent —
//    separate processes OctoShell already knows how to launch, contain and kill.
//
// 2. Validation is STRICT and reports every problem, not the first. Someone
//    writing their first mod gets one list of what's wrong instead of finding out
//    one field per attempt. A manifest that half-validates is never loaded.

import type { StackDef } from "../projects/stacks";

/** What a mod says it touches, shown in plain language before it's enabled.
 *  Nothing is granted implicitly: a contribution whose permission isn't declared
 *  is rejected, so the list the user reads is the whole truth. */
export type ModPermission = "mcp" | "agents" | "stacks" | "macros";

export const PERMISSION_LABELS: Record<ModPermission, string> = {
  mcp: "Add MCP servers the orchestrator can use",
  agents: "Add coding agents to the provider picker",
  stacks: "Teach OctoShell new project types and their commands",
  macros: "Add buttons to the macro bar that put a command in the terminal",
};

/** Which permission each contribution key requires. */
const CONTRIBUTION_PERMISSION: Record<string, ModPermission> = {
  mcpServers: "mcp",
  agentProviders: "agents",
  stacks: "stacks",
  macros: "macros",
};

/** An MCP server a mod contributes, in the shape Claude Code's config uses. */
export interface ModMcpServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** A project stack a mod contributes. Same shape the built-in table uses, minus
 *  the regexes — a manifest is JSON, so server patterns arrive as strings and are
 *  compiled here (invalid ones are a validation error, never a crash later). */
export interface ModStack {
  id: string;
  label: string;
  markers: string[];
  test?: string;
  requiresPackageScript?: string;
  serverPatterns?: string[];
}

/** A macro button a mod contributes.
 *
 *  Deliberately NOT a function. A built-in macro is `(controller) => …` and can do
 *  anything; a mod's is a command string plus how to deliver it. That keeps mods
 *  data — the button can type a command for you or run one, and nothing else. It
 *  cannot read output, chain steps, or call into the app. */
export interface ModMacro {
  /** Button text. Short — the bar collapses past three. */
  label: string;
  /** Tooltip; falls back to the command. */
  title?: string;
  /** The shell command. */
  command: string;
  /** "submit" runs it; "input" puts it in the box for the user to review first.
   *  Default is "input", the cautious one: a mod-supplied command should be seen
   *  before it runs. */
  mode?: "submit" | "input";
}

export interface ModContributions {
  mcpServers?: Record<string, ModMcpServer>;
  stacks?: ModStack[];
  macros?: ModMacro[];
  /** Reserved: agent providers. Not accepted yet — see validate(). */
  agentProviders?: unknown;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Which OctoShell versions this mod claims to work with. Advisory for now. */
  octoshell?: string;
  permissions: ModPermission[];
  contributes: ModContributions;
}

/** A mod as the app sees it: where it came from, whether it validated, and what
 *  it contributes once compiled. */
export interface LoadedMod {
  /** Folder name on disk (the identity the UI keys off — always present, even
   *  when the manifest is broken). */
  dir: string;
  path: string;
  manifest?: ModManifest;
  /** Compiled stacks, ready to merge into the built-in table. */
  stacks: StackDef[];
  /** Validated macros, ready to append to the macro bar. */
  macros: ModMacro[];
  /** Everything wrong with this mod. Non-empty means it is NOT loaded. */
  errors: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const VERSION_RE = /^\d+\.\d+\.\d+([-+].+)?$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate one manifest's parsed JSON. Returns the manifest plus compiled
 *  contributions, or the full list of problems. `dir` is the folder name, which
 *  the id must match — otherwise two mods could fight over one id. */
export function validateManifest(
  dir: string,
  raw: unknown,
): { manifest: ModManifest; stacks: StackDef[]; macros: ModMacro[] } | { errors: string[] } {
  const errors: string[] = [];

  if (!isPlainObject(raw)) return { errors: ["mod.json must contain a JSON object"] };

  const id = raw.id;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    errors.push('"id" must be lowercase letters, digits and dashes (2-63 chars)');
  } else if (id !== dir) {
    errors.push(`"id" is "${id}" but the folder is "${dir}" — they must match`);
  }

  if (typeof raw.name !== "string" || !raw.name.trim()) errors.push('"name" is required');
  if (typeof raw.version !== "string" || !VERSION_RE.test(raw.version)) {
    errors.push('"version" must look like 1.2.3');
  }
  for (const opt of ["description", "author", "octoshell"] as const) {
    if (raw[opt] !== undefined && typeof raw[opt] !== "string") {
      errors.push(`"${opt}" must be a string`);
    }
  }

  // --- permissions ---
  const perms = raw.permissions;
  const known = Object.keys(PERMISSION_LABELS) as ModPermission[];
  let permissions: ModPermission[] = [];
  if (!Array.isArray(perms)) {
    errors.push('"permissions" must be an array (use [] for a mod that declares nothing)');
  } else {
    const bad = perms.filter((p) => typeof p !== "string" || !known.includes(p as ModPermission));
    if (bad.length) errors.push(`unknown permission(s): ${bad.map(String).join(", ")}`);
    permissions = perms.filter((p): p is ModPermission => known.includes(p as ModPermission));
  }

  // --- contributions ---
  const contributes = raw.contributes;
  const compiledStacks: StackDef[] = [];
  const out: ModContributions = {};

  if (contributes !== undefined && !isPlainObject(contributes)) {
    errors.push('"contributes" must be an object');
  } else if (isPlainObject(contributes)) {
    for (const key of Object.keys(contributes)) {
      const needed = CONTRIBUTION_PERMISSION[key];
      if (!needed) {
        errors.push(`unknown contribution "${key}"`);
        continue;
      }
      // The whole point of the permission list: it must cover what the mod does,
      // or the list the user reads is a lie.
      if (!permissions.includes(needed)) {
        errors.push(`contributes "${key}" but does not declare the "${needed}" permission`);
      }
    }

    if (contributes.mcpServers !== undefined) {
      const servers = contributes.mcpServers;
      if (!isPlainObject(servers)) {
        errors.push('"contributes.mcpServers" must be an object');
      } else {
        const ok: Record<string, ModMcpServer> = {};
        for (const [name, def] of Object.entries(servers)) {
          if (!isPlainObject(def) || typeof def.command !== "string" || !def.command.trim()) {
            errors.push(`mcpServers."${name}" needs a non-empty "command"`);
            continue;
          }
          if (def.args !== undefined && !(Array.isArray(def.args) && def.args.every((a) => typeof a === "string"))) {
            errors.push(`mcpServers."${name}".args must be an array of strings`);
            continue;
          }
          if (def.env !== undefined && !isPlainObject(def.env)) {
            errors.push(`mcpServers."${name}".env must be an object`);
            continue;
          }
          ok[name] = {
            command: def.command,
            args: def.args as string[] | undefined,
            env: def.env as Record<string, string> | undefined,
          };
        }
        out.mcpServers = ok;
      }
    }

    if (contributes.stacks !== undefined) {
      if (!Array.isArray(contributes.stacks)) {
        errors.push('"contributes.stacks" must be an array');
      } else {
        contributes.stacks.forEach((s, i) => {
          const where = `stacks[${i}]`;
          if (!isPlainObject(s)) {
            errors.push(`${where} must be an object`);
            return;
          }
          if (typeof s.id !== "string" || !s.id.trim()) errors.push(`${where}.id is required`);
          if (typeof s.label !== "string" || !s.label.trim()) errors.push(`${where}.label is required`);
          if (!Array.isArray(s.markers) || !s.markers.length || !s.markers.every((m) => typeof m === "string")) {
            errors.push(`${where}.markers must be a non-empty array of file names`);
          }
          for (const opt of ["test", "requiresPackageScript"] as const) {
            if (s[opt] !== undefined && typeof s[opt] !== "string") errors.push(`${where}.${opt} must be a string`);
          }
          // Patterns arrive as strings; compile them HERE so a bad regex is a
          // validation error the author sees, not an exception at match time.
          const patterns: RegExp[] = [];
          if (s.serverPatterns !== undefined) {
            if (!Array.isArray(s.serverPatterns)) {
              errors.push(`${where}.serverPatterns must be an array of strings`);
            } else {
              for (const p of s.serverPatterns) {
                if (typeof p !== "string") {
                  errors.push(`${where}.serverPatterns must contain only strings`);
                  continue;
                }
                try {
                  patterns.push(new RegExp(p, "i"));
                } catch (e) {
                  errors.push(`${where}.serverPatterns: invalid regex ${JSON.stringify(p)} — ${e}`);
                }
              }
            }
          }
          if (typeof s.id === "string" && typeof s.label === "string" && Array.isArray(s.markers)) {
            compiledStacks.push({
              id: s.id,
              label: s.label,
              markers: s.markers as string[],
              test: s.test as string | undefined,
              requiresPackageScript: s.requiresPackageScript as string | undefined,
              serverPatterns: patterns.length ? patterns : undefined,
            });
          }
        });
        out.stacks = contributes.stacks as ModStack[];
      }
    }

    if (contributes.macros !== undefined) {
      if (!Array.isArray(contributes.macros)) {
        errors.push('"contributes.macros" must be an array');
      } else {
        const ok: ModMacro[] = [];
        contributes.macros.forEach((m, i) => {
          const where = `macros[${i}]`;
          if (!isPlainObject(m)) {
            errors.push(`${where} must be an object`);
            return;
          }
          if (typeof m.label !== "string" || !m.label.trim()) errors.push(`${where}.label is required`);
          if (typeof m.command !== "string" || !m.command.trim()) errors.push(`${where}.command is required`);
          if (m.title !== undefined && typeof m.title !== "string") errors.push(`${where}.title must be a string`);
          if (m.mode !== undefined && m.mode !== "submit" && m.mode !== "input") {
            errors.push(`${where}.mode must be "submit" or "input"`);
          }
          if (typeof m.label === "string" && typeof m.command === "string") {
            ok.push({
              label: m.label,
              title: m.title as string | undefined,
              command: m.command,
              mode: (m.mode as "submit" | "input" | undefined) ?? "input",
            });
          }
        });
        out.macros = ok;
      }
    }

    if (contributes.agentProviders !== undefined) {
      // Honest refusal rather than a silent no-op: the provider table still
      // derives its TypeScript union at compile time, so a runtime entry would
      // load but be unreachable from typed code paths. Lifting that is its own
      // change; until then, saying "not yet" beats pretending.
      errors.push('"contributes.agentProviders" is not supported yet');
    }
  }

  if (errors.length) return { errors };

  return {
    macros: (out.macros ?? []) as ModMacro[],
    manifest: {
      id: id as string,
      name: raw.name as string,
      version: raw.version as string,
      description: raw.description as string | undefined,
      author: raw.author as string | undefined,
      octoshell: raw.octoshell as string | undefined,
      permissions,
      contributes: out,
    },
    stacks: compiledStacks,
  };
}
