/**
 * Drag & drop plumbing.
 *
 * The window sets `dragDropEnabled: false` (tauri.conf.json) so the project
 * sidebar keeps native HTML5 drag & drop for reordering. The cost is that a file
 * dropped from Explorer arrives as a browser `File` — bytes, no path. Agents
 * need a path, so we hand the bytes to the backend and get a scratch file back.
 */
import { invoke } from "@tauri-apps/api/core";

/** Files carried by a drop event (both `files` and the item list are checked —
 *  WebView2 populates them inconsistently depending on the drag source). */
export function filesFromDrop(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  if (dt.files?.length) return Array.from(dt.files);
  return Array.from(dt.items ?? [])
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

/** True when the drag is carrying files (so we only claim those drops and let
 *  the sidebar's own item drags pass through untouched). */
export function dragHasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types ?? []).includes("Files");
}

/** Base64 of a File, without the `data:…;base64,` prefix. */
export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // Chunked to keep String.fromCharCode off the argument-count limit on big files.
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Write a dropped file to the scratch dir; resolves to its real path. */
export async function saveDroppedFile(file: File): Promise<string> {
  const data = await fileToBase64(file);
  return await invoke<string>("save_dropped_file", {
    name: file.name || "drop",
    data,
  });
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}
