// The changelog, as the app reads it.
//
// The file at the repo root is the single copy: it is what a reader sees on
// GitHub, what goes into a release, and what Settings shows. It is bundled
// into the app at build time rather than fetched, so the list works with no
// network and says the same thing as the version you are running, which is the
// point of showing it next to the updater.
//
// The parser is deliberately small. The format is a heading per release and a
// bullet per change, and nothing here tries to be Markdown: a changelog that
// needs a Markdown renderer to be legible is a changelog written wrong.

import raw from "../../CHANGELOG.md?raw";

export interface Release {
  /** "0.3.1", or "Unreleased" for the section that has no version yet. */
  version: string;
  /** ISO date from the heading, or null for the unreleased section. */
  date: string | null;
  /** One entry per change, already joined from any wrapped lines. */
  changes: string[];
}

const HEADING = /^##\s+(.+?)(?:\s+\((\d{4}-\d{2}-\d{2})\))?\s*$/;

function parse(text: string): Release[] {
  const out: Release[] = [];
  let current: Release | null = null;

  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { version: heading[1].trim(), date: heading[2] ?? null, changes: [] };
      out.push(current);
      continue;
    }
    if (!current) continue; // the preamble above the first heading

    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      current.changes.push(bullet[1].trim());
    } else if (line.trim() && current.changes.length) {
      // A wrapped continuation of the entry above it.
      current.changes[current.changes.length - 1] += ` ${line.trim()}`;
    }
  }
  return out;
}

/** Every release in the changelog, newest first, as the file orders them. */
export const RELEASES: Release[] = parse(raw);

/** The entry for a version, if the changelog has one. Tauri reports the
 *  version as it is written in tauri.conf.json, which is what the headings
 *  use, so this is a plain match rather than a semver comparison. */
export function releaseFor(version: string | null): Release | undefined {
  if (!version) return undefined;
  return RELEASES.find((r) => r.version === version);
}
