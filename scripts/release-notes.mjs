// The body of a GitHub release: what changed, then how to install it.
//
// The "what changed" half is lifted out of CHANGELOG.md rather than written
// again here, so the account of a release is one text that reaches three
// places: the file on GitHub, the release page, and the What's new list inside
// the app. The install half lives here because it is the same every time and
// had been copied into both halves of release.yml, where the two copies could
// drift apart without anyone noticing.
//
// Usage: node scripts/release-notes.mjs <tag-or-version>
//
// Exits non-zero when a version tag has no section in the changelog. That is
// deliberate and it runs before the build: cutting a release nobody can read
// is the thing this whole exercise is meant to stop, and finding out at the
// start of the job costs nothing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const INSTALL = `## Installing

Download the build for your machine, then:

**macOS**: open the \`.dmg\` and drag OctoShell to Applications. The build is for Apple Silicon (M1 and later); there is no Intel build.
These builds are unsigned, so the first launch is blocked with "Apple could not verify OctoShell is free of malware". Open **System Settings > Privacy & Security**, scroll to Security, and click **Open Anyway** next to OctoShell, then launch it again. (Control-click > Open no longer works for unsigned apps on macOS 15 Sequoia and later.) From a terminal, \`xattr -dr com.apple.quarantine /Applications/OctoShell.app\` does the same thing in one step.

**Windows**: run the installer. SmartScreen will warn because the build is unsigned: **More info > Run anyway**.`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = readFileSync(join(root, "CHANGELOG.md"), "utf8");

/** The bullets under one `## version (date)` heading, as written. */
function section(wanted) {
  const lines = raw.split(/\r?\n/);
  const heading = /^##\s+(.+?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;
  let collecting = false;
  const out = [];
  for (const line of lines) {
    const m = heading.exec(line);
    if (m) {
      if (collecting) break; // the next release starts here
      collecting = m[1].trim() === wanted;
      continue;
    }
    if (collecting) out.push(line);
  }
  return out.join("\n").trim();
}

const arg = process.argv[2] ?? "";
// A tag is the version with a `v` in front of it; anything else (a manual run
// from a branch) has no release section yet and reads the unreleased one.
const isTag = /^v\d+\.\d+\.\d+/.test(arg);
const version = isTag ? arg.replace(/^v/, "") : "Unreleased";

const changes = section(version);
if (!changes) {
  if (isTag) {
    console.error(
      `No "## ${version}" section in CHANGELOG.md.\n` +
        `Add one (rename the Unreleased heading to "## ${version} (YYYY-MM-DD)") and tag again.`,
    );
    process.exit(1);
  }
  console.error(`No "## Unreleased" section in CHANGELOG.md; the notes will be the install steps alone.`);
}

const heading = isTag ? "## What's new" : "## What's new (unreleased build)";
process.stdout.write(changes ? `${heading}\n\n${changes}\n\n${INSTALL}\n` : `${INSTALL}\n`);
