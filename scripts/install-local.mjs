// Build OctoShell and install it into /Applications, signed with a STABLE identity.
//
// Why the signing matters more than it looks: macOS ties every privacy grant
// (Files and Folders, and the Sequoia "data from other apps" prompt) to the app's
// code signature. A Tauri debug bundle is only ad-hoc signed by the linker, which
// means no Team ID, an identifier like `octoshell-73f0e926…` instead of the bundle
// id, an unsealed bundle, and a cdhash that changes on EVERY build. TCC then has
// nothing stable to remember, so every rebuild wipes every permission the user
// granted and the prompts start again from zero. Signing with one identity that
// outlives the build fixes that.
//
// Where the identity comes from, first hit wins:
//   1. APPLE_SIGNING_IDENTITY in the environment
//   2. src-tauri/.signing-identity  (one line, gitignored — this is the local default)
//   3. a single "Apple Development:" identity in the login keychain
// With none of those it still builds, ad-hoc, and says plainly what that costs.
//
// No Apple Developer account? A self-signed certificate is stable too. Create one
// in Keychain Access (Certificate Assistant → Create a Certificate → type: Code
// Signing), then put its name in src-tauri/.signing-identity.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const IDENTITY_FILE = join(root, "src-tauri", ".signing-identity");
const APP = "OctoShell.app";
const BUNDLE = join(root, "src-tauri", "target", "debug", "bundle", "macos", APP);

if (process.platform !== "darwin") {
  console.error("install:local builds a macOS bundle and installs it into /Applications.");
  process.exit(1);
}

/** The signing identity to build with, or null to fall back to ad-hoc. */
function resolveIdentity() {
  const fromEnv = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (fromEnv) return { name: fromEnv, source: "APPLE_SIGNING_IDENTITY" };

  if (existsSync(IDENTITY_FILE)) {
    const fromFile = readFileSync(IDENTITY_FILE, "utf8").trim();
    if (fromFile) return { name: fromFile, source: "src-tauri/.signing-identity" };
  }

  // `security find-identity` prints lines like:  1) <sha1> "Apple Development: …"
  let listed = "";
  try {
    listed = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], {
      encoding: "utf8",
    });
  } catch {
    return null;
  }
  const dev = [...listed.matchAll(/"(Apple Development:[^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(dev)];
  if (unique.length === 1) return { name: unique[0], source: "login keychain" };
  return null;
}

/** The tauri CLI shells out to cargo, and rustup's bin dir is not always on the
 *  PATH a script inherits (it is added by an interactive shell's profile). Put it
 *  back rather than failing with a bare "No such file or directory". */
function pathWithCargo() {
  const cargoBin = join(process.env.HOME ?? "", ".cargo", "bin");
  const parts = (process.env.PATH ?? "").split(":");
  if (parts.includes(cargoBin) || !existsSync(join(cargoBin, "cargo"))) return process.env.PATH ?? "";
  return [cargoBin, ...parts].join(":");
}

function run(cmd, args, env) {
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, PATH: pathWithCargo(), ...env },
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const identity = resolveIdentity();
if (identity) {
  console.log(`\n▸ signing as ${identity.name}  (from ${identity.source})\n`);
} else {
  console.warn(
    "\n▸ NO signing identity found — building ad-hoc.\n" +
      "  macOS will forget every permission you grant the moment you rebuild.\n" +
      `  Fix: put an identity name in ${IDENTITY_FILE}\n`,
  );
}

// `createUpdaterArtifacts` is on for releases, and signing that .tar.gz needs the
// project's private updater key, which a local install neither has nor wants. Turn
// it off here rather than failing the build on a key that is not ours to hold.
run(
  "npm",
  [
    "run", "tauri", "--",
    "build", "--debug", "--bundles", "app",
    "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false } }),
  ],
  { ...(identity ? { APPLE_SIGNING_IDENTITY: identity.name } : {}) },
);

if (!existsSync(BUNDLE)) {
  console.error(`build finished but ${BUNDLE} is missing`);
  process.exit(1);
}

// Replacing the bundle under a running app leaves it with half its files swapped
// and takes any live agent session down with it. Ask, do not surprise.
const running = spawnSync("pgrep", ["-f", `${APP}/Contents/MacOS/octoshell`], { encoding: "utf8" });
if (running.status === 0) {
  console.error(
    `\n▸ OctoShell is running (pid ${running.stdout.trim().split("\n").join(", ")}).\n` +
      "  Quit it, then re-run `npm run install:local`.\n" +
      `  The signed bundle is already built at:\n  ${BUNDLE}\n`,
  );
  process.exit(1);
}

run("rsync", ["-a", "--delete", BUNDLE, "/Applications/"]);

// Show what actually got signed. `Sealed Resources` and a real `TeamIdentifier`
// are the two lines that say the permissions will survive the next build.
console.log("\n▸ installed /Applications/OctoShell.app\n");
const check = spawnSync("codesign", ["-dvvv", `/Applications/${APP}`], { encoding: "utf8" });
const report = `${check.stdout ?? ""}${check.stderr ?? ""}`
  .split("\n")
  .filter((l) => /^(Identifier|Authority|TeamIdentifier|Sealed Resources|Signature)/.test(l))
  .join("\n");
console.log(report || "(codesign reported nothing)");
if (/TeamIdentifier=not set/.test(report)) {
  console.warn("\n  TeamIdentifier is not set: permissions will reset on the next build.");
}
