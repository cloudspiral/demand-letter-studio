import { randomUUID } from "node:crypto";
import { CitationSchema, GeneratedDraftSchema, type Citation, type GeneratedDraft } from "@steno/contracts";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function citations(value: unknown): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = CitationSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function legacyFieldCitation(field: JsonObject): Citation[] {
  const existing = citations(field.citations);
  if (existing.length) return existing;
  if (typeof field.sourceId !== "string" || typeof field.page !== "number" || typeof field.quote !== "string" || !field.quote.trim()) return [];
  const label = typeof field.sourceLabel === "string" ? field.sourceLabel : "Historical source";
  return [CitationSchema.parse({
    sourceId: field.sourceId,
    sourceName: label.replace(/\s+p\.\s*\d+$/i, ""),
    page: field.page,
    quote: field.quote,
    evidenceType: "text",
    visualDescription: null,
  })];
}

/** Convert an active historical snapshot to the current runtime shape without rewriting history. */
export function normalizeDraftContent(raw: unknown, historicalConfirmedTargetIds: string[] = []): GeneratedDraft {
  const input = object(raw);
  const sections = Array.isArray(input.sections) ? input.sections.map((sectionValue) => {
    const section = object(sectionValue);
    const blocks = Array.isArray(section.blocks) ? section.blocks.map((blockValue) => {
      const block = object(blockValue);
      return {
        id: String(block.id ?? randomUUID()),
        kind: block.kind === "warning" ? "paragraph" : block.kind,
        text: String(block.text ?? ""),
        templateParagraphIndex: typeof block.templateParagraphIndex === "number" ? block.templateParagraphIndex : null,
        templateBlockId: typeof block.templateBlockId === "string" ? block.templateBlockId : null,
        citations: citations(block.citations),
        attorneyEdited: Boolean(block.attorneyEdited || block.userConfirmed || block.verified === false),
        targetId: typeof block.targetId === "string" ? block.targetId : null,
        outcomeId: typeof block.outcomeId === "string" ? block.outcomeId : null,
        ...(typeof block.sequence === "number" ? { sequence: block.sequence } : {}),
        ...(Array.isArray(block.structuredCells) ? { structuredCells: block.structuredCells.map(String) } : {}),
        ...(block.structuredRowRole === "body" || block.structuredRowRole === "total" ? { structuredRowRole: block.structuredRowRole } : {}),
      };
    }) : [];
    return { id: String(section.id ?? randomUUID()), heading: typeof section.heading === "string" ? section.heading : null, blocks };
  }) : [];

  const blockCitations = new Map<string, Citation[]>();
  for (const block of sections.flatMap((section) => section.blocks)) {
    if (block.targetId) blockCitations.set(block.targetId, [...(blockCitations.get(block.targetId) ?? []), ...block.citations]);
  }
  const hasVersionedConfirmations = Array.isArray(input.confirmedOmissionTargetIds);
  const legacyConfirmed = new Set(hasVersionedConfirmations ? [] : historicalConfirmedTargetIds);
  const outcomes = Array.isArray(input.outcomes) ? input.outcomes.map((outcomeValue) => {
    const outcome = object(outcomeValue);
    const targetId = String(outcome.targetId ?? "");
    const status = outcome.status === "generated"
      ? "generated" as const
      : outcome.status === "attorney-supplied"
        ? "attorney-supplied" as const
        : "omitted" as const;
    if (outcome.status === "omitted_no_evidence" && (outcome.resolution === "confirmed" || outcome.resolution === "preapproved")) {
      legacyConfirmed.add(targetId);
    }
    const grounded = citations(outcome.citations);
    return {
      id: String(outcome.id ?? `outcome:${targetId}`),
      targetId,
      targetKind: outcome.targetKind,
      status,
      citations: status === "generated" && !grounded.length ? blockCitations.get(targetId) ?? [] : grounded,
      note: status === "omitted" ? typeof outcome.note === "string" && outcome.note.trim() ? outcome.note : "The prior draft did not include evidence-backed content for this target." : null,
      sourceId: typeof outcome.sourceId === "string" ? outcome.sourceId : null,
      page: typeof outcome.page === "number" ? outcome.page : null,
      sourceName: typeof outcome.sourceName === "string" ? outcome.sourceName : null,
      mediaType: typeof outcome.mediaType === "string" ? outcome.mediaType : null,
      caption: typeof outcome.caption === "string" ? outcome.caption : null,
      exemplarCount: typeof outcome.exemplarCount === "number" ? outcome.exemplarCount : 0,
      generatedCount: typeof outcome.generatedCount === "number" ? outcome.generatedCount : 0,
    };
  }) : [];

  const fields = Object.fromEntries(Object.entries(object(input.fields)).map(([fieldKey, fieldValue]) => {
    const field = object(fieldValue);
    const value = typeof field.value === "string" && !/ATTORNEY REVIEW REQUIRED/i.test(field.value) ? field.value : null;
    const grounded = legacyFieldCitation(field);
    return [fieldKey, {
      fieldKey,
      oldValue: typeof field.oldValue === "string" ? field.oldValue : typeof field.templateValue === "string" ? field.templateValue : "",
      value,
      label: typeof field.label === "string" ? field.label : fieldKey,
      citations: grounded,
      note: value === null ? typeof field.note === "string" && field.note.trim() ? field.note : "No grounded replacement value was available in the prior draft." : null,
      attorneyEdited: Boolean(field.attorneyEdited || field.userConfirmed || (value !== null && !grounded.length)),
    }];
  }));
  const currentConfirmed = Array.isArray(input.confirmedOmissionTargetIds)
    ? input.confirmedOmissionTargetIds.filter((value): value is string => typeof value === "string")
    : [];
  const omittedTargetIds = new Set(outcomes.filter((outcome) => outcome.status === "omitted").map((outcome) => outcome.targetId));

  return GeneratedDraftSchema.parse({
    title: typeof input.title === "string" ? input.title : "Attorney-review draft",
    fields,
    sections,
    outcomes,
    confirmedOmissionTargetIds: [...new Set([...currentConfirmed, ...legacyConfirmed])].filter((targetId) => omittedTargetIds.has(targetId)),
  });
}
