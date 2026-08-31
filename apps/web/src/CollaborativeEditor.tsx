import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { CircleAlert, CircleCheck, Cloud, CloudOff, RefreshCw, UsersRound } from "lucide-react";
import type { GeneratedDraft, RefinementProposal } from "@steno/contracts";
import { api } from "./api";
import type { CollaborationValidationReport, DemoIdentityResponse } from "./types";

export interface CollaborativeEditorHandle {
  snapshotUpdate: () => string | null;
  applyProposal: (proposal: RefinementProposal) => boolean;
}

const EvidenceMetadata = Extension.create({
  name: "stenoEvidenceMetadata",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading"],
      attributes: {
        stenoRole: { default: "draft-block", renderHTML: (attrs) => ({ "data-steno-role": attrs.stenoRole }) },
        sectionId: { default: null, renderHTML: (attrs) => attrs.sectionId ? ({ "data-section-id": attrs.sectionId }) : {} },
        blockId: { default: null, renderHTML: (attrs) => attrs.blockId ? ({ "data-block-id": attrs.blockId }) : {} },
        blockKind: { default: "paragraph", renderHTML: () => ({}) },
        templateParagraphIndex: { default: null, renderHTML: () => ({}) },
        citations: { default: "[]", renderHTML: () => ({}) },
        verified: { default: false, renderHTML: (attrs) => ({ "data-verified": String(Boolean(attrs.verified)) }) },
        originalText: { default: "", renderHTML: () => ({}) },
      },
    }];
  },
});

function textNode(text: string) {
  return text ? { type: "text", text } : undefined;
}

function draftDocument(content: GeneratedDraft) {
  const nodes: Array<Record<string, unknown>> = [];
  for (const section of content.sections) {
    if (section.heading) nodes.push({
      type: "heading",
      attrs: { level: 2, stenoRole: "section-heading", sectionId: section.id, blockKind: "heading", verified: true },
      content: [textNode(section.heading)],
    });
    for (const block of section.blocks) {
      const text = textNode(block.text);
      nodes.push({
        type: block.kind === "heading" ? "heading" : "paragraph",
        attrs: {
          ...(block.kind === "heading" ? { level: 3 } : {}),
          stenoRole: "draft-block",
          sectionId: section.id,
          blockId: block.id,
          blockKind: block.kind,
          templateParagraphIndex: block.templateParagraphIndex,
          citations: JSON.stringify(block.citations),
          verified: block.verified,
          originalText: block.text,
        },
        ...(text ? { content: [text] } : {}),
      });
    }
  }
  return { type: "doc", content: nodes.length ? nodes : [{ type: "paragraph" }] };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function selectedParagraph(editor: Editor): string | null {
  const { from, to, $from } = editor.state.selection;
  const selected = editor.state.doc.textBetween(from, to, " ").trim();
  return selected || $from.parent.textContent.trim() || null;
}

function BoundEditor({
  content,
  document,
  provider,
  identity,
  synced,
  onEditor,
  onSelection,
}: {
  content: GeneratedDraft;
  document: Y.Doc;
  provider: HocuspocusProvider;
  identity: DemoIdentityResponse;
  synced: boolean;
  onEditor: (editor: Editor | null) => void;
  onSelection: (text: string | null) => void;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      EvidenceMetadata,
      Collaboration.configure({ document }),
      CollaborationCaret.configure({ provider, user: { name: identity.name, color: identity.color, id: identity.id } }),
    ],
    editorProps: { attributes: { class: "collaborative-editor", "aria-label": "Collaborative draft editor" } },
    onSelectionUpdate: ({ editor: current }) => onSelection(selectedParagraph(current)),
    onFocus: ({ editor: current }) => onSelection(selectedParagraph(current)),
    onUpdate: ({ editor: current }) => onSelection(selectedParagraph(current)),
  }, [document, provider, identity.id]);

  useEffect(() => { onEditor(editor); return () => onEditor(null); }, [editor, onEditor]);

  useEffect(() => {
    if (!synced || !editor) return;
    const metadata = document.getMap("steno");
    if (metadata.get("initialized") !== true && editor.isEmpty) {
      editor.commands.setContent(draftDocument(content));
      document.transact(() => {
        metadata.set("initialized", true);
        metadata.set("title", content.title);
        metadata.set("matterName", content.matterName);
        metadata.set("fields", JSON.stringify(content.fields));
        metadata.set("warnings", JSON.stringify(content.warnings));
      });
    }
  }, [content, document, editor, synced]);

  return <EditorContent editor={editor} />;
}

export const CollaborativeEditor = forwardRef<CollaborativeEditorHandle, {
  draftId: string;
  content: GeneratedDraft;
  websocketUrl: string;
  identity: DemoIdentityResponse;
  onSelection: (text: string | null) => void;
  onValidation: (report: CollaborationValidationReport | null) => void;
}>(function CollaborativeEditor({ draftId, content, websocketUrl, identity, onSelection, onValidation }, ref) {
  const [status, setStatus] = useState("connecting");
  const [synced, setSynced] = useState(false);
  const [presence, setPresence] = useState<Array<{ id?: string; name: string; color: string }>>([]);
  const [session, setSession] = useState<{ document: Y.Doc; provider: HocuspocusProvider } | null>(null);
  const [report, setReport] = useState<CollaborationValidationReport | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const validationTimer = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    snapshotUpdate: () => session ? toBase64(Y.encodeStateAsUpdate(session.document)) : null,
    applyProposal: (proposal) => {
      const editor = editorRef.current;
      if (!editor) return false;
      let range: { from: number; to: number } | null = null;
      editor.state.doc.descendants((node, position) => {
        if (!range && node.isTextblock && node.textContent === proposal.targetText) {
          range = { from: position + 1, to: position + node.nodeSize - 1 };
          return false;
        }
        return !range;
      });
      return range ? editor.chain().focus().insertContentAt(range, proposal.replacementText).run() : false;
    },
  }), [session]);

  useEffect(() => {
    setStatus("connecting"); setSynced(false); setPresence([]); setReport(null); onValidation(null);
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
      if (validationTimer.current !== null) window.clearTimeout(validationTimer.current);
      provider.destroy(); document.destroy(); setSession(null);
    };
  }, [draftId, identity.color, identity.id, identity.name, identity.token, onValidation, websocketUrl]);

  useEffect(() => {
    if (!session || !synced) return;
    const validate = () => {
      if (validationTimer.current !== null) window.clearTimeout(validationTimer.current);
      validationTimer.current = window.setTimeout(() => {
        const update = toBase64(Y.encodeStateAsUpdate(session.document));
        void api<CollaborationValidationReport>(`/api/collaboration/drafts/${draftId}/validate`, {
          method: "POST", body: JSON.stringify({ update }),
        }).then((next) => { setReport(next); onValidation(next); }).catch(() => undefined);
      }, 700);
    };
    session.document.on("update", validate);
    validate();
    return () => {
      session.document.off("update", validate);
      if (validationTimer.current !== null) window.clearTimeout(validationTimer.current);
    };
  }, [draftId, onValidation, session, synced]);

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
          session.provider.disconnect(); setTimeout(() => session.provider.connect(), 100);
        }}><RefreshCw size={16} /></button>
      </div>
      <div className={`live-validation ${report?.status ?? "checking"}`} aria-label="Live evidence validation">
        {report?.status === "ready" ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
        <strong>{report ? report.status === "ready" ? "Evidence checks ready" : `${report.errors} blocked · ${report.warnings} review warnings` : "Checking evidence links…"}</strong>
        {report?.issues.slice(0, 3).map((issue, index) => <span key={`${issue.blockId}-${issue.code}-${index}`}>{issue.message}</span>)}
      </div>
      <div className="collaboration-note">This live Yjs document is canonical. Lightweight checks run after edits; export freezes and validates the exact shared snapshot.</div>
      {session && <BoundEditor
        content={content}
        document={session.document}
        provider={session.provider}
        identity={identity}
        synced={synced}
        onEditor={(editor) => { editorRef.current = editor; }}
        onSelection={onSelection}
      />}
    </div>
  );
});
