import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../settings/settingsStore";

/* The Web Speech API has no entry in TypeScript's DOM lib and is still shipped
   under a vendor prefix, so the slice of it we touch is typed by hand. */
interface SpeechAlternative {
  transcript: string;
}
interface SpeechResult {
  isFinal: boolean;
  [index: number]: SpeechAlternative;
}
interface SpeechResultEvent {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

/** The constructor, or undefined on a platform that doesn't expose the API.
 *  On Windows this resolves: a Tauri webview is WebView2, which is Edge, and
 *  Edge recognises speech through Microsoft's own service rather than the
 *  Google endpoint that only ships in Chrome. */
function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** Turn an error code into something the person can act on. `not-allowed` is
 *  the one to watch: each webview asks for the microphone separately, so the
 *  QA window can be refused even after the main window was allowed. */
/**
 * Widen a bare language code into the region-qualified tag the Web Speech API
 * expects. The service rejects a bare "el", and which region it is paired with
 * barely moves recognition, so one sensible default per language is enough.
 */
function bcp47(code: string): string {
  if (code === "auto") return navigator.language || "en-US";
  const region: Record<string, string> = {
    en: "en-US",
    el: "el-GR",
    de: "de-DE",
    fr: "fr-FR",
    es: "es-ES",
    it: "it-IT",
  };
  return region[code] ?? code;
}

function reason(code: string | undefined, lang: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked for this window.";
    case "audio-capture":
      return "No microphone was found.";
    case "no-speech":
      return "Didn't catch anything — try again closer to the mic.";
    case "network":
      // The Web Speech API recognises nothing locally: it ships the audio to
      // the browser vendor's service, so this covers both a real outage and a
      // refusal by that service. Name both rather than send someone to check
      // their wifi for a fault that may not be theirs.
      return "Couldn't reach the speech service. Check the connection, and try again — the service also refuses a request now and then.";
    case "language-not-supported":
      return `Dictation doesn't cover ${lang}.`;
    case "aborted":
      return ""; // the person stopped it, or the window went away
    default:
      return `Dictation stopped (${code ?? "unknown error"}).`;
  }
}

export interface Dictation {
  /** The microphone is live. */
  recording: boolean;
  /** This webview exposes the API at all. */
  supported: boolean;
  /** The last failure, cleared when a new run starts. */
  error: string | null;
  /** Start if idle, stop if live. */
  toggle: () => void;
}

/**
 * Press-to-talk dictation, shared by the chat input and the QA notes.
 *
 * `append` receives each settled phrase as it lands, so the caller decides how
 * it joins what is already written. It is read through a ref, which keeps the
 * recogniser's handler on the current closure instead of the one from the
 * render that started it.
 */
export function useDictation(append: (text: string) => void): Dictation {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<Recognition | null>(null);
  const appendRef = useRef(append);
  appendRef.current = append;

  // Closing the window must not leave the microphone open.
  const { dictationLanguage } = useSettings();

  useEffect(
    () => () => {
      try {
        recRef.current?.stop();
      } catch {
        /* already gone */
      }
    },
    [],
  );

  const toggle = useCallback(() => {
    if (recRef.current) {
      try {
        recRef.current.stop(); // `onend` clears the state
      } catch {
        recRef.current = null;
        setRecording(false);
      }
      return;
    }
    const SR = recognitionCtor();
    if (!SR) {
      setError("Dictation isn't available in this webview.");
      return;
    }
    const rec = new SR();
    // Asking for the operating system's language would be the wrong question
    // whenever someone runs an English Windows and dictates in their own: the
    // service answers in the language it was asked for, so a Greek sentence
    // requested as English comes back as English spelling of Greek sounds.
    rec.lang = bcp47(dictationLanguage);
    rec.continuous = true; // one press covers a whole explanation, not one phrase
    rec.interimResults = false; // only settled text is worth writing down
    rec.onresult = (e) => {
      let txt = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) txt += e.results[i][0].transcript;
      }
      txt = txt.trim();
      if (txt) appendRef.current(txt);
    };
    rec.onend = () => {
      recRef.current = null;
      setRecording(false);
    };
    rec.onerror = (e) => {
      const msg = reason(e.error, rec.lang);
      if (msg) setError(msg);
    };
    recRef.current = rec;
    setError(null);
    try {
      rec.start();
      setRecording(true);
    } catch (err) {
      recRef.current = null;
      setRecording(false);
      setError(`Couldn't start the microphone: ${err}`);
    }
  }, [dictationLanguage]);

  return { recording, supported: recognitionCtor() !== undefined, error, toggle };
}
