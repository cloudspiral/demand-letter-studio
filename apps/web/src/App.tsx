import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft, Check, ChevronRight, CircleAlert, Download, ExternalLink, FileText,
  LoaderCircle, Plus, RotateCcw, Search, Send, Sparkles, Upload, X,
} from "lucide-react";
import type {
  Citation, DraftBlock, GeneratedDraft, RefinementAnnotation, TemplateRegion,
} from "@steno/contracts";
import { api, streamEvent, upload } from "./api";
import { OnlyOfficeEditor } from "./OnlyOfficeEditor";
import type {
  ActivityResponse, DraftResponse, JobResponse, MatterResponse, ProposalResponse, TemplateResponse, VersionResponse,
} from "./types";

type WorkspaceTab = "review" | "refine" | "activity";
type ChatMessage = { role: "user" | "assistant"; text: string; annotationCount?: number };
type SelectedSource = { sourceId: string; sourceName: string; page: number; text: string; mimeType?: string; extractionMethod?: string; extractionStatus?: string; confidence?: number | null; visualInput?: boolean };

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


type TemplateReviewUnit = {
  id: string;
  kind: "block" | "heading" | "structured" | "figure";
  blockIds: string[];
  title: string;
};

function RegionReviewModal({ template, onCancel, onConfirmed }: {
  template: TemplateResponse;
  onCancel: () => void;
  onConfirmed: (template: TemplateResponse) => void;
}) {
  const storageKey = `steno-template-map-v2:${template.id}`;
  const sourceBlocks = template.confirmedMap?.blocks
    ?? (template.analysis.blocks?.length ? template.analysis.blocks : template.confirmedRegions ?? template.analysis.regions);
  const normalized = sourceBlocks.map((block) => ({
    ...block,
    inlineFields: block.inlineFields ?? [],
    id: block.id ?? `${block.anchor?.partName ?? "word/document.xml"}:p:${block.paragraphIndex}`,
  }));
  const [blocks, setBlocks] = useState<TemplateRegion[]>(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) as TemplateRegion[] : normalized;
    } catch {
      return normalized;
    }
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "attention" | "replace" | "keep">("all");
  const [selectedSpan, setSelectedSpan] = useState<{ blockId: string; start: number; end: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState("All changes saved locally");

  const blockById = useMemo(() => new Map(blocks.map((block) => [block.id!, block])), [blocks]);
  const captionIds = useMemo(() => new Set(blocks.flatMap((block) => block.figure?.captionBlockId ? [block.figure.captionBlockId] : [])), [blocks]);
  const units = useMemo<TemplateReviewUnit[]>(() => {
    const result: TemplateReviewUnit[] = [];
    const seenGroups = new Set<string>();
    blocks.forEach((block) => {
      if (captionIds.has(block.id!)) return;
      if (block.structuredGroup) {
        if (seenGroups.has(block.structuredGroup.id)) return;
        seenGroups.add(block.structuredGroup.id);
        const members = blocks.filter((candidate) => candidate.structuredGroup?.id === block.structuredGroup?.id);
        result.push({
          id: `group:${block.structuredGroup.id}`,
          kind: "structured",
          blockIds: members.map((member) => member.id!),
          title: block.section || "Structured expense section",
        });
        return;
      }
      if (block.semanticKind === "figure") {
        result.push({ id: `figure:${block.id}`, kind: "figure", blockIds: [block.id!], title: block.section || "Evidence figure" });
        return;
      }
      if (block.semanticKind === "heading") {
        if (block.inlineFields?.length) result.push({ id: `heading:${block.id}`, kind: "heading", blockIds: [block.id!], title: block.text });
        return;
      }
      result.push({ id: `block:${block.id}`, kind: "block", blockIds: [block.id!], title: block.section || "Letter content" });
    });
    return result;
  }, [blocks, captionIds]);

  const unitBlocks = (unit: TemplateReviewUnit) => unit.blockIds.map((id) => blockById.get(id)).filter((block): block is TemplateRegion => Boolean(block));
  const unitRole = (unit: TemplateReviewUnit) => unit.kind === "heading"
    ? "heading"
    : unitBlocks(unit).some((block) => block.role === "editable") ? "editable" : "preserve";
  const unitNeedsAttention = (unit: TemplateReviewUnit) => unitBlocks(unit).some((block) => (
    block.needsAttention || (block.inlineFields ?? []).some((field) => field.confidence < 0.8)
  ));
  const orderedUnits = useMemo(() => [...units].sort((left, right) => {
    const rank = (unit: TemplateReviewUnit) => unitNeedsAttention(unit) ? 0 : unitRole(unit) === "editable" ? 1 : 2;
    return rank(left) - rank(right);
  }), [units, blockById]);
  const visibleUnits = orderedUnits.filter((unit) => (
    filter === "all"
    || (filter === "attention" && unitNeedsAttention(unit))
    || (filter === "replace" && unitRole(unit) === "editable")
    || (filter === "keep" && unitRole(unit) === "preserve")
  ));
  const countedUnits = units.filter((unit) => unit.kind !== "heading");
  const replaceCount = countedUnits.filter((unit) => unitRole(unit) === "editable").length;
  const keepCount = countedUnits.filter((unit) => unitRole(unit) === "preserve").length;
  const attentionCount = units.filter(unitNeedsAttention).length;

  useEffect(() => {
    setSaveState("Saving…");
    const timer = window.setTimeout(() => {
      window.localStorage.setItem(storageKey, JSON.stringify(blocks));
      setSaveState("All changes saved locally");
    }, 350);
    return () => window.clearTimeout(timer);
  }, [blocks, storageKey]);

  const updateIds = (ids: string[], update: (block: TemplateRegion) => TemplateRegion) => {
    const selected = new Set(ids);
    setBlocks((current) => current.map((block) => selected.has(block.id!) ? update(block) : block));
  };
  const selectUnit = (unit: TemplateReviewUnit, origin: "document" | "queue") => {
    setActiveId(unit.id);
    const selector = origin === "document" ? `[data-review-card="${CSS.escape(unit.id)}"]` : `[data-review-unit="${CSS.escape(unit.id)}"]`;
    window.setTimeout(() => document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  };
  const unitForBlock = (block: TemplateRegion) => units.find((unit) => unit.blockIds.includes(block.id!));
  const setUnitRole = (unit: TemplateReviewUnit, role: "preserve" | "editable") => {
    if (unit.kind === "heading") return;
    updateIds(unit.blockIds, (block) => ({ ...block, role, aiRecommendation: role === "editable" ? "replace" : "keep", confidence: 1, needsAttention: false }));
  };
  const acceptRecommendation = (unit: TemplateReviewUnit) => updateIds(unit.blockIds, (block) => ({ ...block, needsAttention: false, confidence: Math.max(0.8, block.confidence) }));

  const captureTemplateSelection = (event: React.MouseEvent<HTMLElement>, block: TemplateRegion) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !event.currentTarget.contains(selection.anchorNode)) return;
    const range = selection.getRangeAt(0);
    const prefix = document.createRange();
    prefix.selectNodeContents(event.currentTarget);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    const text = selection.toString();
    if (!text.trim() || block.text.slice(start, start + text.length) !== text) return;
    const overlaps = (block.inlineFields ?? []).some((field) => start < field.end && start + text.length > field.start);
    if (overlaps) { setError("That selection overlaps an existing inline field."); return; }
    setSelectedSpan({ blockId: block.id!, start, end: start + text.length, text });
    const unit = unitForBlock(block);
    if (unit) selectUnit(unit, "document");
  };
  const addInlineField = () => {
    if (!selectedSpan) return;
    const sequence = blocks.flatMap((block) => block.inlineFields ?? []).length + 1;
    updateIds([selectedSpan.blockId], (block) => ({
      ...block,
      inlineFields: [...(block.inlineFields ?? []), {
        key: `custom_field_${sequence}`,
        label: selectedSpan.text.trim().slice(0, 80),
        start: selectedSpan.start,
        end: selectedSpan.end,
        originalText: selectedSpan.text,
        kind: "other",
        confidence: 1,
        explanation: "Added during template confirmation.",
        source: "user",
        role: "replace",
      }],
    }));
    setSelectedSpan(null);
    window.getSelection()?.removeAllRanges();
  };
  const renderAnnotatedText = (block: TemplateRegion) => {
    const fields = [...(block.inlineFields ?? [])].sort((left, right) => left.start - right.start);
    if (!fields.length) return block.text;
    const nodes: ReactNode[] = [];
    let cursor = 0;
    fields.forEach((field) => {
      nodes.push(<span key={`${field.key}:before`}>{block.text.slice(cursor, field.start)}</span>);
      nodes.push(<mark className={`template-inline-field ${field.role}`} key={field.key}>{block.text.slice(field.start, field.end)}</mark>);
      cursor = field.end;
    });
    nodes.push(<span key="after">{block.text.slice(cursor)}</span>);
    return nodes;
  };

  const confirm = async () => {
    setBusy(true); setError(null);
    try {
      const confirmed = await api<TemplateResponse>(`/api/templates/${template.id}/confirm`, {
        method: "POST", body: JSON.stringify({ schemaVersion: 2, blocks }),
      });
      window.localStorage.removeItem(storageKey);
      onConfirmed(confirmed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Template confirmation failed");
    } finally { setBusy(false); }
  };

  return <div className="map-workbench" role="dialog" aria-modal="true" aria-labelledby="map-title">
    <header className="map-header">
      <button className="map-back" onClick={onCancel}><ArrowLeft size={16} /> Back</button>
      <div className="map-title"><p className="eyebrow">Template map</p><h1 id="map-title">Review template structure</h1><span>{templateDisplayName(template)}</span></div>
      <div className="map-progress" aria-label={`${attentionCount} items need attention`}>
        <div><strong>{replaceCount + keepCount}</strong><span>mapped</span></div>
        <div><strong className={attentionCount ? "amber" : "green"}>{attentionCount}</strong><span>attention</span></div>
        <small>{saveState}</small>
      </div>
      <button className="primary map-confirm" onClick={() => void confirm()} disabled={busy || attentionCount > 0}>
        {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />} Confirm map
      </button>
    </header>
    <div className="map-grid">
      <main className="map-document-scroll">
        <div className="map-guidance"><FileText size={15} /><span>The complete original letter stays visible. Select any passage to review it, or highlight exact text to create a replacement field.</span></div>
        <article className="map-paper">
          {blocks.map((block) => {
            if (block.anchor?.partName && block.anchor.partName !== "word/document.xml" && block.anchor.kind !== "header") return null;
            const unit = unitForBlock(block);
            const role = block.role === "editable" ? "replace" : block.role === "heading" ? "heading" : "keep";
            return <section
              className={`map-document-block ${role} ${unit && activeId === unit.id ? "selected" : ""} ${block.needsAttention ? "attention" : ""}`}
              data-review-unit={unit?.id}
              key={block.id}
              onClick={() => unit && selectUnit(unit, "document")}
            >
              {unit && <span className="map-block-pill">{unit.kind === "structured" ? "Group" : unit.kind === "figure" ? "Figure" : role}</span>}
              {block.semanticKind === "figure"
                ? <div className="map-figure-placeholder"><FileText size={22} /><strong>Mapped evidence figure</strong><span>{block.figure?.partName}</span></div>
                : <p
                    onMouseUp={(event) => captureTemplateSelection(event, block)}
                    style={{
                      textAlign: block.formatting?.alignment === "center" ? "center" : block.formatting?.alignment === "right" ? "right" : "left",
                      fontWeight: block.formatting?.bold || block.semanticKind === "heading" ? 700 : undefined,
                      fontStyle: block.formatting?.italic ? "italic" : undefined,
                    }}
                  >{renderAnnotatedText(block)}</p>}
            </section>;
          })}
        </article>
      </main>
      <aside className="map-queue">
        <div className="map-queue-sticky">
          <div><p className="eyebrow">Review queue</p><strong>{visibleUnits.length} {visibleUnits.length === 1 ? "item" : "items"}</strong></div>
          <div className="map-filters">
            {(["all", "attention", "replace", "keep"] as const).map((value) => <button className={filter === value ? "active" : ""} key={value} onClick={() => setFilter(value)}>{value}</button>)}
          </div>
        </div>
        {selectedSpan && <div className="map-selection-card"><small>Selected text</small><q>{selectedSpan.text}</q><button onClick={addInlineField}><Plus size={13} /> Add replacement field</button></div>}
        <div className="map-card-list">
          {visibleUnits.map((unit) => {
            const members = unitBlocks(unit);
            const first = members[0]!;
            const role = unitRole(unit);
            const attention = unitNeedsAttention(unit);
            const fields = members.flatMap((block) => (block.inlineFields ?? []).map((field) => ({ block, field })));
            return <article
              className={`map-review-card ${role} ${attention ? "attention" : ""} ${activeId === unit.id ? "selected" : ""}`}
              data-review-card={unit.id}
              key={unit.id}
              onClick={() => selectUnit(unit, "queue")}
            >
              <div className="map-card-heading">
                <span>{unit.kind === "structured" ? "Structured group" : unit.kind === "figure" ? "Evidence figure" : unit.kind === "heading" ? "Locked heading" : "Content block"}</span>
                <i>{attention ? "Attention" : role === "editable" ? "Replace" : unit.kind === "heading" ? "Heading" : "Keep"}</i>
              </div>
              <h2>{unit.title}</h2>
              <p>{unit.kind === "structured" ? `${members.length} mapped rows are handled as one 0-N group, including total-row formatting.` : unit.kind === "figure" ? "Replace only with an uploaded evidence image and a source-grounded caption, or omit the figure and caption together." : first.text}</p>
              {unit.kind !== "heading" && <div className="map-role-toggle">
                <button className={role === "preserve" ? "active keep" : ""} onClick={(event) => { event.stopPropagation(); setUnitRole(unit, "preserve"); }}><Check size={12} /> Keep</button>
                <button className={role === "editable" ? "active replace" : ""} onClick={(event) => { event.stopPropagation(); setUnitRole(unit, "editable"); }}><Sparkles size={12} /> Replace</button>
              </div>}
              {attention && <div className="map-recommendation"><CircleAlert size={14} /><span><strong>Review recommendation · {Math.round(first.confidence * 100)}%</strong>{first.explanation || "Confirm the appropriate map decision."}</span><button onClick={(event) => { event.stopPropagation(); acceptRecommendation(unit); }}>Accept</button></div>}
              {fields.length > 0 && <div className={`map-field-list ${role === "preserve" && unit.kind !== "heading" ? "parent-kept" : ""}`}>
                <strong>Inline fields</strong>
                {fields.map(({ block, field }) => <div className="map-field-row" key={field.key}>
                  <span><b>{field.label}</b><code>{field.originalText}</code></span>
                  <div>
                    <button disabled={role === "preserve" && unit.kind !== "heading"} className={field.role === "keep" ? "active" : ""} onClick={(event) => { event.stopPropagation(); updateIds([block.id!], (candidate) => ({ ...candidate, inlineFields: candidate.inlineFields?.map((item) => item.key === field.key ? { ...item, role: "keep" } : item) })); }}>Keep</button>
                    <button disabled={role === "preserve" && unit.kind !== "heading"} className={field.role === "replace" ? "active" : ""} onClick={(event) => { event.stopPropagation(); updateIds([block.id!], (candidate) => ({ ...candidate, inlineFields: candidate.inlineFields?.map((item) => item.key === field.key ? { ...item, role: "replace" } : item) })); }}>Replace</button>
                    {field.source === "user" && <button aria-label={`Remove ${field.label}`} onClick={(event) => { event.stopPropagation(); updateIds([block.id!], (candidate) => ({ ...candidate, inlineFields: candidate.inlineFields?.filter((item) => item.key !== field.key) })); }}><X size={11} /></button>}
                  </div>
                </div>)}
                {role === "preserve" && unit.kind !== "heading" && <small>Child field choices are saved but inactive while the parent block is Keep.</small>}
              </div>}
            </article>;
          })}
          {!visibleUnits.length && <div className="map-empty"><Check size={18} /><span>No queue items match this filter. The complete template remains visible.</span></div>}
        </div>
        {error && <div className="error-banner map-error"><CircleAlert size={15} />{error}</div>}
      </aside>
    </div>
  </div>;
}

function Setup({ onReady }: { onReady: (matterId: string) => Promise<void> }) {
  const [templates, setTemplates] = useState<TemplateResponse[]>([]);
  const [selected, setSelected] = useState<TemplateResponse | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<File | null>(null);
  const [pendingCaseWorkspaceId, setPendingCaseWorkspaceId] = useState<string | null>(null);
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
    setPendingTemplate(null);
    setSelected(template);
  };

  const uploadTemplate = (file: File) => {
    setSelected(null);
    setPendingTemplate(file);
    setError(null);
  };

  const addFiles = (incoming: File[]) => setFiles((current) => {
    const keyed = new Map(current.map((file) => [`${file.name}:${file.size}`, file]));
    incoming.forEach((file) => keyed.set(`${file.name}:${file.size}`, file));
    return [...keyed.values()];
  });

  const generate = async () => {
    if ((!selected && !pendingTemplate) || !files.length) return;
    if (pendingCaseWorkspaceId && selected?.status === "analyzed") {
      setReview(selected);
      return;
    }
    setBusy(true); setError(null);
    try {
      setBusyLabel("Analyzing the template and extracting the complete case packet…");
      const form = new FormData();
      if (selected) form.append("templateId", selected.id);
      if (pendingTemplate) form.append("template", pendingTemplate);
      files.forEach((file) => form.append("sources", file));
      const intake = await api<{
        caseWorkspace: { id: string };
        template: TemplateResponse;
      }>("/api/intakes", { method: "POST", body: form });
      setTemplates((current) => [intake.template, ...current.filter((template) => template.id !== intake.template.id)]);
      if (intake.template.status === "confirmed") {
        await onReady(intake.caseWorkspace.id);
      } else {
        setSelected(intake.template);
        setPendingTemplate(null);
        setPendingCaseWorkspaceId(intake.caseWorkspace.id);
        setReview(intake.template);
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Matter setup failed"); }
    finally { setBusy(false); }
  };

  const loadSample = async () => {
    setBusy(true); setBusyLabel("Preparing supplied sample…"); setError(null);
    try {
      const result = await api<{ matterId: string }>("/api/demo/bootstrap", { method: "POST", body: "{}" });
      await onReady(result.matterId);
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
            <label className={`template-card upload-template-card ${pendingTemplate ? "selected" : ""}`}>
              <input type="file" accept=".docx" onChange={(event) => event.target.files?.[0] && uploadTemplate(event.target.files[0])} />
              <div className="template-tag"><span>{pendingTemplate ? "Selected upload" : "Upload your own"}</span><Plus size={17} /></div>
              <strong>{pendingTemplate?.name ?? "Use a firm template or completed letter"}</strong>
              <small>{pendingTemplate ? `${formatBytes(pendingTemplate.size)} · analyzed with the case packet in parallel` : "Upload a DOCX. You will confirm Keep, Replace, and inline fields against the exact original letter."}</small>
            </label>
            {filtered.map((template) => {
              const displayName = templateDisplayName(template);
              const createdLabel = template.isTest ? templateCreatedLabel(template.createdAt) : null;
              return (
                <button className={`template-card ${selected?.id === template.id ? "selected" : ""}`} key={template.id} onClick={() => chooseTemplate(template)}>
                  <div className="template-tag"><span>{template.isTest ? "Test template" : template.status === "confirmed" ? "Firm template" : "Review needed"}</span>{template.status === "confirmed" && <span
                    className="edit-map-link" role="button" tabIndex={0}
                    onClick={(event) => { event.stopPropagation(); setSelected(template); setReview(template); }}
                    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); setSelected(template); setReview(template); } }}
                  >Edit map</span>}<i /></div>
                  <strong title={displayName}>{displayName}</strong>
                  <small>{template.analysis.paragraphCount} paragraphs · {template.analysis.regions.filter((region) => region.role === "editable").length} Replace blocks</small>
                  {createdLabel && <small className="template-created">Test run · {createdLabel}</small>}
                </button>
              );
            })}
            {query && filtered.length === 0 && <p className="template-empty">No real templates match “{query}”. Clear the search or upload a DOCX.</p>}
          </div>
          {sampleAvailable && <button className="sample-shortcut" onClick={() => void loadSample()} disabled={busy}>
            <Sparkles size={16} /><span><strong>Use the supplied Steno sample packet</strong><small>Loads the provided completed letter and five fictional case files.</small></span><ChevronRight size={17} />
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
          <button className="primary generate-button" onClick={() => void generate()} disabled={(!selected && !pendingTemplate) || !files.length || busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} {selected?.status === "confirmed" && !pendingTemplate ? "Generate draft" : "Continue to template map"}
          </button>
          <p>The uploaded DOCX is analyzed while PDF text and OCR are extracted. No hidden case summary is created. Nothing is sent to a carrier.</p>
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
          if (pendingCaseWorkspaceId) {
            const caseWorkspaceId = pendingCaseWorkspaceId;
            setPendingCaseWorkspaceId(null);
            void api(`/api/matters/${caseWorkspaceId}/template-map`, { method: "POST", body: "{}" })
              .then(() => onReady(caseWorkspaceId))
              .catch((caught) => setError(caught instanceof Error ? caught.message : "The template map could not be pinned."));
          }
        }}
      />}
    </div>
  );
}

function RefinePanel({
  tab, setTab, messages, activity, annotations, instruction, proposal, thinking, activeBlock,
  availableBlocks, reviewContent, versions, onInstruction, onActiveBlock, onRemoveAnnotation, onSend, onResolve, onRestore,
}: {
  tab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
  messages: ChatMessage[];
  activity: ActivityResponse[];
  versions: VersionResponse[];
  annotations: RefinementAnnotation[];
  instruction: string;
  proposal: ProposalResponse | null;
  thinking: boolean;
  activeBlock: DraftBlock | null;
  availableBlocks: DraftBlock[];
  reviewContent: ReactNode;
  onInstruction: (value: string) => void;
  onActiveBlock: (blockId: string) => void;
  onRemoveAnnotation: (index: number) => void;
  onSend: () => void;
  onResolve: (resolution: "accept" | "reject") => void;
  onRestore: (version: number) => void;
}) {
  return (
    <aside className="right-panel">
      <div className="panel-tabs">
        <button className={tab === "review" ? "active" : ""} onClick={() => setTab("review")}>Review</button>
        <button className={tab === "refine" ? "active" : ""} onClick={() => setTab("refine")}>Refine with AI</button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>Activity</button>
      </div>
      {tab === "review" ? <div className="unified-review-panel">{reviewContent}</div> : tab === "refine" ? <>
        <div className="chat-scroll">
          {!messages.length && <div className="chat-intro"><Sparkles size={22} /><strong>Refine without losing control</strong><p>Choose a mapped paragraph, instruct the AI, and review every proposed change before it is applied.</p></div>}
          {messages.map((message, index) => <div className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
            {!!message.annotationCount && <small>❝ {message.annotationCount} selected {message.annotationCount === 1 ? "passage" : "passages"}</small>}
            <p>{message.text}</p>
          </div>)}
          {thinking && <div className="thinking"><LoaderCircle className="spin" size={14} /> Drafting a revision…</div>}
          {proposal && <div className="proposal-card">
            <p className="eyebrow">Proposed edit · {proposal.proposal.edits.length} {proposal.proposal.edits.length === 1 ? "passage" : "passages"}</p>
            <strong>{proposal.proposal.summary}</strong>
            <div className="proposal-preview">{proposal.proposal.edits.map((edit, index) => <div key={`${edit.blockId}-${index}`}><del>{edit.targetText}</del><ins>{edit.replacementText}</ins></div>)}</div>
            <div className="proposal-actions"><button className="accept" onClick={() => onResolve("accept")}><Check size={14} /> Accept</button><button className="reject" onClick={() => onResolve("reject")}><X size={14} /> Reject</button></div>
          </div>}
          {!proposal && !thinking && <div className="suggestions">
            {["Make this more concise", "Strengthen the liability language", "Clarify the treatment timeline"].map((suggestion) => <button key={suggestion} onClick={() => onInstruction(suggestion)}>{suggestion}</button>)}
          </div>}
        </div>
        <div className="composer">
          <label className="refine-target"><span>Mapped paragraph</span><select value={activeBlock?.id ?? ""} onChange={(event) => onActiveBlock(event.target.value)}>
            {availableBlocks.map((block) => <option value={block.id} key={block.id}>{block.text.slice(0, 86) || "Blank mapped paragraph"}</option>)}
          </select></label>
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
        <div className="version-list">
          <p className="eyebrow">Draft versions</p>
          {versions.map((version) => <div className="version-row" key={version.version}>
            <div><strong>v{version.version}{version.current ? " · Current" : ""}</strong><p>{version.changeSummary}</p><small>{version.actor} · {new Date(version.timestamp).toLocaleString()}</small></div>
            {!version.current && <button className="secondary" onClick={() => onRestore(version.version)}>Restore</button>}
          </div>)}
        </div>
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
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [activeReviewItemId, setActiveReviewItemId] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<SelectedSource | null>(null);
  const [activeCitation, setActiveCitation] = useState<{ sourceId: string; page: number; number: number } | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>("review");
  const [activity, setActivity] = useState<ActivityResponse[]>([]);
  const [versions, setVersions] = useState<VersionResponse[]>([]);
  const [annotations, setAnnotations] = useState<RefinementAnnotation[]>([]);
  const [instruction, setInstruction] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [proposal, setProposal] = useState<ProposalResponse | null>(null);
  const [thinking, setThinking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [outcomeValues, setOutcomeValues] = useState<Record<string, string>>({});
  const [addingEvidence, setAddingEvidence] = useState(false);
  const [confirmingOutcomeId, setConfirmingOutcomeId] = useState<string | null>(null);
  const [undoVersion, setUndoVersion] = useState<number | null>(null);
  const [renamingMatter, setRenamingMatter] = useState(false);
  const [matterName, setMatterName] = useState("");

  const loadActivity = useCallback(async (matterId: string) => setActivity(await api(`/api/matters/${matterId}/activity`)), []);
  const refreshMatter = useCallback(async (matterId: string) => {
    const loaded = await api<MatterResponse>(`/api/matters/${matterId}`);
    setMatter(loaded); setMatterName(loaded.name);
    return loaded;
  }, []);
  const loadVersions = useCallback(async (draftId: string) => setVersions(await api<VersionResponse[]>(`/api/drafts/${draftId}/versions`)), []);
  const loadDraft = useCallback(async (draftId: string) => {
    const loaded = await api<DraftResponse>(`/api/drafts/${draftId}`);
    setDraft(loaded); setContent(loaded.content);
    setTab("review");
    setActiveBlockId(loaded.content.sections.flatMap((section) => section.blocks)[0]?.id ?? null);
    setFieldValues(Object.fromEntries(Object.entries(loaded.content.fields).map(([key, field]) => [key, field.value ?? ""])));
    setOutcomeValues({});
    await loadVersions(draftId);
  }, [loadVersions]);

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

  const openMatter = useCallback(async (matterId: string) => {
    const loaded = await refreshMatter(matterId);
    if (loaded.activeDraft) await loadDraft(loaded.activeDraft.id);
    else await generateForMatter(loaded);
    await loadActivity(matterId);
  }, [generateForMatter, loadActivity, loadDraft, refreshMatter]);

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

  const addEvidence = async (files: File[]) => {
    if (!matter || !files.length) return;
    setAddingEvidence(true); setNotice(null);
    try {
      await upload(`/api/matters/${matter.id}/sources`, files);
      const refreshed = await refreshMatter(matter.id);
      if (draft) await loadDraft(draft.id);
      setTab("review");
      setNotice(`Added ${files.length} evidence ${files.length === 1 ? "file" : "files"}. Regenerating from the complete updated packet.`);
      if (draft) await generateForMatter(refreshed, draft);
      else await generateForMatter(refreshed);
      await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Evidence could not be added"); }
    finally { setAddingEvidence(false); }
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
      setProposal(result); setAnnotations([]);
      setMessages((current) => [...current, { role: "assistant", text: `I prepared ${result.proposal.edits.length === 1 ? "a tracked revision" : `${result.proposal.edits.length} tracked revisions`}. Review the before-and-after text below, then accept or reject it.` }]);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Refinement failed"); }
    finally { setThinking(false); }
  };

  const resolveProposal = async (resolution: "accept" | "reject") => {
    if (!proposal) return;
    try {
      const result = await api<{ draft?: DraftResponse }>(`/api/proposals/${proposal.id}/${resolution}`, { method: "POST", body: "{}" });
      if (result.draft) {
        setUndoVersion(draft?.version ?? null);
        setDraft(result.draft); setContent(result.draft.content);
        setFieldValues(Object.fromEntries(Object.entries(result.draft.content.fields).map(([key, field]) => [key, field.value ?? ""])));
        setNotice(`AI proposal accepted in draft v${result.draft.version}.`);
        await loadVersions(result.draft.id);
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
      setUndoVersion(draft.version); setDraft(saved); setContent(saved.content);
      setFieldValues(Object.fromEntries(Object.entries(saved.content.fields).map(([fieldKey, field]) => [fieldKey, field.value ?? ""])));
      setNotice(`Field saved in draft v${saved.version}`); await loadVersions(saved.id); if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Field could not be confirmed"); }
  };

  const confirmOutcome = async (outcomeId: string) => {
    if (!draft || !matter) return;
    setConfirmingOutcomeId(outcomeId); setNotice(null);
    try {
      const saved = await api<DraftResponse>(`/api/drafts/${draft.id}/outcomes/${encodeURIComponent(outcomeId)}/confirm`, {
        method: "POST", body: JSON.stringify({ version: draft.version }),
      });
      setUndoVersion(draft.version); setDraft(saved); setContent(saved.content); setTab("review");
      setNotice(`Omission confirmed in audited draft v${saved.version}.`);
      await loadVersions(saved.id);
      await Promise.all([refreshMatter(matter.id), loadActivity(matter.id)]);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "The omission could not be confirmed"); }
    finally { setConfirmingOutcomeId(null); }
  };

  const supplyOutcome = async (outcomeId: string) => {
    if (!draft || !matter) return;
    const outcome = draft.content.outcomes.find((candidate) => candidate.id === outcomeId);
    if (!outcome) { setNotice("The omitted target is no longer in this draft version."); return; }
    setConfirmingOutcomeId(outcomeId); setNotice(null);
    try {
      const saved = await api<DraftResponse>(`/api/drafts/${draft.id}/outcomes/${encodeURIComponent(outcomeId)}/supply`, {
        method: "POST", body: JSON.stringify({
          version: draft.version,
          values: outcome.targetKind === "structured"
            ? (outcomeValues[outcomeId] ?? "").split(/\n+/)
            : [outcomeValues[outcomeId] ?? ""],
        }),
      });
      setUndoVersion(draft.version); setDraft(saved); setContent(saved.content); setOutcomeValues((current) => ({ ...current, [outcomeId]: "" })); setTab("review");
      setNotice(`Reviewed value saved in draft v${saved.version}.`);
      await loadVersions(saved.id);
      await Promise.all([refreshMatter(matter.id), loadActivity(matter.id)]);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "The reviewed value could not be saved"); }
    finally { setConfirmingOutcomeId(null); }
  };

  const restoreVersion = async (restoreVersionNumber: number) => {
    if (!draft) return;
    try {
      const saved = await api<DraftResponse>(`/api/drafts/${draft.id}/restore`, {
        method: "POST", body: JSON.stringify({ currentVersion: draft.version, restoreVersion: restoreVersionNumber }),
      });
      setUndoVersion(draft.version); setDraft(saved); setContent(saved.content);
      setFieldValues(Object.fromEntries(Object.entries(saved.content.fields).map(([key, field]) => [key, field.value ?? ""])));
      setNotice(`Restored version ${restoreVersionNumber} as draft v${saved.version}.`);
      await loadVersions(saved.id);
      if (matter) await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Draft version could not be restored"); }
  };

  const refreshAfterWordSave = async () => {
    if (!draft || !matter) return;
    const baseVersion = draft.version;
    setNotice("Saving Word edits…");
    try {
      await api(`/api/drafts/${draft.id}/versions/${baseVersion}/force-save`, { method: "POST", body: "{}" });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "The Word editor could not start its save callback.");
      return;
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      try {
        const loaded = await api<DraftResponse>(`/api/drafts/${draft.id}`);
        if (loaded.version <= baseVersion) continue;
        setUndoVersion(baseVersion);
        setDraft(loaded); setContent(loaded.content);
        setFieldValues(Object.fromEntries(Object.entries(loaded.content.fields).map(([key, field]) => [key, field.value ?? ""])));
        setNotice(`Word edits saved in draft v${loaded.version}.`);
        await Promise.all([loadVersions(loaded.id), loadActivity(matter.id), refreshMatter(matter.id)]);
        return;
      } catch {
        // The save callback may still be processing; keep polling briefly.
      }
    }
    setNotice("The Word save callback did not complete. Retry the editor; the prior version remains unchanged.");
  };

  const renameMatter = async () => {
    if (!matter || !matterName.trim() || matterName.trim() === matter.name) { setRenamingMatter(false); return; }
    try {
      const updated = await api<MatterResponse>(`/api/matters/${matter.id}`, { method: "PATCH", body: JSON.stringify({ name: matterName.trim() }) });
      setMatter((current) => current ? { ...current, name: updated.name } : current);
      setMatterName(updated.name); setRenamingMatter(false); await loadActivity(matter.id);
    } catch (caught) { setNotice(caught instanceof Error ? caught.message : "Matter could not be renamed"); }
  };

  const focusReviewTarget = (targetId: string, outcomeId?: string) => {
    setTab("review");
    setActiveReviewItemId(outcomeId ?? targetId);
    const block = content?.sections.flatMap((section) => section.blocks).find((candidate) => candidate.targetId === targetId);
    if (block) setActiveBlockId(block.id);
  };

  if (!matter) return <Setup onReady={openMatter} />;

  const readiness = draft?.readiness ?? null;
  const exportBlocked = !readiness?.ready;
  const jobActive = job?.status === "queued" || job?.status === "processing";
  const generationActive = jobActive && job?.jobType === "generation";
  const targetById = new Map((draft?.targets ?? []).map((target) => [target.id, target]));
  const confirmedOmissions = new Set(content?.confirmedOmissionTargetIds ?? []);
  const unresolvedOutcomes = content?.outcomes.filter((outcome) => outcome.status === "omitted" && !confirmedOmissions.has(outcome.targetId)) ?? [];
  const blockingCount = (readiness?.fieldKeys.length ?? 0) + (readiness?.omittedTargetIds.length ?? 0)
    + (readiness?.staleEvidence ? 1 : 0) + (readiness?.duplicateParagraphIndexes.length ?? 0) + (readiness?.imageIssue ? 1 : 0);
  const blockerDescriptions = [
    readiness?.omittedTargetIds.length
      ? `${readiness.omittedTargetIds.length} unresolved ${readiness.omittedTargetIds.length === 1 ? "omission" : "omissions"}`
      : null,
    readiness?.fieldKeys.length
      ? `${readiness.fieldKeys.length} missing ${readiness.fieldKeys.length === 1 ? "field" : "fields"}`
      : null,
    readiness?.staleEvidence ? "evidence was added after this version" : null,
    readiness?.duplicateParagraphIndexes.length
      ? `${readiness.duplicateParagraphIndexes.length} duplicate template ${readiness.duplicateParagraphIndexes.length === 1 ? "mapping" : "mappings"}`
      : null,
    readiness?.imageIssue ?? null,
  ].filter((description): description is string => Boolean(description));

  const reviewContent = content && draft ? <>
    <div className="review-panel-summary">
      <div><p className="eyebrow">Draft readiness</p><strong>{readiness?.ready ? "Ready for export" : `${blockingCount} blocking ${blockingCount === 1 ? "item" : "items"}`}</strong></div>
      <span className={readiness?.ready ? "ready" : "blocked"}>{readiness?.ready ? <Check size={14} /> : <CircleAlert size={14} />}</span>
    </div>
    {blockingCount > 0 ? <section className="review-card-group blocking-group">
      <div className="review-group-title"><span>Blocking</span><b>{blockingCount}</b></div>
      {readiness?.staleEvidence && <article className="workbench-review-card blocking">
        <div className="review-card-label"><CircleAlert size={14} /><span>Evidence changed</span></div>
        <h3>This draft predates the current source set</h3>
        <p>Review the updated sources and regenerate. Earlier omission approvals are not silently carried forward.</p>
        <button className="primary" disabled={generationActive} onClick={() => void generateForMatter(matter, draft)}><RotateCcw size={13} /> Regenerate v{draft.version + 1}</button>
      </article>}
      {unresolvedOutcomes.map((outcome) => {
        const target = targetById.get(outcome.targetId);
        return <article data-review-item={outcome.id} className={`workbench-review-card blocking ${activeReviewItemId === outcome.id ? "selected" : ""}`} key={outcome.id} onClick={() => focusReviewTarget(outcome.targetId, outcome.id)}>
          <div className="review-card-label"><CircleAlert size={14} /><span>Omitted during generation</span></div>
          <h3>{target?.label || "Unlabeled template section"}</h3>
          {target?.exemplarExcerpt && <blockquote className="review-exemplar">“{target.exemplarExcerpt}”</blockquote>}
          <p>{outcome.note || "Generation found no support for this mapped target, so no template matter content was copied into the draft."}</p>
          {outcome.citations.map((citation, index) => <button className="source-link" key={`${citation.sourceId}-${citation.page}-${index}`} onClick={(event) => { event.stopPropagation(); void showReviewCitation(citation); }}>{citation.sourceName} · p. {citation.page}</button>)}
          <div className="review-card-meta"><span>{outcome.exemplarCount} template {outcome.exemplarCount === 1 ? "block" : "blocks"}</span><span>0 generated</span></div>
          {outcome.targetKind !== "figure" && <label className="review-field-input">
            {outcome.targetKind === "structured"
              ? <textarea
                  rows={Math.min(4, Math.max(2, target?.exemplarCount ?? 2))}
                  value={outcomeValues[outcome.id] ?? ""}
                  placeholder="One row per line; use | between columns"
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setOutcomeValues((current) => ({ ...current, [outcome.id]: event.target.value }))}
                />
              : <input
                  value={outcomeValues[outcome.id] ?? ""}
                  placeholder="Enter the reviewed value"
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => setOutcomeValues((current) => ({ ...current, [outcome.id]: event.target.value }))}
                />}
            <small>{outcome.targetKind === "structured" ? "Use one line per row and | between columns." : "This records an attorney-supplied value without claiming source grounding."}</small>
          </label>}
          <div className="review-card-actions">
            <label className="secondary file-action"><input type="file" accept=".pdf,image/*" multiple onChange={(event) => { event.stopPropagation(); if (event.target.files) void addEvidence([...event.target.files]); event.currentTarget.value = ""; }} /><Upload size={13} /> Add evidence and regenerate</label>
            {outcome.targetKind !== "figure" && <button className="primary" disabled={confirmingOutcomeId === outcome.id || !(outcomeValues[outcome.id] ?? "").trim()} onClick={(event) => { event.stopPropagation(); void supplyOutcome(outcome.id); }}>{confirmingOutcomeId === outcome.id ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} Save value</button>}
            <button className="secondary" disabled={confirmingOutcomeId === outcome.id} onClick={(event) => { event.stopPropagation(); void confirmOutcome(outcome.id); }}>Leave blank</button>
          </div>
        </article>;
      })}
      {readiness?.fieldKeys.map((key) => {
        const field = content.fields[key];
        if (!field) return null;
        return <article data-review-item={`field:${key}`} className={`workbench-review-card blocking ${activeReviewItemId === `field:${key}` ? "selected" : ""}`} key={key} onClick={() => setActiveReviewItemId(`field:${key}`)}>
          <div className="review-card-label"><CircleAlert size={14} /><span>Missing field</span></div>
          <h3>{field.label ?? key.replaceAll("_", " ")}</h3>
          <p>{field.note}</p>
          {field.citations.map((citation, index) => <button className="source-link" key={`${citation.sourceId}-${citation.page}-${index}`} onClick={(event) => { event.stopPropagation(); void showReviewCitation(citation); }}>{citation.sourceName} · p. {citation.page}</button>)}
          <label className="review-field-input"><input value={fieldValues[key] ?? ""} onChange={(event) => setFieldValues((current) => ({ ...current, [key]: event.target.value }))} /><small>Entering a value records the attorney's approval.</small></label>
          <button className="primary" onClick={(event) => { event.stopPropagation(); void confirmField(key); }}><Check size={13} /> Save value</button>
        </article>;
      })}
    </section> : <div className="review-clear"><Check size={16} /><span>Ready to export</span></div>}
  </> : <p className="panel-empty">Generate a draft to open the review workbench.</p>;

  return (
    <div className="workspace-app">
      <header className="app-header workspace-header">
        <div className="wordmark">Steno <span>Demand Letter Studio</span></div>
        <div className="matter-breadcrumb"><span>/</span>{renamingMatter
          ? <input autoFocus value={matterName} onChange={(event) => setMatterName(event.target.value)} onBlur={() => void renameMatter()} onKeyDown={(event) => { if (event.key === "Enter") void renameMatter(); if (event.key === "Escape") { setMatterName(matter.name); setRenamingMatter(false); } }} />
          : <button className="matter-name-button" onClick={() => setRenamingMatter(true)} title="Rename matter">{matter.name}</button>}{draft && <i>Draft v{draft.version}</i>}</div>
        <div className="workspace-actions"><span className="single-user"><b>FR</b> Single-user v1</span>{draft && (exportBlocked
          ? <button className="export-button export-blocked" aria-disabled="true" title="Open Review to resolve all server-reported readiness items" onClick={() => { setTab("review"); setNotice(`Word export is blocked by ${blockingCount} review ${blockingCount === 1 ? "item" : "items"}.`); }}><CircleAlert size={15} /> {blockingCount} blocking · Review</button>
          : <a className="export-button" href={`/api/drafts/${draft.id}/export.docx`}><Download size={15} /> Export to Word</a>)}</div>
      </header>
      <div className="workspace-grid">
        <aside className="source-strip">
          <button className="back-to-setup" onClick={() => { setMatter(null); setDraft(null); setContent(null); setJob(null); }} title="Start a new draft"><ArrowLeft size={17} /></button>
          <button className={sourcesOpen ? "active" : ""} onClick={() => setSourcesOpen((current) => !current)}><FileText size={15} /><span>Sources · {matter.sources.length}</span></button>
        </aside>

        <main className="letter-workspace">
          {!content && <section className="generation-state">
            <div className="generation-glyph"><LoaderCircle className={job?.status !== "failed" ? "spin" : ""} size={28} /></div>
            <p className="eyebrow">{job?.status === "failed" ? "Generation stopped" : "Drafting in progress"}</p>
            <h1>{job?.step ?? "Preparing the drafting job"}</h1>
            <p>{job?.error ?? "Extracting facts, validating citations, and preserving the reviewed template structure."}</p>
            <div className="progress-track"><span style={{ width: `${job?.progress ?? 4}%` }} /></div><strong>{job?.progress ?? 4}%</strong>
            {job?.status === "failed" && <button className="secondary" onClick={() => void generateForMatter(matter)}>Try again</button>}
          </section>}

          {content && <div className="letter-scroll">
            {generationActive && <div className="job-banner"><LoaderCircle className="spin" size={16} /><span>{job?.step ?? "Regenerating draft"} · {job?.progress ?? 0}%</span></div>}
            {readiness && !readiness.ready && <div className="confidence-banner"><CircleAlert size={17} /><span>Word export is locked by {blockingCount} review {blockingCount === 1 ? "item" : "items"}: {blockerDescriptions.join("; ")}.</span></div>}
            {notice && <div className="workspace-notice">{notice}{undoVersion !== null && draft && <button className="notice-undo" onClick={() => { const target = undoVersion; setUndoVersion(null); void restoreVersion(target); }}><RotateCcw size={13} /> Undo</button>}<button onClick={() => { setNotice(null); setUndoVersion(null); }}><X size={13} /></button></div>}
            {draft && <OnlyOfficeEditor
              draftId={draft.id}
              version={draft.version}
              disabled={generationActive}
              onSaved={refreshAfterWordSave}
            />}
          </div>}
        </main>

        <RefinePanel
          tab={tab} setTab={setTab} messages={messages} activity={activity} annotations={annotations}
          instruction={instruction} proposal={proposal} thinking={thinking} activeBlock={activeBlock}
          availableBlocks={content?.sections.flatMap((section) => section.blocks).filter((block) => block.kind !== "heading" && block.text.trim()) ?? []}
          reviewContent={reviewContent} versions={versions}
          onInstruction={setInstruction}
          onActiveBlock={setActiveBlockId}
          onRemoveAnnotation={(index) => setAnnotations((current) => current.filter((_annotation, candidate) => candidate !== index))}
          onSend={() => void sendRefinement()}
          onResolve={(resolution) => void resolveProposal(resolution)}
          onRestore={(version) => void restoreVersion(version)}
        />

        {sourcesOpen && <>
          <button className="source-scrim" onClick={() => { setSourcesOpen(false); setActiveCitation(null); }} aria-label="Close sources" />
          <aside className="source-drawer">
            <div className="drawer-head"><div><p className="eyebrow">Source materials</p><strong>{matter.sources.length} real documents</strong></div><button className="icon-button" onClick={() => setSourcesOpen(false)}><X size={17} /></button></div>
            <div className="source-template-card"><small>Reviewed template</small><strong>Firm DOCX template</strong></div>
            <div className="drawer-evidence-actions">
              <label className={`secondary file-action ${addingEvidence || generationActive ? "disabled" : ""}`}><input type="file" accept=".pdf,image/*" multiple disabled={addingEvidence || generationActive} onChange={(event) => { if (event.target.files) void addEvidence([...event.target.files]); event.currentTarget.value = ""; }} />{addingEvidence ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />} Add evidence and regenerate</label>
              {draft && <button className="primary regenerate-button" disabled={generationActive || addingEvidence} onClick={() => void generateForMatter(matter, draft)}>{generationActive ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />} Regenerate v{draft.version + 1}</button>}
            </div>
            {draft?.readiness.staleEvidence && <div className="drawer-stale"><CircleAlert size={14} />This draft predates the current source set. Regenerate before export.</div>}
            <div className="drawer-sources">{matter.sources.map((source) => {
              const active = activeCitation?.sourceId === source.id;
              return <button className={`drawer-source ${active ? "active" : ""}`} key={source.id} onClick={() => {
                const first = citationEntries.find((citation) => citation.sourceId === source.id);
                if (first?.page) void showCitation(first.blockId, first.citationIndex);
              }}>
                <i className={citationCounts[source.id] ? "cited" : ""} />
                <span><strong>{source.name}</strong><small>{source.pageCount} {source.pageCount === 1 ? "page" : "pages"} · {source.status}{source.extractionIssueCount ? ` · ${source.extractionIssueCount} OCR ${source.extractionIssueCount === 1 ? "issue" : "issues"}` : ""}</small></span>
                {!!citationCounts[source.id] && <b>Cited ×{citationCounts[source.id]}</b>}
              </button>;
            })}</div>
            {selectedSource && <div className="source-detail">
              <div><span>{activeCitation?.number ? `Reference ${activeCitation.number}` : "Source review evidence"}</span><strong>{selectedSource.sourceName}</strong><small>Page {selectedSource.page}</small></div>
              {selectedSource.extractionStatus && selectedSource.extractionStatus !== "ready" && <div className="source-extraction-warning"><CircleAlert size={13} />{selectedSource.extractionStatus === "ocr-required" ? "This page needs OCR and was not treated as authoritative text." : selectedSource.extractionStatus === "ocr-failed" ? "OCR failed for this page; review the original visually." : "This page is visual evidence and is not treated as quoted text."}</div>}
              <p>{selectedSource.text || "This page contains visual evidence and requires direct review."}</p>
              <a href={`/api/sources/${selectedSource.sourceId}/file#page=${selectedSource.page}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open original at page {selectedSource.page}</a>
            </div>}
          </aside>
        </>}
      </div>
    </div>
  );
}
