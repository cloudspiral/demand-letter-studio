import { describe, expect, it } from "vitest";
import { ensureEditableCoverage, requireCurrentSourceFingerprint, validateGrounding } from "./jobs";

const sourceId = "10000000-0000-4000-8000-000000000001";
const baseDraft = {
  title: "Demand",
  matterName: "Canary matter",
  fields: {},
  warnings: [],
  reviewFlags: [],
  sections: [{
    id: "facts", heading: "DAMAGES", blocks: [{
      id: "block-1", kind: "paragraph" as const, text: "Jordan Canary incurred $12,345.67.",
      templateParagraphIndex: 4, verified: true,
      citations: [{ sourceId, sourceName: "canary.pdf", page: 1, quote: "Total Charges: $12,345.67" }],
    }],
  }],
};

describe("grounding validation", () => {
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

  it("clears every unfilled case-specific template region instead of leaking the old case", () => {
    const template = {
      analysisVersion: 2,
      filename: "old-case.docx", paragraphCount: 2, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
      replacementCandidates: [],
      imageCandidates: [],
      regions: [
        { paragraphIndex: 4, text: "Jordan Canary incurred $12,345.67.", role: "editable" as const, confidence: 1, style: null },
        { paragraphIndex: 5, text: "Old claimant narrative that must not survive.", role: "editable" as const, confidence: 1, style: null },
      ],
    };
    const result = ensureEditableCoverage(baseDraft, template);
    const cleared = result.sections.flatMap((section) => section.blocks).find((block) => block.templateParagraphIndex === 5);
    expect(cleared?.kind).toBe("warning");
    expect(cleared?.text).not.toContain("Old claimant");
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
