import { useEffect, useId, useRef, useState } from "react";
import { FileWarning, LoaderCircle, RotateCcw } from "lucide-react";
import { api } from "./api";

type EditorConfigResponse = {
  documentServerUrl: string;
  config: Record<string, unknown>;
};

type DocumentEditor = { destroyEditor?: () => void };

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (elementId: string, config: Record<string, unknown>) => DocumentEditor;
    };
  }
}

const scriptLoads = new Map<string, Promise<void>>();

function loadDocumentServerScript(baseUrl: string): Promise<void> {
  const url = `${baseUrl.replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`;
  const existing = scriptLoads.get(url);
  if (existing) return existing;
  const load = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptLoads.delete(url);
      script.remove();
      reject(new Error("The Word editor service could not be reached."));
    };
    document.head.appendChild(script);
  });
  scriptLoads.set(url, load);
  return load;
}

export function OnlyOfficeEditor({ draftId, version, disabled, onSaved }: {
  draftId: string;
  version: number;
  disabled: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const reactId = useId().replaceAll(":", "");
  const elementId = `onlyoffice-${reactId}`;
  const editorRef = useRef<DocumentEditor | null>(null);
  const onSavedRef = useRef(onSaved);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);

  useEffect(() => {
    let cancelled = false;
    let dirty = false;
    let saveInFlight = false;
    let savedTimer: number | undefined;
    setState("loading");
    setMessage(null);
    void api<EditorConfigResponse>(`/api/drafts/${draftId}/editor-config`)
      .then(async (response) => {
        await loadDocumentServerScript(response.documentServerUrl);
        if (cancelled) return;
        if (!window.DocsAPI) {
          scriptLoads.delete(`${response.documentServerUrl.replace(/\/$/, "")}/web-apps/apps/api/documents/api.js`);
          throw new Error("The Word editor loaded without its document API.");
        }
        editorRef.current = new window.DocsAPI.DocEditor(elementId, {
          ...response.config,
          events: {
            onDocumentReady: () => { if (!cancelled) setState("ready"); },
            onDocumentStateChange: (event: { data?: boolean }) => {
              if (event.data) dirty = true;
              if (!event.data && dirty && !saveInFlight) {
                dirty = false;
                saveInFlight = true;
                window.clearTimeout(savedTimer);
                savedTimer = window.setTimeout(() => {
                  void Promise.resolve(onSavedRef.current()).finally(() => { saveInFlight = false; });
                }, 400);
              }
            },
            onError: (event: { data?: { errorDescription?: string } }) => {
              if (!cancelled) {
                setState("error");
                setMessage(event.data?.errorDescription ?? "The Word editor reported an error.");
              }
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "The Word editor could not be opened.");
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(savedTimer);
      editorRef.current?.destroyEditor?.();
      editorRef.current = null;
    };
  }, [attempt, draftId, elementId, version]);

  return <section className={`word-editor-shell ${disabled ? "disabled" : ""}`} aria-label="Editable Word document">
    <div id={elementId} className="word-editor-frame" />
    {state === "loading" && <div className="word-editor-state"><LoaderCircle className="spin" size={22} /><strong>Opening the original Word layout…</strong></div>}
    {state === "error" && <div className="word-editor-state error"><FileWarning size={24} /><strong>Word view unavailable</strong><p>{message}</p><button className="secondary" onClick={() => setAttempt((current) => current + 1)}><RotateCcw size={14} /> Retry</button></div>}
  </section>;
}
