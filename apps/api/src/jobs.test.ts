import { describe, expect, it } from "vitest";
import { validateGrounding } from "./jobs";

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
    expect(result.warnings[0]).toMatch(/requires attorney review/i);
  });
});
