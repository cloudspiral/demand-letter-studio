import { describe, expect, it } from "vitest";
import { GeneratedDraftSchema, RefinementProposalSchema } from "./index";

describe("contracts", () => {
  it("rejects factual blocks without verification state", () => {
    const result = GeneratedDraftSchema.safeParse({
      title: "Demand",
      matterName: "Example",
      fields: {},
      sections: [{ id: "facts", heading: "Facts", blocks: [{ id: "p1", kind: "paragraph", text: "Fact", templateParagraphIndex: 2, citations: [] }] }],
      warnings: [],
    });
    expect(result.success).toBe(false);
  });

  it("requires refinement proposals to identify their target", () => {
    expect(RefinementProposalSchema.safeParse({ replacementText: "New", summary: "Changed", citedSourceIds: [] }).success).toBe(false);
  });
});
