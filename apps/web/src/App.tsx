import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  ArrowLeft, Check, ChevronRight, CircleAlert, Download, ExternalLink, FileText,
  LoaderCircle, Plus, RotateCcw, Search, Send, Sparkles, Upload, X,
} from "lucide-react";
import type {
  Citation, DraftBlock, GeneratedDraft, RefinementAnnotation, RefinementEdit, ReviewFlag, TemplateRegion,
} from "@steno/contracts";
import { api, streamEvent, upload } from "./api";
import type {
  ActivityResponse, DraftResponse, JobResponse, MatterResponse, ProposalResponse, TemplateResponse,
} from "./types";

type WorkspaceTab = "refine" | "activity";
type ChatMessage = { role: "user" | "assistant"; text: string; annotationCount?: number };
type SelectionPopover = RefinementAnnotation & { x: number; y: number };
type SelectedSource = { sourceId: string; sourceName: string; page: number; text: string; mimeType?: string };

function blockDoc(text: string) {
  return text
    ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
    : { type: "doc", content: [{ type: "paragraph" }] };
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function templateLabel(name: string) {
  return name.replace(/\.docx$/i, "").replace(/[-_]+/g, " ");
}

function templateDisplayName(template: TemplateResponse) {
  return template.displayName || templateLabel(template.name);
}

function templateCreatedLabel(createdAt?: string) {
  if (!createdAt) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(createdAt));
}

function renderProposedText(text: string, edits: RefinementEdit[]) {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ordered.forEach((edit, index) => {
    nodes.push(<span key={`before-${index}`}>{text.slice(cursor, edit.start)}</span>);
    nodes.push(<del key={`delete-${index}`}>{edit.targetText}</del>);
    nodes.push(<ins key={`insert-${index}`}>{edit.replacementText}</ins>);
    cursor = edit.end;
  });
  nodes.push(<span key="after">{text.slice(cursor)}</span>);
  return nodes;
}

function BlockEditor({
  block, active, citationNumbers, edits, disabled, onFocus, onChange, onBlur, onCitation, onSelect, onConfirm,
}: {
  block: DraftBlock;
  active: boolean;
  citationNumbers: number[];
  edits: RefinementEdit[];
  disabled: boolean;
  onFocus: () => void;
  onChange: (text: string) => void;
  onBlur: (text: string) => void;
  onCitation: (index: number) => void;
  onSelect: (selection: SelectionPopover) => void;
  onConfirm: () => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, bulletList: false, orderedList: false, blockquote: false, codeBlock: false })],
    content: blockDoc(block.text),
    editable: edits.length === 0 && !disabled,
    editorProps: { attributes: { class: "block-editor", "aria-label": `Editable paragraph ${block.id}` } },
    onFocus,
    onUpdate: ({ editor: current }) => onChange(current.getText()),
    onBlur: ({ editor: current }) => onBlur(current.getText()),
  }, [block.id]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(edits.length === 0 && !disabled);
  }, [disabled, editor, edits.length]);

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.getText() !== block.text && edits.length === 0) {
      editor.commands.setContent(blockDoc(block.text), { emitUpdate: false });
    }
  }, [block.text, editor, edits.length]);

  const captureSelection = (event: React.MouseEvent<HTMLDivElement>) => {
    if (edits.length) return;
    const selection = window.getSelection();
    const root = event.currentTarget.querySelector<HTMLElement>(".ProseMirror");
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !root || !root.contains(selection.anchorNode)) return;
    const quote = selection.toString();
    if (quote.trim().length < 4) return;
    const range = selection.getRangeAt(0);
    const prefix = document.createRange();
    prefix.selectNodeContents(root);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const rect = range.getBoundingClientRect();
    onSelect({ blockId: block.id, quote, start, end: start + quote.length, x: rect.left + rect.width / 2, y: rect.top });
  };

  return (
    <div className={`draft-block ${active ? "active" : ""} ${block.kind === "warning" ? "unsupported" : ""}`} onClick={onFocus}>
      {block.kind === "warning" && <CircleAlert className="warning-icon" size={15} aria-label="Attorney review required" />}
      {edits.length
        ? <div className="block-editor proposal-render" aria-label={`Proposed changes for ${block.id}`}>{renderProposedText(block.text, edits)}</div>
        : <div onMouseUp={captureSelection}><EditorContent editor={editor} /></div>}
      <div className="citation-row" contentEditable={false}>
        {block.citations.map((citation, index) => (
          <button
            className="citation-pill"
            key={`${citation.sourceId}-${citation.page}-${index}`}
            onClick={(event) => { event.stopPropagation(); onCitation(index); }}
            title={`${citation.sourceName}, page ${citation.page ?? "unavailable"}`}
          >
            {citationNumbers[index]}
          </button>
        ))}
        {!block.verified && !block.userConfirmed && <span className="needs-review">Attorney review required</span>}
        {block.userConfirmed && <span className="attorney-confirmed">Attorney confirmed</span>}
        {!block.verified && !block.userConfirmed && <button className="confirm-block" onClick={(event) => { event.stopPropagation(); onConfirm(); }}><Check size={12} /> Confirm reviewed text</button>}
      </div>
    </div>
  );
}

function RegionReviewModal({ template, onCancel, onConfirmed }: {
  template: TemplateResponse;
  onCancel: () => void;
  onConfirmed: (template: TemplateResponse) => void;
}) {
  const [regions, setRegions] = useState<TemplateRegion[]>(template.confirmedRegions ?? template.analysis.regions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const counts = useMemo(() => ({
    editable: regions.filter((region) => region.role === "editable").length,
    preserve: regions.filter((region) => region.role === "preserve").length,
    heading: regions.filter((region) => region.role === "heading").length,
  }), [regions]);

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const confirmed = await api<TemplateResponse>(`/api/templates/${template.id}/confirm`, {
        method: "POST", body: JSON.stringify({ regions }),
      });
      onConfirmed(confirmed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Template confirmation failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="region-modal" role="dialog" aria-modal="true" aria-labelledby="region-title">
        <div className="modal-head">
          <div><p className="eyebrow">Template safety check</p><h2 id="region-title">Confirm what AI may replace</h2></div>
          <button className="icon-button" onClick={onCancel} aria-label="Close template review"><X size={18} /></button>
        </div>
        <p className="modal-copy">Case-specific text must be replaceable; reusable legal language should stay preserved. Review the detected regions before this template can be used.</p>
        <div className="region-summary">
          <span><strong>{counts.editable}</strong> replaceable</span>
          <span><strong>{counts.preserve}</strong> preserved</span>
          <span><strong>{counts.heading}</strong> headings</span>
        </div>
        <div className="region-review-list">
          {regions.map((region) => (
            <div className="region-review-row" key={region.paragraphIndex}>
              <select
                aria-label={`Role for paragraph ${region.paragraphIndex + 1}`}
                value={region.role}
                onChange={(event) => setRegions((current) => current.map((candidate) => candidate.paragraphIndex === region.paragraphIndex
                  ? { ...candidate, role: event.target.value as TemplateRegion["role"], confidence: 1 }
                  : candidate))}
              >
                <option value="editable">Replace</option>
                <option value="preserve">Preserve</option>
                <option value="heading">Heading</option>
              </select>
              <span>{region.text}</span>
            </div>
          ))}
        </div>
        {error && <div className="error-banner"><CircleAlert size={16} />{error}</div>}
        <div className="modal-actions">
          <button className="secondary" onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={() => void confirm()} disabled={busy || counts.editable === 0}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />} Confirm regions
          </button>
        </div>
      </section>
    </div>
  );
}

function ReviewFlagList({ flags, blockingIds, onCitation, onTarget }: {
  flags: ReviewFlag[];
  blockingIds?: Set<string>;
  onCitation: (citation: Citation) => void;
  onTarget?: (paragraphIndex: number) => void;
}) {
  if (!flags.length) return <div className="review-clear"><Check size={16} /><span>No material source-review flags were returned. This is not a completeness determination.</span></div>;
  return <div className="review-flag-list">{flags.map((flag) => {
    const blocksExport = blockingIds?.has(flag.id) ?? false;
    return <article className={`review-flag ${blocksExport ? "blocking" : "advisory"}`} key={flag.id}>
      <div className="review-flag-heading"><CircleAlert size={16} /><div><small>{blocksExport ? "Linked to an export blocker" : "Needs source review"}</small><strong>{flag.summary}</strong></div></div>
      <p>{flag.explanation}</p>
      {flag.citations.length > 0 && <div className="review-flag-citations">{flag.citations.map((citation, index) => <button key={`${citation.sourceId}-${citation.page}-${index}`} onClick={() => onCitation(citation)}>
        <span>{citation.sourceName} · p. {citation.page}</span><q>{citation.quote}</q>
      </button>)}</div>}
      {!!flag.affectedTemplateParagraphIndexes.length && onTarget && <div className="review-targets">{flag.affectedTemplateParagraphIndexes.map((paragraphIndex) => <button key={paragraphIndex} onClick={() => onTarget(paragraphIndex)}>Open affected draft region {paragraphIndex + 1}</button>)}</div>}
    </article>;
  })}</div>;
}

function ConfirmBlockModal({ block, busy, onCancel, onConfirm }: {
  block: DraftBlock;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return <div className="modal-backdrop" role="presentation">
    <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-block-title">
      <div className="modal-head"><div><p className="eyebrow">Attorney confirmation</p><h2 id="confirm-block-title">Confirm this reviewed text</h2></div><button className="icon-button" onClick={onCancel} aria-label="Close confirmation"><X size={18} /></button></div>
      <p className="modal-copy">Editing alone does not resolve unsupported content. Confirm that you reviewed the final text and record why it is appropriate to use.</p>
      <blockquote>{block.text}</blockquote>
      <label className="confirmation-note"><span>Review note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Example: Confirmed against the signed treatment summary and corrected the service date." rows={3} /></label>
      <div className="modal-actions"><button className="secondary" onClick={onCancel}>Cancel</button><button className="primary" disabled={busy || note.trim().length < 3} onClick={() => onConfirm(note.trim())}>{busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Confirm reviewed text</button></div>
    </section>
  </div>;
}

function Setup({ onReady }: { onReady: (matterId: string, autoReview: boolean) => Promise<void> }) {
  const [templates, setTemplates] = useState<TemplateResponse[]>([]);
  const [selected, setSelected] = useState<TemplateResponse | null>(null);
  const [review, setReview] = useState<TemplateResponse | null>(null);
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sampleAvailable, setSampleAvailable] = useState(false);

  useEffect(() => {
    void api<TemplateResponse[]>("/api/templates").then(setTemplates).catch((caught) => setError(caught instanceof Error ? caught.message : "Templates could not be loaded"));
    void api<{ available: boolean }>("/api/demo/status").then((status) => setSampleAvailable(status.available)).catch(() => undefined);
  }, []);

  const filtered = templates.filter((template) => templateDisplayName(template).toLowerCase().includes(query.toLowerCase()));
  const chooseTemplate = (template: TemplateResponse) => {
    if (template.status === "analyzed") setReview(template);
    else setSelected(template);
  };

  const uploadTemplate = async (file: File) => {
    setBusy(true); setBusyLabel("Analyzing template…"); setError(null);
    try {
      const template = await upload<TemplateResponse>("/api/templates", [file]);
      setTemplates((current) => [template, ...current]);
      setReview(template);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Template analysis failed"); }
    finally { setBusy(false); }
  };

  const addFiles = (incoming: File[]) => setFiles((current) => {
    const keyed = new Map(current.map((file) => [`${file.name}:${file.size}`, file]));
    incoming.forEach((file) => keyed.set(`${file.name}:${file.size}`, file));
    return [...keyed.values()];
  });

  const generate = async () => {
    if (!selected || !files.length) return;
    setBusy(true); setError(null);
    try {
      setBusyLabel("Creating matter…");
      const matter = await api<{ id: string }>("/api/matters", {
        method: "POST", body: JSON.stringify({ name: `${templateLabel(selected.name)} matter`, templateId: selected.id }),
      });
      setBusyLabel(`Extracting ${files.length} source ${files.length === 1 ? "document" : "documents"}…`);
      await upload(`/api/matters/${matter.id}/sources`, files);
      await onReady(matter.id, true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Matter setup failed"); }
    finally { setBusy(false); }
  };

  const loadSample = async () => {
    setBusy(true); setBusyLabel("Preparing supplied sample…"); setError(null);
    try {
      const result = await api<{ matterId: string }>("/api/demo/bootstrap", { method: "POST", body: "{}" });
      await onReady(result.matterId, true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Sample packet could not be prepared"); }
    finally { setBusy(false); }
  };

  return (
    <div className="setup-page">
      <header className="app-header setup-header"><div className="wordmark">Steno <span>Demand Letter Studio</span></div></header>
      <main className="setup-main">
        <section className="setup-intro">
          <p className="eyebrow">New draft</p>
          <h1>Create an evidence-grounded demand letter</h1>
          <p>Choose a reviewed firm template, attach the case materials, and generate a cited draft for attorney review.</p>
        </section>

        <section className="setup-section" aria-labelledby="template-heading">
          <div className="section-heading-row">
            <h2 id="template-heading">1 · Firm template</h2><span>{templates.length} {templates.length === 1 ? "template" : "templates"}</span>
            <label className="template-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search templates…" /></label>
          </div>
          <div className="template-grid">
            <label className="template-card upload-template-card">
              <input type="file" accept=".docx" onChange={(event) => event.target.files?.[0] && void uploadTemplate(event.target.files[0])} />
              <div className="template-tag"><span>Upload your own</span><Plus size={17} /></div>
              <strong>Use a firm template or completed letter</strong>
              <small>Upload a reviewed DOCX. You will confirm which regions AI may replace.</small>
            </label>
            {filtered.map((template) => {
              const displayName = templateDisplayName(template);
              const createdLabel = template.isTest ? templateCreatedLabel(template.createdAt) : null;
              return (
                <button className={`template-card ${selected?.id === template.id ? "selected" : ""}`} key={template.id} onClick={() => chooseTemplate(template)}>
                  <div className="template-tag"><span>{template.isTest ? "Test template" : template.status === "confirmed" ? "Firm template" : "Review needed"}</span><i /></div>
                  <strong title={displayName}>{displayName}</strong>
                  <small>{template.analysis.paragraphCount} paragraphs · {template.analysis.regions.filter((region) => region.role === "editable").length} replaceable regions</small>
                  {createdLabel && <small className="template-created">Test run · {createdLabel}</small>}
                </button>
              );
            })}
            {query && filtered.length === 0 && <p className="template-empty">No real templates match “{query}”. Clear the search or upload a DOCX.</p>}
          </div>
          {sampleAvailable && <button className="sample-shortcut" onClick={() => void loadSample()} disabled={busy}>
            <Sparkles size={16} /><span><strong>Use the supplied Steno sample packet</strong><small>Loads the provided completed letter and all five real case files.</small></span><ChevronRight size={17} />
          </button>}
        </section>

        <section className="setup-section" aria-labelledby="materials-heading">
          <div className="section-heading-row"><h2 id="materials-heading">2 · Case materials</h2><span>{files.length} selected</span></div>
          <div className="materials-layout">
            <div className="material-list">
              {files.length ? files.map((file) => (
                <div className="material-row" key={`${file.name}:${file.size}`}>
                  <span className="file-badge">{file.type.startsWith("image/") ? "IMG" : "PDF"}</span>
                  <div><strong>{file.name}</strong><small>{formatBytes(file.size)} · Ready to upload</small></div>
                  <button onClick={() => setFiles((current) => current.filter((candidate) => candidate !== file))} aria-label={`Remove ${file.name}`}><X size={15} /></button>
                </div>
              )) : <div className="material-empty"><FileText size={21} /><span>Selected source documents will appear here.</span></div>}
            </div>
            <label className="source-drop-zone">
              <input type="file" accept=".pdf,image/*" multiple onChange={(event) => event.target.files && addFiles([...event.target.files])} />
              <span><Plus size={20} /></span><strong>Add documents</strong><small>PDFs and images · up to 10 files</small>
            </label>
          </div>
        </section>

        <div className="generate-row">
          <button className="primary generate-button" onClick={() => void generate()} disabled={!selected || !files.length || busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} Review evidence
          </button>
          <p>Steno first checks source coverage, then you decide whether to add evidence or generate an attorney-review draft. Nothing is sent to a carrier.</p>
        </div>
        {error && <div className="error-banner setup-error"><CircleAlert size={17} />{error}</div>}
        {busy && <div className="setup-busy"><LoaderCircle className="spin" size={18} />{busyLabel}</div>}
      </main>
      {review && <RegionReviewModal
        template={review}
        onCancel={() => setReview(null)}
        onConfirmed={(confirmed) => {
          setTemplates((current) => current.map((template) => template.id === confirmed.id ? confirmed : template));
          setSelected(confirmed); setReview(null);
        }}
      />}
    </div>
  );
}

function RefinePanel({
  tab, setTab, messages, activity, annotations, instruction, proposal, thinking, activeBlock,
  onInstruction, onRemoveAnnotation, onSend, onResolve,
}: {
  tab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
  messages: ChatMessage[];
  activity: ActivityResponse[];
  annotations: RefinementAnnotation[];
  instruction: string;
  proposal: ProposalResponse | null;
  thinking: boolean;
  activeBlock: DraftBlock | null;
  onInstruction: (value: string) => void;
  onRemoveAnnotation: (index: number) => void;
  onSend: () => void;
  onResolve: (resolution: "accept" | "reject") => void;
}) {
  return (
    <aside className="right-panel">
      <div className="panel-tabs">
        <button className={tab === "refine" ? "active" : ""} onClick={() => setTab("refine")}>Refine with AI</button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity</button>
      </div>
      {tab === "refine" ? <>
        <div className="chat-scroll">
          {!messages.length && <div className="chat-intro"><Sparkles size={22} /><strong>Refine without losing control</strong><p>Select passages in the letter, add them to chat, and review every proposed change before it is applied.</p></div>}
          {messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
            {!!message.annotationCount && <small>❝ {message.annotationCount} selected {message.annotationCount === 1 ? "passage" : "passages"}</small>}
            <p>{message.text}</p>
          </div>)}
          {thinking && <div className="thinking"><LoaderCircle className="spin" size={14} /> Drafting a revision…</div>}
          {proposal && <div className="proposal-card">
            <p className="eyebrow">Proposed edit · {proposal.proposal.edits.length} {proposal.proposal.edits.length === 1 ? "passage" : "passages"}</p>
            <strong>{proposal.proposal.summary}</strong>
            <div className="proposal-actions"><button className="accept" onClick={() => onResolve("accept")}><Check size={14} /> Accept</button><button className="reject" onClick={() => onResolve("reject")}><X size={14} /> Reject</button></div>
          </div>}
          {!proposal && !thinking && <div className="suggestions">
            {["Make this more concise", "Strengthen the liability language", "Clarify the treatment timeline"].map((suggestion) => <button key={suggestion} onClick={() => onInstruction(suggestion)}>{suggestion}</button>)}
          </div>}
        </div>
        <div className="composer">
          {annotations.length > 0 && <div className="annotation-stack">{annotations.map((annotation, index) => <div className="annotation-chip" key={`${annotation.blockId}-${annotation.start}`}>
            <span><strong>Annotation {index + 1}</strong>“{annotation.quote.slice(0, 92)}{annotation.quote.length > 92 ? "…" : ""}”</span>
            <button onClick={() => onRemoveAnnotation(index)} aria-label={`Remove annotation ${index + 1}`}><X size={13} /></button>
          </div>)}</div>}
          <div className="composer-row">
            <textarea
              value={instruction}
              onChange={(event) => onInstruction(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }}
              placeholder={annotations.length ? `Instruct AI about ${annotations.length === 1 ? "the selected passage" : `the ${annotations.length} selected passages`}…` : activeBlock ? "Instruct AI about the active paragraph…" : "Select text in the letter to begin…"}
              rows={2}
            />
            <button onClick={onSend} disabled={!instruction.trim() || (!annotations.length && !activeBlock) || thinking || !!proposal} aria-label="Send refinement"><Send size={16} /></button>
          </div>
          <small>AI changes remain proposals until you accept them.</small>
        </div>
      </> : <div className="activity-list">
        {activity.length ? activity.map((event) => <div className="activity-row" key={event.id}>
          <span>{event.actorType === "agent" ? "✦" : "FR"}</span>
          <div><strong>{event.summary}</strong><p>{event.actorName}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div>
        </div>) : <p className="panel-empty">No activity yet.</p>}
      </div>}
    </aside>
  );
}

export function App() {
  const [matter, setMatter] = useState<MatterResponse | null>(null);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [content, setContent] = useState<GeneratedDraft | null>(null);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [autoReview, setAutoReview] = useState(false);
  const [revealedSections, setRevealedSections] = useState(0);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<SelectedSource | null>(null);
  const [activeCitation, setActiveCitation] = useState<{ sourceId: string; page: number; number: number } | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("refine");
  const [activity, setActivity] = useState<ActivityResponse[]>([]);
  const [annotations, setAnnotations] = useState<RefinementAnnotation[]>([]);
  const [selection, setSelection] = useState<SelectionPopover | null>(null);
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposal, setProposal] = useState<ProposalResponse | null>(null);
  const [thinking, setThinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [addingEvidence, setAddingEvidence] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState<DraftBlock | null>(null);
  const [confirmingBlockBusy, setConfirmingBlockBusy] = useState(false);

  const loadActivity = useCallback(async (matterId: string) => setActivity(await api(`/api/matters/${matterId}/activity`)), []);
  const refreshMatter = useCallback(async (matterId: string) => {
    const loaded = await api<MatterResponse>(`/api/matters/${matterId}`);
    setMatter(loaded);
    return loaded;
  }, []);
  const loadDraft = useCallback(async (draftId: string) => {
    const loaded = await api<DraftResponse>(`/api/drafts/${draftId}`);
    setDraft(loaded); setContent(loaded.content); setRevealedSections(0);
    setActiveBlockId(loaded.content.sections.flatMap((section) => section.blocks)[0]?.id ?? null);
    setFieldValues(Object.fromEntries(Object.entries(loaded.content.fields).map(([key, field]) => [key, field.value])));
  }, []);

  const reviewEvidenceForMatter = useCallback(async (target: MatterResponse) => {
    setNotice(null);
    try {
      const queued = await api<JobResponse>(`/api/matters/${target.id}/evidence-reviews`, { method: "POST", body: "{}" });
      setJob({ ...queued, jobType: "evidence_review", progress: 0, step: "Queued" });
      const stream = new EventSource(`/api/jobs/${queued.jobId}/events`);
      const update = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as Partial<JobResponse>;
        const status = event.type === "completed" ? "completed" : event.type === "failed" ? "failed" : event.type === "progress" ? "processing" : "queued";
        setJob((current) => ({ ...(current ?? queued), ...payload, jobType: "evidence_review", status }) as JobResponse);
      };
      stream.addEventListener("queued", update); stream.addEventListener("progress", update);
      stream.addEventListener("completed", (event) => {
        update(event as MessageEvent<string>); stream.close();
        void refreshMatter(target.id).then(() => loadActivity(target.id));
      });
      stream.addEventListener("failed", (event) => { update(event as MessageEvent<string>); stream.close(); });
      stream.onerror = () => stream.close();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Evidence review failed"); }
  }, [loadActivity, refreshMatter]);

  const generateForMatter = useCallback(async (target: MatterResponse, existingDraft: DraftResponse | null = null) => {
    setNotice(null);
    if (!existingDraft) { setDraft(null); setContent(null); }
    try {
      const queued = await api<JobResponse>(`/api/matters/${target.id}/generations`, {
        method: "POST",
        body: JSON.stringify(existingDraft ? { draftId: existingDraft.id, baseVersion: existingDraft.version } : {}),
      });
      setJob({ ...queued, jobType: "generation", progress: 0, step: "Queued" });
      const stream = new EventSource(`/api/jobs/${queued.jobId}/events`);
      const update = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as { progress?: number; step?: string; draftId?: string; error?: string };
        const status = event.type === "completed" ? "completed" : event.type === "failed" ? "failed" : event.type === "progress" ? "processing" : "queued";
        setJob((current) => ({ ...(current ?? queued), jobType: "generation", ...payload, status }));
      };
      stream.addEventListener("queued", update); stream.addEventListener("progress", update);
      stream.addEventListener("completed", (event) => {
        update(event as MessageEvent<string>);
        const payload = JSON.parse((event as MessageEvent<string>).data) as { draftId: string };
        stream.close();
        void loadDraft(payload.draftId).then(() => Promise.all([loadActivity(target.id), refreshMatter(target.id)]));
      });
      stream.addEventListener("failed", (event) => { update(event as MessageEvent<string>); stream.close(); });
      stream.onerror = () => stream.close();
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Generation failed"); }
  }, [loadActivity, loadDraft, refreshMatter]);

  const openMatter = useCallback(async (matterId: string, shouldReview: boolean) => {
    const loaded = await refreshMatter(matterId);
    setAutoReview(shouldReview);
    if (!shouldReview && loaded.activeDraft) await loadDraft(loaded.activeDraft.id);
    await loadActivity(matterId);
  }, [loadActivity, loadDraft, refreshMatter]);

  useEffect(() => {
    if (matter && autoReview) { setAutoReview(false); void reviewEvidenceForMatter(matter); }
  }, [autoReview, matter, reviewEvidenceForMatter]);

  useEffect(() => {
    if (!draft || !content) return;
    const timer = window.setInterval(() => setRevealedSections((current) => {
      if (current >= content.sections.length) { window.clearInterval(timer); return current; }
      return current + 1;
    }), 140);
    return () => window.clearInterval(timer);
  }, [draft?.id, draft?.version, content?.sections.length]);

  useEffect(() => {
    const clear = () => setSelection(null);
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, []);

  const citationEntries = useMemo(() => {
    if (!content) return [];
    let number = 0;
    return content.sections.flatMap((section) => section.blocks.flatMap((block) => block.citations.map((citation, index) => ({
      ...citation, blockId: block.id, citationIndex: index, number: ++number,
    }))));
  }, [content]);

  const citationCounts = useMemo(() => citationEntries.reduce<Record<string, number>>((counts, citation) => ({
    ...counts, [citation.sourceId]: (counts[citation.sourceId] ?? 0) + 1,
  }), {}), [citationEntries]);

  const activeBlock = useMemo(() => content?.sections.flatMap((section) => section.blocks).find((block) => block.id === activeBlockId) ?? null, [activeBlockId, content]);

  const showCitation = async (blockId: string, index: number) => {
    const entry = citationEntries.find((citation) => citation.blockId === blockId && citation.citationIndex === index);
    if (!entry?.page) return;
    setActiveCitation({ sourceId: entry.sourceId, page: entry.page, number: entry.number });
    setSourcesOpen(true);
    try {
      setSelectedSource(await api<SelectedSource>(`/api/sources/${entry.sourceId}/pages/${entry.page}`));
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Source page could not be loaded"); }
  };

  const showReviewCitation = async (citation: Citation) => {
    if (!citation.page) return;
    setActiveCitation({ sourceId: citation.sourceId, page: citation.page, number: 0 });
    setSourcesOpen(true);
    try {
      setSelectedSource(await api<SelectedSource>(`/api/sources/${citation.sourceId}/pages/${citation.page}`));
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Source page could not be loaded"); }
  };

  const focusTemplateParagraph = (paragraphIndex: number) => {
    const block = content?.sections.flatMap((section) => section.blocks)
      .find((candidate) => candidate.templateParagraphIndex === paragraphIndex);
    if (!block) return;
    setActiveBlockId(block.id);
    window.setTimeout(() => document.querySelector(`[aria-label="Editable paragraph ${CSS.escape(block.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  };

  const addEvidence = async (files: File[]) => {
    if (!matter || !files.length) return;
    setAddingEvidence(true); setNotice(null);
    try {
      await upload(`/api/matters/${matter.id}/sources`, files);
      const refreshed = await refreshMatter(matter.id);
      if (draft) await loadDraft(draft.id);
      setNotice(`Added ${files.length} evidence ${files.length === 1 ? "file" : "files"}. Reviewing the updated source set…`);
      await reviewEvidenceForMatter(refreshed);
      await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Evidence could not be added"); }
    finally { setAddingEvidence(false); }
  };

  const updateBlock = (blockId: string, text: string) => {
    setContent((current) => current ? ({
      ...current,
      sections: current.sections.map((section) => ({
        ...section, blocks: section.blocks.map((block) => block.id === blockId ? { ...block, text } : block),
      })),
    }) : current);
    setDraft((current) => current ? ({
      ...current,
      readiness: {
        ...current.readiness,
        ready: false,
        blockIds: current.readiness.blockIds.includes(blockId) ? current.readiness.blockIds : [...current.readiness.blockIds, blockId],
      },
    }) : current);
  };

  const saveBlock = async (blockId: string, text: string) => {
    if (!draft || !content) return;
    const savedText = draft.content.sections.flatMap((section) => section.blocks).find((block) => block.id === blockId)?.text;
    if (savedText === text) return;
    const nextContent: GeneratedDraft = {
      ...content,
      sections: content.sections.map((section) => ({
        ...section, blocks: section.blocks.map((block) => block.id === blockId ? { ...block, text } : block),
      })),
    };
    try {
      const saved = await api<DraftResponse>(`/api/drafts/${draft.id}`, {
        method: "PUT", body: JSON.stringify({ version: draft.version, content: nextContent }),
      });
      setDraft(saved); setContent(saved.content); setNotice(`Draft v${saved.version} saved`);
      if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Direct edit could not be saved"); }
  };

  const addAnnotation = () => {
    if (!selection) return;
    setAnnotations((current) => [...current.filter((item) => !(item.blockId === selection.blockId && item.start === selection.start)), {
      blockId: selection.blockId, quote: selection.quote, start: selection.start, end: selection.end,
    }].slice(-5));
    setSelection(null); setTab("refine");
  };

  const sendRefinement = async () => {
    if (!draft || !content || !instruction.trim() || proposal) return;
    const context = annotations.length ? annotations : activeBlock ? [{ blockId: activeBlock.id, quote: activeBlock.text, start: 0, end: activeBlock.text.length }] : [];
    if (!context.length) return;
    const requestText = instruction.trim();
    setMessages((current) => [...current, { role: "user", text: requestText, annotationCount: context.length }]);
    setThinking(true); setInstruction(""); setNotice(null);
    try {
      const result = await streamEvent<ProposalResponse>(`/api/drafts/${draft.id}/refinements`, "proposal", {
        method: "POST", body: JSON.stringify({ instruction: requestText, annotations: context }),
      });
      setRevealedSections(content.sections.length);
      setProposal(result); setAnnotations([]);
      setMessages((current) => [...current, { role: "assistant", text: `I prepared ${result.proposal.edits.length === 1 ? "a tracked revision" : `${result.proposal.edits.length} tracked revisions`}. Review the changes in the letter, then accept or reject them together.` }]);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Refinement failed"); }
    finally { setThinking(false); }
  };

  const resolveProposal = async (resolution: "accept" | "reject") => {
    if (!proposal) return;
    try {
      const result = await api<{ draft?: DraftResponse }>(`/api/proposals/${proposal.id}/${resolution}`, { method: "POST", body: "{}" });
      if (result.draft) {
        setDraft(result.draft); setContent(result.draft.content);
        setFieldValues(Object.fromEntries(Object.entries(result.draft.content.fields).map(([key, field]) => [key, field.value])));
      }
      setMessages((current) => [...current, { role: "assistant", text: resolution === "accept" ? `Applied. The draft is now v${result.draft?.version ?? draft?.version}.` : "Discarded. The draft was not changed." }]);
      setProposal(null); if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Proposal could not be resolved"); }
  };

  const confirmField = async (key: string) => {
    if (!draft) return;
    try {
      const saved = await api<DraftResponse>(`/api/drafts/${draft.id}/fields/confirm`, {
        method: "POST", body: JSON.stringify({ version: draft.version, key, value: fieldValues[key] }),
      });
      setDraft(saved); setContent(saved.content);
      setFieldValues(Object.fromEntries(Object.entries(saved.content.fields).map(([fieldKey, field]) => [fieldKey, field.value])));
      setNotice(`Field confirmed in draft v${saved.version}`); if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Field could not be confirmed"); }
  };

  const confirmDraftBlock = async (note: string) => {
    if (!draft || !confirmingBlock) return;
    setConfirmingBlockBusy(true);
    try {
      const saved = await api<DraftResponse>(`/api/drafts/${draft.id}/blocks/${encodeURIComponent(confirmingBlock.id)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ version: draft.version, text: confirmingBlock.text, note }),
      });
      setDraft(saved); setContent(saved.content); setConfirmingBlock(null);
      setNotice(`Paragraph confirmed in draft v${saved.version}`);
      if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Paragraph could not be confirmed"); }
    finally { setConfirmingBlockBusy(false); }
  };

  if (!matter) return <Setup onReady={openMatter} />;

  const proposedByBlock = new Map<string, RefinementEdit[]>();
  proposal?.proposal.edits.forEach((edit) => proposedByBlock.set(edit.blockId, [...(proposedByBlock.get(edit.blockId) ?? []), edit]));
  const visibleSections = content?.sections.slice(0, revealedSections) ?? [];
  const fieldEntries = Object.entries(content?.fields ?? {});
  const unconfirmedFields = fieldEntries.filter(([, field]) => !field.userConfirmed && (!field.verified || (field.confidence ?? 1) < 0.8));
  const readiness = draft?.readiness ?? null;
  const exportBlocked = !readiness?.ready;
  const blockingReviewFlagIds = new Set(readiness?.blockingReviewFlagIds ?? []);
  const jobActive = job?.status === "queued" || job?.status === "processing";
  const generationActive = jobActive && job?.jobType === "generation";
  const reviewActive = jobActive && job?.jobType === "evidence_review";

  return (
    <div className="workspace-app">
      <header className="app-header workspace-header">
        <div className="wordmark">Steno <span>Demand Letter Studio</span></div>
        <div className="matter-breadcrumb"><span>/</span><strong>{matter.name}</strong>{draft && <i>Draft v{draft.version}</i>}</div>
        <div className="workspace-actions"><span className="single-user"><b>FR</b> Single-user v1</span>{draft && (exportBlocked
          ? <button className="export-button" disabled title="Resolve all server-reported readiness items before Word export" onClick={() => setNotice(`Word export is blocked by ${readiness?.blockIds.length ?? 0} draft regions, ${readiness?.fieldKeys.length ?? 0} template fields${readiness?.staleEvidence ? ", and a newer source set" : ""}.`)}><Download size={15} /> Export to Word</button>
          : <a className="export-button" href={`/api/drafts/${draft.id}/export.docx`}><Download size={15} /> Export to Word</a>)}</div>
      </header>
      <div className="workspace-grid">
        <aside className="source-strip">
          <button className="back-to-setup" onClick={() => { setMatter(null); setDraft(null); setContent(null); setJob(null); }} title="Start a new draft"><ArrowLeft size={17} /></button>
          <button className={sourcesOpen ? "active" : ""} onClick={() => setSourcesOpen((current) => !current)}><FileText size={15} /><span>Sources · {matter.sources.length}</span></button>
        </aside>

        <main className="letter-workspace">
          {!content && job?.jobType === "generation" && <section className="generation-state">
            <div className="generation-glyph"><LoaderCircle className={job?.status !== "failed" ? "spin" : ""} size={28} /></div>
            <p className="eyebrow">{job?.status === "failed" ? "Generation stopped" : "Drafting in progress"}</p>
            <h1>{job?.step ?? "Preparing the drafting job"}</h1>
            <p>{job?.error ?? "Extracting facts, validating citations, and preserving the reviewed template structure."}</p>
            <div className="progress-track"><span style={{ width: `${job?.progress ?? 4}%` }} /></div><strong>{job?.progress ?? 4}%</strong>
            {job?.status === "failed" && <button className="secondary" onClick={() => void generateForMatter(matter)}>Try again</button>}
          </section>}

          {!content && job?.jobType !== "generation" && <section className="evidence-review-stage">
            <div className="review-stage-heading"><span className="generation-glyph">{reviewActive ? <LoaderCircle className="spin" size={27} /> : <Sparkles size={27} />}</span><div><p className="eyebrow">Evidence review</p><h1>{reviewActive ? job?.step ?? "Reviewing source coverage" : "Review the source packet before drafting"}</h1></div></div>
            {reviewActive && <><p>AI is checking the reviewed template against the uploaded source pages. The result is advisory and non-exhaustive.</p><div className="progress-track"><span style={{ width: `${job?.progress ?? 4}%` }} /></div><strong>{job?.progress ?? 4}%</strong></>}
            {!reviewActive && job?.status === "failed" && <div className="error-banner"><CircleAlert size={16} />{job.error ?? "Evidence review failed"}</div>}
            {!reviewActive && matter.evidenceReview && !matter.evidenceReviewStale && <>
              <div className="review-disclaimer"><CircleAlert size={16} /><span>This AI-assisted review highlights potential source issues. It does not determine completeness, authenticity, admissibility, or legal validity.</span></div>
              <ReviewFlagList flags={matter.evidenceReview.reviewFlags} onCitation={(citation) => void showReviewCitation(citation)} />
            </>}
            {!reviewActive && <div className="preflight-actions">
              <label className="secondary file-action"><input type="file" accept=".pdf,image/*" multiple onChange={(event) => { if (event.target.files) void addEvidence([...event.target.files]); event.currentTarget.value = ""; }} /><Upload size={15} /> Add evidence</label>
              {matter.evidenceReview && !matter.evidenceReviewStale
                ? <button className="primary" onClick={() => void generateForMatter(matter)}><Sparkles size={15} /> Generate attorney-review draft</button>
                : <button className="primary" onClick={() => void reviewEvidenceForMatter(matter)}><RotateCcw size={15} /> {job?.status === "failed" ? "Try review again" : "Review evidence"}</button>}
            </div>}
          </section>}

          {content && <div className="letter-scroll">
            {generationActive && <div className="job-banner"><LoaderCircle className="spin" size={16} /><span>{job?.step ?? "Regenerating draft"} · {job?.progress ?? 0}%</span></div>}
            {reviewActive && <div className="job-banner"><LoaderCircle className="spin" size={16} /><span>{job?.step ?? "Reviewing updated evidence"} · {job?.progress ?? 0}%</span></div>}
            {readiness && !readiness.ready && <div className="confidence-banner"><CircleAlert size={17} /><span>Word export is locked by the server: {readiness.blockIds.length} draft {readiness.blockIds.length === 1 ? "region" : "regions"}, {readiness.fieldKeys.length} template {readiness.fieldKeys.length === 1 ? "field" : "fields"}{readiness.imageIssue ? ", an unresolved image mapping" : ""}{readiness.staleEvidence ? ", and evidence added after this version" : ""}.</span></div>}
            {notice && <div className="workspace-notice">{notice}<button onClick={() => setNotice(null)}><X size={13} /></button></div>}
            <article className="letter-paper">
              <div className="letterhead"><strong>ATTORNEY REVIEW DRAFT</strong><span>Generated from a reviewed firm template · Not ready to send</span></div>
              <h1>{content.title}</h1>
              {fieldEntries.length > 0 && <section className="merge-field-panel">
                <p className="eyebrow">Extracted template fields</p>
                {fieldEntries.map(([key, field]) => {
                  const needsCheck = !field.userConfirmed && (!field.verified || (field.confidence ?? 1) < 0.8);
                  return <div className={`merge-field ${needsCheck ? "low-confidence" : ""}`} key={key}>
                    <label><span>{key}</span><input value={fieldValues[key] ?? field.value} onChange={(event) => setFieldValues((current) => ({ ...current, [key]: event.target.value }))} /></label>
                    <small>{field.sourceLabel ?? "No supporting source was found"}</small>
                    {needsCheck ? <button onClick={() => void confirmField(key)}><Check size={13} /> Confirm</button> : <i>Verified</i>}
                  </div>;
                })}
              </section>}
              {content.warnings.map((warning) => <div className="document-warning" key={warning}><CircleAlert size={15} />{warning}</div>)}
              {content.reviewFlags.length > 0 && <section className="draft-review-flags"><div className="review-flags-title"><p className="eyebrow">Source review</p><span>AI-assisted and non-exhaustive</span></div><ReviewFlagList flags={content.reviewFlags} blockingIds={blockingReviewFlagIds} onCitation={(citation) => void showReviewCitation(citation)} onTarget={focusTemplateParagraph} /></section>}
              {visibleSections.map((section) => <section className="draft-section fade-up" key={section.id}>
                {section.heading && <h2>{section.heading}</h2>}
                {section.blocks.map((block) => {
                  const numbers = block.citations.map((_citation, index) => citationEntries.find((entry) => entry.blockId === block.id && entry.citationIndex === index)?.number ?? 0);
                  return <BlockEditor
                    key={block.id}
                    block={block}
                    active={activeBlockId === block.id}
                    citationNumbers={numbers}
                    edits={proposedByBlock.get(block.id) ?? []}
                    disabled={generationActive}
                    onFocus={() => setActiveBlockId(block.id)}
                    onChange={(text) => updateBlock(block.id, text)}
                    onBlur={(text) => void saveBlock(block.id, text)}
                    onCitation={(index) => void showCitation(block.id, index)}
                    onSelect={setSelection}
                    onConfirm={() => setConfirmingBlock(block)}
                  />;
                })}
              </section>)}
              {revealedSections < content.sections.length && <div className="section-drafting"><LoaderCircle className="spin" size={14} /> Revealing validated section…</div>}
              {revealedSections >= content.sections.length && citationEntries.length > 0 && <section className="cited-sources">
                <h2>Sources cited in this draft</h2>
                <div>{citationEntries.map((citation) => <button key={`${citation.blockId}-${citation.citationIndex}`} onClick={() => void showCitation(citation.blockId, citation.citationIndex)}><sup>{citation.number}</sup><span>{citation.sourceName} · p. {citation.page ?? "—"}</span></button>)}</div>
              </section>}
            </article>
          </div>}
        </main>

        <RefinePanel
          tab={tab} setTab={setTab} messages={messages} activity={activity} annotations={annotations}
          instruction={instruction} proposal={proposal} thinking={thinking} activeBlock={activeBlock}
          onInstruction={setInstruction}
          onRemoveAnnotation={(index) => setAnnotations((current) => current.filter((_annotation, candidate) => candidate !== index))}
          onSend={() => void sendRefinement()}
          onResolve={(resolution) => void resolveProposal(resolution)}
        />

        {sourcesOpen && <>
          <button className="source-scrim" onClick={() => { setSourcesOpen(false); setActiveCitation(null); }} aria-label="Close sources" />
          <aside className="source-drawer">
            <div className="drawer-head"><div><p className="eyebrow">Source materials</p><strong>{matter.sources.length} real documents</strong></div><button className="icon-button" onClick={() => setSourcesOpen(false)}><X size={17} /></button></div>
            <div className="source-template-card"><small>Reviewed template</small><strong>Firm DOCX template</strong></div>
            <div className="drawer-evidence-actions">
              <label className={`secondary file-action ${addingEvidence || generationActive ? "disabled" : ""}`}><input type="file" accept=".pdf,image/*" multiple disabled={addingEvidence || generationActive} onChange={(event) => { if (event.target.files) void addEvidence([...event.target.files]); event.currentTarget.value = ""; }} />{addingEvidence ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />} Add evidence</label>
              {draft && matter.evidenceReview && !matter.evidenceReviewStale && <button className="primary regenerate-button" disabled={generationActive || reviewActive || addingEvidence} onClick={() => void generateForMatter(matter, draft)}>{generationActive ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />} Regenerate v{draft.version + 1}</button>}
            </div>
            {draft?.readiness.staleEvidence && <div className="drawer-stale"><CircleAlert size={14} />This draft predates the current source set. Complete the review, then regenerate before export.</div>}
            <div className="drawer-sources">{matter.sources.map((source) => {
              const active = activeCitation?.sourceId === source.id;
              return <button className={`drawer-source ${active ? "active" : ""}`} key={source.id} onClick={() => {
                const first = citationEntries.find((citation) => citation.sourceId === source.id);
                if (first?.page) void showCitation(first.blockId, first.citationIndex);
              }}>
                <i className={citationCounts[source.id] ? "cited" : ""} />
                <span><strong>{source.name}</strong><small>{source.pageCount} {source.pageCount === 1 ? "page" : "pages"} · {source.status}</small></span>
                {!!citationCounts[source.id] && <b>Cited ×{citationCounts[source.id]}</b>}
              </button>;
            })}</div>
            {selectedSource && <div className="source-detail">
              <div><span>{activeCitation?.number ? `Reference ${activeCitation.number}` : "Source review evidence"}</span><strong>{selectedSource.sourceName}</strong><small>Page {selectedSource.page}</small></div>
              <p>{selectedSource.text || "This page contains visual evidence and requires direct review."}</p>
              <a href={`/api/sources/${selectedSource.sourceId}/file#page=${selectedSource.page}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open original at page {selectedSource.page}</a>
            </div>}
          </aside>
        </>}
      </div>
      {selection && <button className="add-to-chat" style={{ left: selection.x, top: selection.y }} onMouseDown={(event) => event.preventDefault()} onClick={addAnnotation}>Add to chat ↗</button>}
      {confirmingBlock && <ConfirmBlockModal block={confirmingBlock} busy={confirmingBlockBusy} onCancel={() => setConfirmingBlock(null)} onConfirm={(note) => void confirmDraftBlock(note)} />}
    </div>
  );
}
