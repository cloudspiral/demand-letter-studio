import { describe, expect, it } from "vitest";
import { ensureEditableCoverage, requireCurrentSourceFingerprint, requireWholeContextFits, validateGrounding } from "./jobs";
import { deriveGenerationTargets } from "./template-map";

const sourceId = "10000000-0000-4000-8000-000000000001";
const baseDraft = {
  title: "Demand",
  matterName: "Canary matter",
  fields: {},
  warnings: [],
  reviewFlags: [],
  outcomes: [],
  sections: [{
    id: "facts", heading: "DAMAGES", blocks: [{
      id: "block-1", kind: "paragraph" as const, text: "Jordan Canary incurred $12,345.67.",
      templateParagraphIndex: 4, templateBlockId: "word/document.xml:p:4", verified: true,
      citations: [{ sourceId, sourceName: "canary.pdf", page: 1, quote: "Total Charges: $12,345.67" }],
    }],
  }],
};

describe("grounding validation", () => {
  it("rejects an oversize whole packet without silently dropping pages", () => {
    const previous = process.env.WHOLE_CONTEXT_MAX_CHARS;
    process.env.WHOLE_CONTEXT_MAX_CHARS = "20";
    try {
      expect(() => requireWholeContextFits({
        analysisVersion: 4, filename: "whole.docx", paragraphCount: 1, sectionCount: 1,
        hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
        regions: [{
          paragraphIndex: 0, text: "complete template", role: "editable", semanticKind: "prose", section: null,
          aiRecommendation: "replace", confidence: 1, style: null, structuredGroup: null, figure: null,
        }],
        replacementCandidates: [], imageCandidates: [],
      }, [{ sourceId, sourceName: "packet.pdf", page: 1, text: "complete source page" }])).toThrow(/no pages were silently dropped/i);
    } finally {
      if (previous === undefined) delete process.env.WHOLE_CONTEXT_MAX_CHARS;
      else process.env.WHOLE_CONTEXT_MAX_CHARS = previous;
    }
  });

  it("rejects evidence-review and generation results from a stale source fingerprint", () => {
    expect(() => requireCurrentSourceFingerprint("before", "after", "evidence review")).toThrow(/changed during evidence review/i);
    expect(() => requireCurrentSourceFingerprint("before", "after", "generation")).toThrow(/changed during generation/i);
    expect(() => requireCurrentSourceFingerprint("same", "same", "generation")).not.toThrow();
  });

  it("retains citations that resolve to an uploaded source page", () => {
    const result = validateGrounding(baseDraft, [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Total Charges: $12,345.67" }]);
    expect(result.sections[0]?.blocks[0]?.verified).toBe(true);
    expect(result.sections[0]?.blocks[0]?.kind).toBe("paragraph");
  });

  it("visibly marks blocks unsupported when a citation does not resolve", () => {
    const result = validateGrounding(baseDraft, []);
    expect(result.sections[0]?.blocks[0]?.verified).toBe(false);
    expect(result.sections[0]?.blocks[0]?.kind).toBe("warning");
    expect(result.sections[0]?.blocks[0]?.text).toMatch(/attorney review required/i);
    expect(result.sections[0]?.blocks[0]?.text).not.toContain("Jordan Canary");
    expect(result.warnings[0]).toMatch(/requires attorney review/i);
  });

  it("rejects a citation whose quote is not actually present on the cited page", () => {
    const result = validateGrounding(baseDraft, [{
      sourceId,
      sourceName: "canary.pdf",
      page: 1,
      text: "This page contains unrelated text.",
    }]);
    expect(result.sections[0]?.blocks[0]).toMatchObject({ kind: "warning", verified: false });
    expect(result.sections[0]?.blocks[0]?.citations).toEqual([]);
  });

  it("represents an unfilled case-specific run as an explicit omission instead of leaking the old case", () => {
    const template = {
      analysisVersion: 2,
      filename: "old-case.docx", paragraphCount: 2, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
      replacementCandidates: [],
      imageCandidates: [],
      regions: [
        { id: "word/document.xml:p:4", paragraphIndex: 4, text: "Jordan Canary incurred $12,345.67.", role: "editable" as const, semanticKind: "prose" as const, section: null, aiRecommendation: "replace" as const, confidence: 1, style: null, structuredGroup: null, figure: null },
        { id: "word/document.xml:p:5", paragraphIndex: 5, text: "Old claimant narrative that must not survive.", role: "editable" as const, semanticKind: "prose" as const, section: null, aiRecommendation: "replace" as const, confidence: 1, style: null, structuredGroup: null, figure: null },
      ],
    };
    const target = deriveGenerationTargets(template)[0]!;
    const result = ensureEditableCoverage({
      ...baseDraft,
      sections: [],
      outcomes: [{
        id: `outcome:${target.id}`, targetId: target.id, targetKind: "narrative",
        status: "omitted_no_evidence", resolution: "unresolved", citations: [], note: "No support.",
        sourceId: null, page: null, sourceName: null, mediaType: null, caption: null,
        exemplarCount: target.exemplarCount, generatedCount: 0,
      }],
    }, template);
    expect(result.sections.flatMap((section) => section.blocks)).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({ status: "omitted_no_evidence", resolution: "unresolved" });
  });

  it("deterministically assembles locked Keep text around generated Replace blocks", () => {
    const template = {
      analysisVersion: 4,
      filename: "mapped.docx", paragraphCount: 2, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
      replacementCandidates: [{
        value: "OLD-123", location: "word/document.xml", kind: "claim-number" as const,
        fieldKey: "claim_number", label: "Claim number", blockId: "word/document.xml:p:3", start: 14, end: 21,
      }], imageCandidates: [],
      regions: [
        {
          id: "word/document.xml:p:3", paragraphIndex: 3, text: "Claim Number: OLD-123", role: "preserve" as const, semanticKind: "prose" as const, section: null, aiRecommendation: "keep" as const, confidence: 1, style: null, structuredGroup: null, figure: null,
          inlineFields: [{
            key: "claim_number", label: "Claim number", start: 14, end: 21, originalText: "OLD-123",
            kind: "claim-number" as const, confidence: 1, explanation: "Previous case value.", source: "model" as const, role: "replace" as const,
          }],
        },
        { id: "word/document.xml:p:4", paragraphIndex: 4, text: "Old case narrative.", role: "editable" as const, semanticKind: "prose" as const, section: null, aiRecommendation: "replace" as const, confidence: 1, style: null, structuredGroup: null, figure: null },
      ],
    };
    const target = deriveGenerationTargets(template)[0]!;
    const result = ensureEditableCoverage({
      ...baseDraft,
      outcomes: [{
        id: `outcome:${target.id}`, targetId: target.id, targetKind: "narrative",
        status: "generated", resolution: "not_required", citations: baseDraft.sections[0]!.blocks[0]!.citations,
        note: null, sourceId: null, page: null, sourceName: null, mediaType: null, caption: null,
        exemplarCount: 1, generatedCount: 1,
      }],
      sections: [{ ...baseDraft.sections[0]!, blocks: [{
        ...baseDraft.sections[0]!.blocks[0]!, targetId: target.id, outcomeId: `outcome:${target.id}`, sequence: 0,
      }] }],
      fields: {
        claim_number: {
          value: "NEW-456", label: "Claim number", templateValue: "OLD-123", verified: true,
          confidence: 1, userConfirmed: false, sourceId, page: 1, sourceLabel: "canary.pdf p. 1", quote: "NEW-456",
        },
      },
    }, template);
    expect(result.sections[0]?.blocks[0]).toMatchObject({
      text: "Claim Number: NEW-456",
      templateParagraphIndex: 3,
      templateRole: "keep",
      locked: true,
    });
    expect(result.sections[0]?.blocks[1]).toMatchObject({ templateParagraphIndex: 4, templateRole: "replace", locked: false });
  });

  it("clears unsupported header values while leaving the package structure to the worker", () => {
    const template = {
      analysisVersion: 2,
      filename: "header.docx", paragraphCount: 0, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [], regions: [],
      replacementCandidates: [{ value: "999999", location: "word/header1.xml", kind: "claim-number" as const }],
      imageCandidates: [],
    };
    const result = ensureEditableCoverage({ ...baseDraft, sections: [] }, template);
    expect(result.fields["999999"]).toMatchObject({
      value: "[ATTORNEY REVIEW REQUIRED]", verified: false, userConfirmed: false, sourceLabel: null,
    });
    expect(result.warnings[0]).toMatch(/header\/footer values were cleared/i);
  });
});
