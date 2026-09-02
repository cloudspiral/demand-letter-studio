import { describe, expect, it } from "vitest";
import type { GeneratedDraft, TemplateAnalysis } from "@steno/contracts";
import {
  deriveMatterName,
  ensureEditableCoverage,
  requireCurrentSourceFingerprint,
  requireWholeContextFits,
  validateGrounding,
} from "./jobs";
import { deriveGenerationTargets } from "./template-map";

const sourceId = "10000000-0000-4000-8000-000000000001";
const citation = {
  sourceId,
  sourceName: "canary.pdf",
  page: 1,
  quote: "Total Charges: $12,345.67",
  evidenceType: "text" as const,
  visualDescription: null,
};

const baseDraft: GeneratedDraft = {
  title: "Demand",
  fields: {},
  confirmedOmissionTargetIds: [],
  outcomes: [],
  sections: [{
    id: "facts",
    heading: "DAMAGES",
    blocks: [{
      id: "block-1",
      kind: "paragraph",
      text: "Naomi Carter incurred $12,345.67.",
      templateParagraphIndex: 4,
      templateBlockId: "word/document.xml:p:4",
      citations: [citation],
      attorneyEdited: false,
    }],
  }],
};

function analysis(regions: TemplateAnalysis["regions"], replacementCandidates: TemplateAnalysis["replacementCandidates"] = []): TemplateAnalysis {
  return {
    analysisVersion: 5,
    filename: "mapped.docx",
    paragraphCount: regions.length,
    sectionCount: 1,
    hasMacros: false,
    hasTrackedChanges: false,
    hasComplexObjects: false,
    warnings: [],
    regions,
    replacementCandidates,
    imageCandidates: [],
  };
}

describe("grounded generation validation", () => {
  it("rejects an oversize whole packet without silently dropping pages", () => {
    const previous = process.env.WHOLE_CONTEXT_MAX_CHARS;
    process.env.WHOLE_CONTEXT_MAX_CHARS = "20";
    try {
      expect(() => requireWholeContextFits(analysis([{
        paragraphIndex: 0,
        text: "complete template",
        role: "editable",
        semanticKind: "prose",
        section: null,
        aiRecommendation: "replace",
        confidence: 1,
        style: null,
        structuredGroup: null,
        figure: null,
      }]), [{ sourceId, sourceName: "packet.pdf", page: 1, text: "complete source page" }])).toThrow(/no pages were silently dropped/i);
    } finally {
      if (previous === undefined) delete process.env.WHOLE_CONTEXT_MAX_CHARS;
      else process.env.WHOLE_CONTEXT_MAX_CHARS = previous;
    }
  });

  it("rejects generation from a stale source fingerprint", () => {
    expect(() => requireCurrentSourceFingerprint("before", "after")).toThrow(/changed during generation/i);
    expect(() => requireCurrentSourceFingerprint("same", "same")).not.toThrow();
  });

  it("accepts exact source grounding and rejects missing or inexact citations", () => {
    const evidence = [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Total Charges: $12,345.67" }];
    expect(validateGrounding(baseDraft, evidence)).toEqual(baseDraft);
    expect(() => validateGrounding(baseDraft, [])).toThrow(/lacks valid source grounding/i);
    expect(() => validateGrounding(baseDraft, [{
      sourceId,
      sourceName: "canary.pdf",
      page: 1,
      text: "This page contains unrelated text.",
    }])).toThrow(/lacks valid source grounding/i);
  });

  it("retains one explicit omitted target without copying old-case text", () => {
    const mapped = analysis([
      { id: "word/document.xml:p:4", paragraphIndex: 4, text: "Old claimant incurred $3,500.", role: "editable", semanticKind: "prose", section: "Damages", aiRecommendation: "replace", confidence: 1, style: null, structuredGroup: null, figure: null },
      { id: "word/document.xml:p:5", paragraphIndex: 5, text: "Old treatment narrative.", role: "editable", semanticKind: "prose", section: "Damages", aiRecommendation: "replace", confidence: 1, style: null, structuredGroup: null, figure: null },
    ]);
    const target = deriveGenerationTargets(mapped)[0]!;
    const result = ensureEditableCoverage({
      ...baseDraft,
      sections: [],
      outcomes: [{
        id: `outcome:${target.id}`,
        targetId: target.id,
        targetKind: "narrative",
        status: "omitted",
        citations: [],
        note: "No records support this section.",
        sourceId: null,
        page: null,
        sourceName: null,
        mediaType: null,
        caption: null,
        exemplarCount: target.exemplarCount,
        generatedCount: 0,
      }],
    }, mapped);
    expect(result.sections.flatMap((section) => section.blocks)).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "omitted", note: "No records support this section." });
  });

  it("assembles editable Keep text and generated Replace blocks in fixed template order", () => {
    const mapped = analysis([
      {
        id: "word/document.xml:p:3",
        paragraphIndex: 3,
        text: "Claim Number: OLD-123",
        role: "preserve",
        semanticKind: "prose",
        section: null,
        aiRecommendation: "keep",
        confidence: 1,
        style: null,
        structuredGroup: null,
        figure: null,
        inlineFields: [{
          key: "claim_number",
          label: "Claim number",
          start: 14,
          end: 21,
          originalText: "OLD-123",
          kind: "claim-number",
          confidence: 1,
          explanation: "Previous case value.",
          source: "model",
          role: "replace",
        }],
      },
      { id: "word/document.xml:p:4", paragraphIndex: 4, text: "Old case narrative.", role: "editable", semanticKind: "prose", section: null, aiRecommendation: "replace", confidence: 1, style: null, structuredGroup: null, figure: null },
    ], [{
      value: "OLD-123",
      location: "word/document.xml",
      kind: "claim-number",
      fieldKey: "claim_number",
      label: "Claim number",
      blockId: "word/document.xml:p:3",
      start: 14,
      end: 21,
    }]);
    const target = deriveGenerationTargets(mapped)[0]!;
    const result = ensureEditableCoverage({
      ...baseDraft,
      outcomes: [{
        id: `outcome:${target.id}`,
        targetId: target.id,
        targetKind: "narrative",
        status: "generated",
        citations: [citation],
        note: null,
        sourceId: null,
        page: null,
        sourceName: null,
        mediaType: null,
        caption: null,
        exemplarCount: 1,
        generatedCount: 1,
      }],
      sections: [{ ...baseDraft.sections[0]!, blocks: [{
        ...baseDraft.sections[0]!.blocks[0]!,
        targetId: target.id,
        outcomeId: `outcome:${target.id}`,
        sequence: 0,
      }] }],
      fields: {
        claim_number: {
          fieldKey: "claim_number",
          oldValue: "OLD-123",
          value: "NEW-456",
          label: "Claim number",
          citations: [citation],
          note: null,
          attorneyEdited: false,
        },
      },
    }, mapped);
    expect(result.sections[0]?.blocks[0]).toMatchObject({
      text: "Claim Number: NEW-456",
      templateParagraphIndex: 3,
      attorneyEdited: false,
    });
    expect(result.sections[0]?.blocks[1]).toMatchObject({
      templateParagraphIndex: 4,
      targetId: target.id,
    });
  });

  it("rejects a missing inline-field outcome", () => {
    const mapped = analysis([], [{ value: "OLD-123", location: "word/header1.xml", kind: "claim-number", fieldKey: "claim_number" }]);
    expect(() => ensureEditableCoverage({ ...baseDraft, sections: [] }, mapped)).toThrow(/inline field outcome/i);
  });

  it("derives a grounded matter name and falls back deterministically", () => {
    const mapped = analysis([], [
      { value: "OLD CLIENT", location: "word/document.xml", kind: "person", fieldKey: "client_name", label: "Client name" },
      { value: "OLD-123", location: "word/document.xml", kind: "claim-number", fieldKey: "claim_number", label: "Claim number" },
    ]);
    const named: GeneratedDraft = {
      ...baseDraft,
      fields: {
        client_name: { fieldKey: "client_name", oldValue: "OLD CLIENT", value: "Naomi Carter", label: "Client name", citations: [citation], note: null, attorneyEdited: false },
        claim_number: { fieldKey: "claim_number", oldValue: "OLD-123", value: "PPC-2026-0417", label: "Claim number", citations: [citation], note: null, attorneyEdited: false },
      },
    };
    expect(deriveMatterName(named, mapped)).toBe("Naomi Carter - PPC-2026-0417");
    expect(deriveMatterName({ ...baseDraft, fields: {} }, mapped)).toBe("New matter");
  });
});
