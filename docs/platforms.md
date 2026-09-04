# The platform layer

OctoShell runs on Windows and macOS (Linux builds too, and is treated like macOS
everywhere below). Everything that differs between them lives in a few files, so
a feature is written once and asks the platform layer for the parts that differ.

## Backend (`src-tauri/src`)

| File | Owns |
|---|---|
| `platform.rs` | The OS name, home/cache/scratch dirs, hiding console windows, process groups, `kill_tree`, `which`, adopting the login-shell PATH (macOS), the script shell `run_capture` uses, install hints. |
| `shells.rs` | The table of shells a tab can host (`list()`), the default (`default_id()`), resolving a persisted id (`resolve()`), and how each shell is launched WITH shell integration (`commands()`): PowerShell via `-EncodedCommand`, zsh via a `ZDOTDIR` shim, bash via `--rcfile`. |
| `completion.rs` | Tab completion: PowerShell's `TabExpansion2` on Windows, a native commands+paths completer elsewhere. Same JSON either way. |
| `jobctl.rs` | Child containment: a kill-on-close Job Object on Windows; a registry of process-group leaders swept on exit elsewhere. |
| `macos.rs` | The macOS menu bar (an Edit menu so ⌘C/⌘V work in the webview; no ⌘W on the window). |

Rules of thumb:

- A module that spawns something calls `platform::background(&mut cmd)` (or
  `hide_console` for a short helper) and `jobctl::add(pid)` after spawning.
  It never writes `#[cfg(windows)]` itself.
- Killing is always `platform::kill_tree(pid)` (a process AND its descendants)
  or `platform::kill_pid(pid)` (one foreign process, e.g. whatever holds a port).
- Paths for users come from `platform::home_dir()` / `cache_dir()` /
  `scratch_dir()`.
- A one-shot script goes through `run_capture`, and is written for both script
  shells in the frontend (below). The backend never composes shell syntax.

### Adding a shell

One entry in `shells.rs`: add it to `list()` (id, label, whether OctoShell can
inject integration, whether its binary exists), and a `commands()` arm that
returns the launch command. If it gets integration, it must emit OSC 133
`A`/`B`/`C`/`D;<code>` and OSC 7 `file://host/<percent-encoded cwd>`; the
`SemanticParser` in `pty.rs` and the frontend need nothing new. The Settings
picker and the onboarding check render from `list()`.

### Adding an OS

Give each function in `platform.rs` an implementation for it (most Unix
functions already cover it), pick defaults in `shells.rs`, and add a
`tauri.<os>.conf.json` if the window needs OS-specific chrome. Then add the
OS to the frontend's `OS` type and to `dbLocationHint()`.

## Frontend (`src/platform`)

| File | Owns |
|---|---|
| `platform.ts` | `initPlatform()` (called once in `main.tsx`), then synchronous readers: `platform()`, `isWindows()`, `isMac()`, `effectiveShell()`, `shellLabel()`, `hostCommand()` (the `cmd /c` shim for npm CLIs on Windows), `hasModKey()` (⌘ vs Ctrl). |
| `shellScripts.ts` | Every script that goes through `run_capture`, in BOTH dialects side by side: PowerShell and POSIX `sh`. `shq()` quotes a value for sh. |

Rules of thumb:

- No `navigator.platform` sniffing; ask `platform()`.
- No inline shell strings at call sites; add a function to `shellScripts.ts`
  that returns both dialects, and keep the Windows string byte-identical when
  moving one there.
- Copy that names the shell uses `shellLabel()`; copy that names the OS or an
  install command branches on `platform().os`.

## Verifying a change doesn't break the other OS

- `cargo test` in `src-tauri` runs the platform/shell/completion tests.
- Type-check every `#[cfg(windows)]` path without a Windows machine. From
  macOS (`brew install mingw-w64`, `rustup target add x86_64-pc-windows-gnu`):

  ```bash
  cd src-tauri
  ORT_STRATEGY=system ORT_LIB_LOCATION=/tmp ORT_PREFER_DYNAMIC_LINK=1 \
    CARGO_TARGET_DIR=target-win cargo check --target x86_64-pc-windows-gnu
  ```

  The `ORT_*` variables stop `ort-sys` (fastembed's ONNX runtime) from trying
  to download Windows binaries it has no build for; `cargo check` never links,
  so the fake library location is never used. The MSVC target cannot be
  checked from a Mac at all (`ring` compiles C with the MSVC toolchain).
- `npm run build` type-checks the frontend for both.
