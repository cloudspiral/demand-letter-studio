import { describe, expect, it } from "vitest";
import { ensureEditableCoverage, validateGrounding } from "./jobs";

const sourceId = "10000000-0000-4000-8000-000000000001";
const baseDraft = {
  title: "Demand",
  matterName: "Canary matter",
  fields: {},
  warnings: [],
  sections: [{
    id: "facts", heading: "DAMAGES", blocks: [{
      id: "block-1", kind: "paragraph" as const, text: "Jordan Canary incurred $12,345.67.",
      templateParagraphIndex: 4, verified: true,
      citations: [{ sourceId, sourceName: "canary.pdf", page: 1, quote: "Total Charges: $12,345.67" }],
    }],
  }],
};

describe("grounding validation", () => {
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

  it("clears every unfilled case-specific template region instead of leaking the old case", () => {
    const template = {
      filename: "old-case.docx", paragraphCount: 2, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
      replacementCandidates: [],
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
      filename: "header.docx", paragraphCount: 0, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [], regions: [],
      replacementCandidates: [{ value: "999999", location: "word/header1.xml", kind: "claim-number" as const }],
    };
    const result = ensureEditableCoverage({ ...baseDraft, sections: [] }, template);
    expect(result.fields["999999"]).toEqual({ value: "[ATTORNEY REVIEW REQUIRED]", verified: false, sourceLabel: null });
    expect(result.warnings[0]).toMatch(/header\/footer values were cleared/i);
  });
});
