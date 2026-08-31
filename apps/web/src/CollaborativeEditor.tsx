import { useEffect, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { Cloud, CloudOff, RefreshCw, UsersRound } from "lucide-react";
import type { GeneratedDraft } from "@steno/contracts";
import type { DemoIdentityResponse } from "./types";

function textNode(text: string) {
  return text ? { type: "text", text } : undefined;
}

function draftDocument(content: GeneratedDraft) {
  const nodes: Array<Record<string, unknown>> = [];
  for (const section of content.sections) {
    if (section.heading) nodes.push({ type: "heading", attrs: { level: 2 }, content: [textNode(section.heading)] });
    for (const block of section.blocks) {
      const text = textNode(block.text);
      nodes.push({
        type: block.kind === "heading" ? "heading" : "paragraph",
        ...(block.kind === "heading" ? { attrs: { level: 3 } } : {}),
        ...(text ? { content: [text] } : {}),
      });
    }
  }
  return { type: "doc", content: nodes.length ? nodes : [{ type: "paragraph" }] };
}

function BoundEditor({
  content,
  document,
  provider,
  identity,
  synced,
}: {
  content: GeneratedDraft;
  document: Y.Doc;
  provider: HocuspocusProvider;
  identity: DemoIdentityResponse;
  synced: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      Collaboration.configure({ document }),
      CollaborationCaret.configure({
        provider,
        user: { name: identity.name, color: identity.color, id: identity.id },
      }),
    ],
    editorProps: { attributes: { class: "collaborative-editor", "aria-label": "Collaborative draft editor" } },
  }, [document, provider, identity.id]);

  useEffect(() => {
    if (!synced || !editor) return;
    const metadata = document.getMap("steno");
    if (metadata.get("initialized") !== true && editor.isEmpty) {
      editor.commands.setContent(draftDocument(content));
      metadata.set("initialized", true);
    }
  }, [content, document, editor, synced]);

  return <EditorContent editor={editor} />;
}

export function CollaborativeEditor({
  draftId,
  content,
  websocketUrl,
  identity,
}: {
  draftId: string;
  content: GeneratedDraft;
  websocketUrl: string;
  identity: DemoIdentityResponse;
}) {
  const [status, setStatus] = useState("connecting");
  const [synced, setSynced] = useState(false);
  const [presence, setPresence] = useState<Array<{ id?: string; name: string; color: string }>>([]);
  const [session, setSession] = useState<{ document: Y.Doc; provider: HocuspocusProvider } | null>(null);

  useEffect(() => {
    setStatus("connecting");
    setSynced(false);
    setPresence([]);
    const document = new Y.Doc();
    const provider = new HocuspocusProvider({
      url: websocketUrl,
      name: `draft:${draftId}`,
      document,
      token: identity.token,
      onStatus: ({ status: nextStatus }) => setStatus(nextStatus),
      onSynced: () => setSynced(true),
      onAwarenessUpdate: ({ states }) => {
        const users = states
          .map((state) => (state.user ?? state) as { id?: string; name?: string; color?: string })
          .filter((user): user is { id?: string; name: string; color: string } => Boolean(user?.name && user.color));
        setPresence(users.filter((user, index) => users.findIndex((candidate) => candidate.id === user.id) === index));
      },
    });
    provider.awareness?.setLocalStateField("user", { name: identity.name, color: identity.color, id: identity.id });
    setSession({ document, provider });
    return () => {
      provider.destroy();
      document.destroy();
      setSession(null);
    };
  }, [draftId, identity.color, identity.id, identity.name, identity.token, websocketUrl]);

  return (
    <div className="collaboration-panel">
      <div className="collaboration-status">
        <span className={`connection ${status}`}>
          {status === "connected" ? <Cloud size={16} /> : <CloudOff size={16} />}
          {status === "connected" && synced ? "Connected & synced" : status}
        </span>
        <div className="presence" aria-label="People in this draft">
          <UsersRound size={16} />
          {presence.map((user) => <span key={user.id ?? user.name} style={{ borderColor: user.color }} data-testid="presence-user">{user.name}</span>)}
        </div>
        <button className="icon-button" title="Reconnect collaboration" disabled={!session} onClick={() => {
          if (!session) return;
          session.provider.disconnect();
          setTimeout(() => session.provider.connect(), 100);
        }}><RefreshCw size={16} /></button>
      </div>
      <div className="collaboration-note">Live Yjs working copy · changes converge immediately and are saved as attributed snapshots. Word export still uses the reviewed versioned blocks.</div>
      {session && <BoundEditor
        content={content}
        document={session.document}
        provider={session.provider}
        identity={identity}
        synced={synced}
      />}
    </div>
  );
}
