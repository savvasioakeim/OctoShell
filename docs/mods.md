# Mods

A mod teaches OctoShell about something new — a project type, an MCP server —
without touching its source.

**A mod is data.** There is no entry point, no bundle, no code to run. Installing
one copies files; it never launches anything. When a mod needs real logic, that
logic belongs in an MCP server or an ACP agent: separate processes OctoShell
already knows how to launch, contain and kill.

## Installing

Drop a folder containing a `mod.json` into:

```
%APPDATA%\com.octoshell.app\mods\<your-mod-id>\mod.json
```

Then **Settings → Mods → Reload mods**. The folder name must equal the manifest's
`id`, so two mods can never fight over one identity.

There is a working example in [`example-elixir-stack/`](mods/example-elixir-stack).

## Manifest

```jsonc
{
  "id": "example-elixir-stack",   // lowercase, digits, dashes; must match the folder
  "name": "Elixir / Phoenix",
  "version": "1.0.0",             // x.y.z
  "author": "you",                // optional
  "description": "...",           // optional
  "octoshell": "^0.1",            // optional, advisory for now

  // What this mod touches. Shown to the user in plain language before it loads.
  "permissions": ["stacks"],

  "contributes": {
    "stacks": [ /* … */ ]
  }
}
```

### Permissions are the whole truth

A contribution whose permission isn't declared is a **validation error**, not a
silent skip. That rule is the only thing that makes the list a user reads before
enabling a mod trustworthy.

| Permission | What it allows |
|---|---|
| `stacks` | Teach OctoShell new project types and their commands |
| `mcp` | Add MCP servers the orchestrator can use |
| `agents` | Add coding agents to the provider picker *(not accepted yet)* |

## Contributions

### `stacks`

How OctoShell recognises a project type and what it runs there.

```jsonc
{
  "id": "elixir",
  "label": "Elixir",
  "markers": ["mix.exs"],               // any one present = a match
  "test": "mix test",                   // optional
  "requiresPackageScript": "test",      // optional; only meaningful for package.json
  "serverPatterns": ["\\bmix\\s+phx\\.server\\b"]  // optional
}
```

`serverPatterns` are regular expressions (matched case-insensitively) for
commands that start a long-running server. They're what makes OctoShell offer to
run something as a managed service — with its own port and logs — instead of
letting it wedge a shell or, worse, an agent turn.

> **Escaping.** `mod.json` is JSON, so every backslash in a regex must be doubled:
> `\b` is written `\\b`. A single backslash makes the whole file invalid JSON, and
> the mod won't load. This trips up nearly everyone once.

Mod stacks are appended **after** the built-ins, so a mod can add a project type
but never shadow a built-in one that matches the same marker.

### `mcpServers`

MCP servers the orchestrator may use, in the same shape as Claude Code's config.
The user still ticks each one in **Settings → MCP access** — a mod can offer a
server, never grant itself use of one.

```jsonc
{
  "mcpServers": {
    "comfyui": { "command": "npx", "args": ["-y", "comfyui-mcp"] }
  }
}
```

### `agentProviders`

Not accepted yet, and rejected loudly rather than ignored. The provider table
still derives its TypeScript union at compile time, so a runtime entry would load
but stay unreachable from typed code paths. Saying "not yet" beats pretending.

## When something is wrong

Broken mods are **listed with their errors**, never hidden — a mod that silently
fails to appear is the worst outcome for someone who just installed one and is
looking for it. Validation reports every problem at once, so you fix a manifest in
one pass instead of one field per attempt.

A mod with any error does not load at all. There is no half-applied mod.

## The API is unstable

Until 1.0, this manifest may change in minor releases. That is a deliberate
trade: freezing the contract now would freeze exactly the parts of OctoShell that
are still moving. Pin `octoshell` in your manifest and expect to revisit it.
