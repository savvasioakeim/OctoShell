import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** One entry in the Whisper catalogue, with what is on this machine. */
export interface WhisperModel {
  id: string;
  label: string;
  /** The trade-off, shown next to the size so it is visible before the download. */
  note: string;
  /** Roughly what the download costs; the exact figure comes from the server. */
  approxMb: number;
  installed: boolean;
  /** Actual bytes used, once installed. */
  bytes: number;
  downloading: boolean;
}

/** A `whisper://download` tick. `percent` is -1 when the server did not say how
 *  big the download is, which the UI shows as an indeterminate state rather than
 *  as 0%. */
export interface WhisperProgress {
  model: string;
  file: string;
  received: number;
  total: number;
  percent: number;
}

/** Raw shape from Rust, whose serde fields are snake_case. */
interface RawModel {
  id: string;
  label: string;
  note: string;
  approx_mb: number;
  installed: boolean;
  bytes: number;
  downloading: boolean;
}

export async function whisperModels(): Promise<WhisperModel[]> {
  const raw = await invoke<RawModel[]>("whisper_models");
  return raw.map((m) => ({
    id: m.id,
    label: m.label,
    note: m.note,
    approxMb: m.approx_mb,
    installed: m.installed,
    bytes: m.bytes,
    downloading: m.downloading,
  }));
}

/** Resolves when the model is fully on disk, rejects with a readable message. */
export function whisperDownload(id: string): Promise<void> {
  return invoke<void>("whisper_download", { id });
}

export function whisperDelete(id: string): Promise<void> {
  return invoke<void>("whisper_delete", { id });
}

/** Subscribe to download progress. Returns the unlisten function. */
export function onWhisperProgress(fn: (p: WhisperProgress) => void): Promise<() => void> {
  return listen<WhisperProgress>("whisper://download", (e) => fn(e.payload));
}

/** Sizes read better than raw bytes in a picker; one decimal is enough to tell
 *  967MB from 3GB, which is the only comparison that matters here. */
export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

export function formatBytes(bytes: number): string {
  return formatMb(Math.round(bytes / 1_000_000));
}

/** What one dictation produced, with the numbers needed to judge whether this
 *  model size is usable on this machine. */
export interface Transcript {
  text: string;
  /** The language token Whisper chose, e.g. `<|el|>`. */
  language: string;
  audioSeconds: number;
  tookMs: number;
  /** The recording hit the cap and was cut short. */
  truncated: boolean;
}

interface RawTranscript {
  text: string;
  language: string;
  audio_seconds: number;
  took_ms: number;
  truncated: boolean;
}

export function whisperRecordStart(id: string): Promise<void> {
  return invoke<void>("whisper_record_start", { id });
}

export async function whisperRecordStop(id: string): Promise<Transcript> {
  const r = await invoke<RawTranscript>("whisper_record_stop", { id });
  return {
    text: r.text,
    language: r.language,
    audioSeconds: r.audio_seconds,
    tookMs: r.took_ms,
    truncated: r.truncated,
  };
}

export function whisperRecordCancel(): Promise<void> {
  return invoke<void>("whisper_record_cancel");
}

/** Strip Whisper's `<|el|>` wrapper down to the bare language code. */
export function languageCode(token: string): string {
  return token.replace(/^<\|/, "").replace(/\|>$/, "");
}
