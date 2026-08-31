import { useCallback, useEffect, useMemo, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Activity, ArrowLeft, Check, ChevronRight, CircleAlert, Clock3, Download, FileImage, FileText,
  History, LoaderCircle, PanelRightClose, PanelRightOpen, Save, Send, ShieldCheck, Sparkles, Upload,
  UserRound, X,
} from "lucide-react";
import type { DraftBlock, GeneratedDraft, TemplateRegion } from "@steno/contracts";
import { api, upload } from "./api";
import type {
  ActivityResponse, DraftResponse, JobResponse, MatterResponse, ProposalResponse, SourceResponse, TemplateResponse,
} from "./types";

type SetupStep = "template" | "regions" | "sources" | "ready";

function blockDoc(text: string) {
  return text ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } : { type: "doc", content: [{ type: "paragraph" }] };
}

function BlockEditor({ block, active, onFocus, onChange }: {
  block: DraftBlock;
  active: boolean;
  onFocus: () => void;
  onChange: (text: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ heading: false, bulletList: false, orderedList: false, blockquote: false, codeBlock: false })],
    content: blockDoc(block.text),
    editorProps: { attributes: { class: "block-editor", "aria-label": "Editable draft paragraph" } },
    onFocus,
    onUpdate: ({ editor: current }) => onChange(current.getText()),
  }, [block.id]);

  useEffect(() => {
    if (editor && editor.getText() !== block.text) editor.commands.setContent(blockDoc(block.text), { emitUpdate: false });
  }, [block.text, editor]);

  return (
    <div className={`draft-block ${active ? "active" : ""} ${block.kind === "warning" ? "unsupported" : ""}`} onClick={onFocus}>
      {block.kind === "warning" && <CircleAlert size={16} className="warning-icon" aria-label="Unsupported" />}
      <EditorContent editor={editor} />
      <div className="citation-row">
        {block.citations.map((citation) => (
          <button className="citation-pill" key={`${citation.sourceId}-${citation.page}`} data-source-id={citation.sourceId} data-page={citation.page ?? ""}>
            {citation.sourceName.replace(/\.pdf$/i, "")} · p. {citation.page ?? "—"}
          </button>
        ))}
        {!block.verified && <span className="needs-review">Attorney review required</span>}
      </div>
    </div>
  );
}

function Setup({ onReady }: { onReady: (matterId: string) => Promise<void> }) {
  const [step, setStep] = useState<SetupStep>("template");
  const [template, setTemplate] = useState<TemplateResponse | null>(null);
  const [regions, setRegions] = useState<TemplateRegion[]>([]);
  const [matterId, setMatterId] = useState<string | null>(null);
  const [matterName, setMatterName] = useState("New demand matter");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await task(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Something went wrong"); }
    finally { setBusy(false); }
  };

  const loadSample = () => run(async () => {
    const result = await api<{ matterId: string }>("/api/demo/bootstrap", { method: "POST", body: "{}" });
    await onReady(result.matterId);
  });

  const importTemplate = (file: File) => run(async () => {
    const result = await upload<TemplateResponse>("/api/templates", [file]);
    setTemplate(result); setRegions(result.analysis.regions); setStep("regions");
  });

  const confirm = () => run(async () => {
    if (!template) return;
    await api(`/api/templates/${template.id}/confirm`, { method: "POST", body: JSON.stringify({ regions }) });
    const matter = await api<{ id: string }>("/api/matters", { method: "POST", body: JSON.stringify({ name: matterName, templateId: template.id }) });
    setMatterId(matter.id); setStep("sources");
  });

  const sourceUpload = (files: File[]) => run(async () => {
    if (!matterId) return;
    await upload(`/api/matters/${matterId}/sources`, files);
    setStep("ready");
  });

  const toggleRole = (index: number) => setRegions((current) => current.map((region) => region.paragraphIndex === index
    ? { ...region, role: region.role === "editable" ? "preserve" : "editable", confidence: 1 }
    : region));

  return (
    <main className="setup-shell">
      <header className="brand"><div className="brand-mark">S</div><span>Steno</span><small>Demand Studio</small></header>
      <div className="setup-layout">
        <aside className="setup-steps">
          <p className="eyebrow">New workspace</p>
          <h1>Turn case records into a reviewable first draft.</h1>
          {["Import template", "Review regions", "Add source packet", "Generate draft"].map((label, index) => {
            const current = ["template", "regions", "sources", "ready"].indexOf(step);
            return <div className={`step-row ${index === current ? "current" : ""} ${index < current ? "done" : ""}`} key={label}>
              <span>{index < current ? <Check size={14} /> : index + 1}</span>{label}
            </div>;
          })}
          <div className="security-note"><ShieldCheck size={18} /><span>Source documents stay in local storage. Every generated fact remains linked to evidence.</span></div>
        </aside>

        <section className="setup-card">
          {step === "template" && <>
            <p className="eyebrow">Template setup</p>
            <h2>Start with your firm’s Word document</h2>
            <p className="muted">We preserve the original DOCX package and ask you to confirm the paragraphs AI may replace.</p>
            <label className="drop-zone">
              <Upload size={28} />
              <strong>Choose a reviewed .docx template</strong>
              <span>Legacy .doc, PDF, macros, and tracked changes are rejected</span>
              <input type="file" accept=".docx" onChange={(event) => event.target.files?.[0] && void importTemplate(event.target.files[0])} />
            </label>
            <div className="or"><span>or</span></div>
            <button className="secondary wide" onClick={() => void loadSample()} disabled={busy}>Use the supplied Steno sample packet</button>
          </>}

          {step === "regions" && template && <>
            <button className="back-link" onClick={() => setStep("template")}><ArrowLeft size={16} /> Back</button>
            <p className="eyebrow">Review detected regions</p>
            <h2>{template.name}</h2>
            <div className="analysis-stats">
              <span><strong>{template.analysis.paragraphCount}</strong> paragraphs</span>
              <span><strong>{regions.filter((region) => region.role === "editable").length}</strong> editable</span>
              <span><strong>{template.analysis.sectionCount}</strong> section</span>
            </div>
            <label className="field-label">Matter name<input value={matterName} onChange={(event) => setMatterName(event.target.value)} /></label>
            <div className="region-list">
              {regions.map((region) => <button key={region.paragraphIndex} className={`region ${region.role}`} onClick={() => toggleRole(region.paragraphIndex)}>
                <span className="role-tag">{region.role}</span><span>{region.text}</span>
              </button>)}
            </div>
            <button className="primary wide" onClick={() => void confirm()} disabled={busy || !matterName.trim()}>Confirm regions & continue</button>
          </>}

          {step === "sources" && <>
            <p className="eyebrow">Source packet</p>
            <h2>Add the records that support this demand</h2>
            <p className="muted">PDF text is extracted by page. Images remain separate visual evidence and are marked for review.</p>
            <label className="drop-zone tall"><FileText size={32} /><strong>Choose PDFs and images</strong><span>You can select multiple files</span>
              <input type="file" accept=".pdf,image/*" multiple onChange={(event) => event.target.files?.length && void sourceUpload([...event.target.files])} />
            </label>
          </>}

          {step === "ready" && <>
            <div className="success-icon"><Check size={30} /></div><p className="eyebrow">Ready to draft</p>
            <h2>Your template and evidence packet are prepared.</h2>
            <p className="muted">Generation runs asynchronously. Unsupported sections will be called out instead of being silently completed from the old case.</p>
            <button className="primary wide" onClick={() => matterId && void onReady(matterId)} disabled={busy}>Open matter <ChevronRight size={18} /></button>
          </>}
          {busy && <div className="busy-overlay"><LoaderCircle className="spin" /><span>Preparing secure workspace…</span></div>}
          {error && <div className="error-banner"><CircleAlert size={18} />{error}</div>}
        </section>
      </div>
    </main>
  );
}

export function App() {
  const [matter, setMatter] = useState<MatterResponse | null>(null);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [workingContent, setWorkingContent] = useState<GeneratedDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [job, setJob] = useState<JobResponse | null>(null);
  const [sourceOpen, setSourceOpen] = useState(true);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<{ sourceId: string; sourceName: string; page: number; text: string } | null>(null);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [proposal, setProposal] = useState<ProposalResponse | null>(null);
  const [activity, setActivity] = useState<ActivityResponse[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadActivity = useCallback(async (matterId: string) => setActivity(await api(`/api/matters/${matterId}/activity`)), []);
  const openMatter = useCallback(async (matterId: string) => {
    const loaded = await api<MatterResponse>(`/api/matters/${matterId}`);
    setMatter(loaded); await loadActivity(matterId);
  }, [loadActivity]);

  const loadDraft = useCallback(async (draftId: string) => {
    const loaded = await api<DraftResponse>(`/api/drafts/${draftId}`);
    setDraft(loaded); setWorkingContent(loaded.content); setDirty(false);
    setSelectedBlockId(loaded.content.sections.flatMap((section) => section.blocks)[0]?.id ?? null);
  }, []);

  const generate = async () => {
    if (!matter) return;
    setBusy(true); setNotice(null); setProposal(null);
    try {
      const queued = await api<JobResponse>(`/api/matters/${matter.id}/generations`, { method: "POST", body: "{}" });
      setJob({ ...queued, progress: 0, step: "Queued" });
      const stream = new EventSource(`/api/jobs/${queued.jobId}/events`);
      const update = (event: MessageEvent<string>) => {
        const payload = JSON.parse(event.data) as { progress?: number; step?: string; draftId?: string; error?: string };
        setJob((current) => ({ ...(current ?? queued), ...payload }));
      };
      stream.addEventListener("queued", update); stream.addEventListener("progress", update);
      stream.addEventListener("completed", (event) => {
        update(event as MessageEvent<string>);
        const payload = JSON.parse((event as MessageEvent<string>).data) as { draftId: string };
        stream.close(); setBusy(false); void loadDraft(payload.draftId).then(() => loadActivity(matter.id));
      });
      stream.addEventListener("failed", (event) => {
        update(event as MessageEvent<string>); stream.close(); setBusy(false);
      });
      stream.onerror = () => { stream.close(); };
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Generation failed"); setBusy(false); }
  };

  const updateBlock = (blockId: string, text: string) => {
    setWorkingContent((current) => current ? {
      ...current,
      sections: current.sections.map((section) => ({ ...section, blocks: section.blocks.map((block) => block.id === blockId ? { ...block, text } : block) })),
    } : current);
    setDirty(true);
  };

  const save = async () => {
    if (!draft || !workingContent) return;
    setBusy(true); setNotice(null);
    try {
      const saved = await api<DraftResponse>(`/api/drafts/${draft.id}`, { method: "PUT", body: JSON.stringify({ version: draft.version, content: workingContent }) });
      setDraft(saved); setWorkingContent(saved.content); setDirty(false); setNotice(`Saved version ${saved.version}`);
      if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Save failed"); }
    finally { setBusy(false); }
  };

  const selectedBlock = useMemo(() => workingContent?.sections.flatMap((section) => section.blocks).find((block) => block.id === selectedBlockId), [selectedBlockId, workingContent]);

  const refine = async () => {
    if (!draft || !selectedBlock || !refineInstruction.trim()) return;
    setBusy(true); setNotice(null);
    try {
      const result = await api<ProposalResponse>(`/api/drafts/${draft.id}/refinements`, {
        method: "POST", body: JSON.stringify({ instruction: refineInstruction, selectedText: selectedBlock.text }),
      });
      setProposal(result); setRefineInstruction("");
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Refinement failed"); }
    finally { setBusy(false); }
  };

  const resolveProposal = async (resolution: "accept" | "reject") => {
    if (!proposal) return;
    setBusy(true);
    try {
      const result = await api<{ draft?: DraftResponse }>(`/api/proposals/${proposal.id}/${resolution}`, { method: "POST", body: "{}" });
      if (result.draft) { setDraft(result.draft); setWorkingContent(result.draft.content); setDirty(false); }
      setProposal(null); if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Proposal update failed"); }
    finally { setBusy(false); }
  };

  const showCitation = async (sourceId: string, sourceName: string, page: number) => {
    const source = await api<{ sourceId: string; sourceName: string; page: number; text: string }>(`/api/sources/${sourceId}/pages/${page}`);
    setSelectedSource({ ...source, sourceName }); setSourceOpen(true);
  };

  if (!matter) return <Setup onReady={openMatter} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand compact"><div className="brand-mark">S</div><span>Steno</span><small>Demand Studio</small></div>
        <div className="matter-title"><span>MATTER</span><strong>{matter.name}</strong></div>
        <div className="top-actions">
          <button className="icon-button" title="Activity" onClick={() => setActivityOpen((value) => !value)}><History size={18} /></button>
          <button className="avatar" title="Local demo user">FR</button>
          {draft && <a className="export-button" href={`/api/drafts/${draft.id}/export.docx`}><Download size={16} /> Export Word</a>}
        </div>
      </header>

      <div className={`studio ${sourceOpen ? "with-rail" : ""}`}>
        <aside className="left-nav">
          <button className="nav-item active"><FileText size={18} /><span>Draft</span></button>
          <button className="nav-item" onClick={() => setActivityOpen(true)}><Activity size={18} /><span>Activity</span></button>
          <div className="nav-spacer" />
          <button className="nav-item" onClick={() => setMatter(null)}><ArrowLeft size={18} /><span>New matter</span></button>
        </aside>

        <main className="workspace">
          {!draft && !job && <section className="empty-draft">
            <div className="empty-art"><Sparkles size={32} /></div>
            <p className="eyebrow">Evidence packet ready</p><h1>Generate the first draft</h1>
            <p>AI will populate only case-specific regions supported by the {matter.sources.length} uploaded source files. Boilerplate stays anchored to the reviewed Word template.</p>
            <div className="source-summary">{matter.sources.map((source) => <span key={source.id}>{source.mimeType.startsWith("image/") ? <FileImage size={16} /> : <FileText size={16} />}{source.name}</span>)}</div>
            <button className="primary" onClick={() => void generate()} disabled={busy}><Sparkles size={17} /> Generate evidence-grounded draft</button>
          </section>}

          {!draft && job && <section className="generation-card">
            <div className="generating-orb"><LoaderCircle className={job.status !== "failed" ? "spin" : ""} /></div>
            <p className="eyebrow">{job.status === "failed" ? "Generation stopped" : "Drafting in progress"}</p>
            <h1>{job.step}</h1><p>{job.error ?? "Extracting facts, mapping citations, and preserving the reviewed template structure."}</p>
            <div className="progress-track"><span style={{ width: `${job.progress ?? 0}%` }} /></div><strong>{job.progress ?? 0}%</strong>
            {job.status === "failed" && <button className="secondary" onClick={() => { setJob(null); void generate(); }}>Try again</button>}
          </section>}

          {draft && workingContent && <>
            <div className="editor-toolbar">
              <div><p className="eyebrow">Draft editor</p><span>Version {draft.version} · {dirty ? "Unsaved changes" : "All changes saved"}</span></div>
              <div className="toolbar-actions">
                {notice && <span className="notice">{notice}</span>}
                <button className="secondary small" onClick={() => void save()} disabled={!dirty || busy}><Save size={15} /> Save</button>
                <button className="icon-button" onClick={() => setSourceOpen((value) => !value)} title="Toggle source rail">{sourceOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
              </div>
            </div>
            <div className="document-scroll">
              <article className="paper">
                <div className="letterhead"><span className="letterhead-mark">AV</span><div><strong>ATTORNEY REVIEW DRAFT</strong><small>Generated from reviewed template · Not ready to send</small></div></div>
                <h1>{workingContent.title}</h1>
                {workingContent.warnings.map((warning) => <div className="document-warning" key={warning}><CircleAlert size={16} />{warning}</div>)}
                {workingContent.sections.map((section) => <section className="draft-section" key={section.id}>
                  {section.heading && <h2>{section.heading}</h2>}
                  {section.blocks.map((block) => <div key={block.id} onClickCapture={(event) => {
                    const target = event.target as HTMLElement;
                    const citation = target.closest<HTMLButtonElement>(".citation-pill");
                    if (citation?.dataset.sourceId && citation.dataset.page) void showCitation(citation.dataset.sourceId, citation.textContent?.split(" · ")[0] ?? "Source", Number(citation.dataset.page));
                  }}>
                    <BlockEditor block={block} active={selectedBlockId === block.id} onFocus={() => setSelectedBlockId(block.id)} onChange={(text) => updateBlock(block.id, text)} />
                  </div>)}
                </section>)}
              </article>
            </div>
            <div className="refine-bar">
              <div className="ai-glyph"><Sparkles size={18} /></div>
              <div className="refine-input"><span>Refine selected paragraph</span><input value={refineInstruction} onChange={(event) => setRefineInstruction(event.target.value)} placeholder={selectedBlock ? "e.g. Make this more concise without changing facts" : "Select a paragraph first"} disabled={!selectedBlock} onKeyDown={(event) => event.key === "Enter" && void refine()} /></div>
              <button onClick={() => void refine()} disabled={!selectedBlock || !refineInstruction.trim() || busy}><Send size={17} /></button>
            </div>
          </>}
        </main>

        {sourceOpen && <aside className="source-rail">
          <div className="rail-header"><div><p className="eyebrow">Source rail</p><strong>{matter.sources.length} documents</strong></div><button className="icon-button" onClick={() => setSourceOpen(false)}><X size={18} /></button></div>
          {selectedSource ? <div className="source-preview">
            <button className="back-link" onClick={() => setSelectedSource(null)}><ArrowLeft size={15} /> All sources</button>
            <span className="file-icon"><FileText size={22} /></span><h3>{selectedSource.sourceName}</h3><p className="page-label">PAGE {selectedSource.page}</p>
            <div className="extracted-text">{selectedSource.text || "No extractable text on this page."}</div>
          </div> : <div className="source-list">{matter.sources.map((source) => <button key={source.id} className="source-item" onClick={() => source.pageCount && void showCitation(source.id, source.name, 1)}>
            <span className={source.mimeType.startsWith("image/") ? "image" : "pdf"}>{source.mimeType.startsWith("image/") ? <FileImage size={19} /> : <FileText size={19} />}</span>
            <div><strong>{source.name}</strong><small>{source.pageCount} {source.pageCount === 1 ? "page" : "pages"} · {source.status}</small></div><ChevronRight size={16} />
          </button>)}</div>}
          <div className="rail-foot"><ShieldCheck size={16} /> Source text is read-only</div>
        </aside>}
      </div>

      {proposal && <div className="proposal-toast">
        <div className="proposal-head"><Sparkles size={18} /><strong>AI edit proposal</strong><span>Not applied</span></div>
        <p>{proposal.proposal.summary}</p>
        <div className="diff"><del>{proposal.proposal.targetText}</del><ins>{proposal.proposal.replacementText}</ins></div>
        <div className="proposal-actions"><button className="secondary" onClick={() => void resolveProposal("reject")}><X size={15} /> Reject</button><button className="primary" onClick={() => void resolveProposal("accept")}><Check size={15} /> Accept as new version</button></div>
      </div>}

      {activityOpen && <div className="drawer-backdrop" onClick={() => setActivityOpen(false)}><aside className="activity-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="rail-header"><div><p className="eyebrow">Matter history</p><h2>Activity</h2></div><button className="icon-button" onClick={() => setActivityOpen(false)}><X size={19} /></button></div>
        <div className="timeline">{activity.length ? activity.map((event) => <div className="timeline-event" key={event.id}>
          <span>{event.actorType === "agent" ? <Sparkles size={15} /> : <UserRound size={15} />}</span><div><strong>{event.summary}</strong><p>{event.actorName}</p><small><Clock3 size={12} /> {new Date(event.createdAt).toLocaleString()}</small></div>
        </div>) : <p className="muted">No activity yet.</p>}</div>
      </aside></div>}
    </div>
  );
}
