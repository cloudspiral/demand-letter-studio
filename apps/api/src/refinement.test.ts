import { describe, expect, it } from "vitest";
import { RefinementProposalSchema, type GeneratedDraft } from "@steno/contracts";
import { applyDirectDraftEdits, applyRefinementProposal, confirmDraftBlock, validateProposalTargets } from "./refinement";

const content: GeneratedDraft = {
  title: "Demand", matterName: "Canary", fields: {}, warnings: [], reviewFlags: [],
  sections: [{ id: "facts", heading: null, blocks: [
    { id: "one", kind: "paragraph", text: "This is very clear.", templateParagraphIndex: 1, citations: [], verified: true },
    { id: "two", kind: "paragraph", text: "This is very concise.", templateParagraphIndex: 2, citations: [], verified: true },
  ] }],
};

describe("atomic refinement proposals", () => {
  it("applies multiple exact ranges in one immutable draft update", () => {
    const proposal = RefinementProposalSchema.parse({
      edits: [
        { blockId: "one", targetText: "very ", replacementText: "", start: 8, end: 13 },
        { blockId: "two", targetText: "very ", replacementText: "", start: 8, end: 13 },
      ],
      summary: "Tightened", citedSourceIds: [],
    });
    validateProposalTargets(proposal, [
      { blockId: "one", quote: "very ", start: 8, end: 13 },
      { blockId: "two", quote: "very ", start: 8, end: 13 },
    ]);
    const result = applyRefinementProposal(content, proposal);
    expect(result.sections[0]?.blocks.map((block) => block.text)).toEqual(["This is clear.", "This is concise."]);
    expect(result.sections[0]?.blocks[0]).toMatchObject({ verified: false, userConfirmed: false });
    expect(content.sections[0]?.blocks[0]?.text).toBe("This is very clear.");
  });

  it("rejects a proposal whose range no longer matches", () => {
    const proposal = RefinementProposalSchema.parse({
      edits: [{ blockId: "one", targetText: "wrong", replacementText: "new", start: 8, end: 13 }],
      summary: "Invalid", citedSourceIds: [],
    });
    expect(() => applyRefinementProposal(content, proposal)).toThrow(/no longer matches/i);
  });

  it("keeps a direct edit unresolved until explicit attorney confirmation", () => {
    const candidate: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: content.sections[0]!.blocks.map((block) => (
        block.id === "one" ? { ...block, text: "Attorney-edited text.", verified: true } : block
      )) }],
    };
    const result = applyDirectDraftEdits(content, candidate);
    expect(result.sections[0]?.blocks[0]).toMatchObject({
      text: "Attorney-edited text.",
      verified: false,
      userConfirmed: false,
    });
  });

  it("rejects structural changes submitted through the direct edit endpoint", () => {
    expect(() => applyDirectDraftEdits(content, { ...content, sections: [] })).toThrow(/template structure/i);
  });

  it("never resolves a warning merely because its text was edited", () => {
    const warning: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [{
        ...content.sections[0]!.blocks[0]!, kind: "warning", verified: false,
      }] }],
    };
    const candidate = {
      ...warning,
      sections: [{ ...warning.sections[0]!, blocks: [{ ...warning.sections[0]!.blocks[0]!, text: "Attorney supplied replacement." }] }],
    };
    expect(applyDirectDraftEdits(warning, candidate).sections[0]?.blocks[0]).toMatchObject({
      kind: "warning", verified: false, userConfirmed: false,
    });
    expect(confirmDraftBlock(warning, "one", "Attorney reviewed replacement.").sections[0]?.blocks[0]).toMatchObject({
      kind: "paragraph", text: "Attorney reviewed replacement.", verified: false, userConfirmed: true,
    });
    expect(() => confirmDraftBlock(warning, "missing", "Reviewed.")).toThrow(/not found/i);
  });
});
