import { describe, expect, it } from "vitest";
import { RefinementProposalSchema, type GeneratedDraft } from "@steno/contracts";
import { applyDirectDraftEdits, applyRefinementProposal, validateProposalTargets } from "./refinement";

const content: GeneratedDraft = {
  title: "Demand",
  fields: {},
  outcomes: [],
  confirmedOmissionTargetIds: [],
  sections: [{ id: "facts", heading: null, blocks: [
    { id: "one", kind: "heading", text: "DAMAGES", templateParagraphIndex: 1, templateBlockId: "word/document.xml:p:1", citations: [], attorneyEdited: false },
    { id: "two", kind: "paragraph", text: "This is very concise.", templateParagraphIndex: 2, templateBlockId: "word/document.xml:p:2", citations: [], attorneyEdited: false },
  ] }],
};

describe("attorney-controlled editing", () => {
  it("applies exact AI ranges to Keep or generated text and treats acceptance as approval", () => {
    const proposal = RefinementProposalSchema.parse({
      edits: [
        { blockId: "one", targetText: "DAMAGES", replacementText: "INJURIES AND DAMAGES", start: 0, end: 7 },
        { blockId: "two", targetText: "very ", replacementText: "", start: 8, end: 13 },
      ],
      summary: "Tightened the selected text",
      citedSourceIds: [],
    });
    validateProposalTargets(proposal, [
      { blockId: "one", quote: "DAMAGES", start: 0, end: 7 },
      { blockId: "two", quote: "very ", start: 8, end: 13 },
    ]);
    const result = applyRefinementProposal(content, proposal);
    expect(result.sections[0]?.blocks).toMatchObject([
      { text: "INJURIES AND DAMAGES", attorneyEdited: true },
      { text: "This is concise.", attorneyEdited: true },
    ]);
    expect(content.sections[0]?.blocks[0]?.text).toBe("DAMAGES");
  });

  it("rejects an AI proposal whose range no longer matches", () => {
    const proposal = RefinementProposalSchema.parse({
      edits: [{ blockId: "two", targetText: "wrong", replacementText: "new", start: 8, end: 13 }],
      summary: "Invalid",
      citedSourceIds: [],
    });
    expect(() => applyRefinementProposal(content, proposal)).toThrow(/no longer matches/i);
  });

  it("saves direct edits to all existing text without a second confirmation", () => {
    const candidate: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: content.sections[0]!.blocks.map((block) => (
        block.id === "one" ? { ...block, text: "ATTORNEY-EDITED HEADING" } : block
      )) }],
    };
    expect(applyDirectDraftEdits(content, candidate).sections[0]?.blocks[0]).toMatchObject({
      text: "ATTORNEY-EDITED HEADING",
      attorneyEdited: true,
    });
  });

  it("rejects insertion, deletion, and reordering through direct edits", () => {
    expect(() => applyDirectDraftEdits(content, { ...content, sections: [] })).toThrow(/template structure/i);
    expect(() => applyDirectDraftEdits(content, {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [...content.sections[0]!.blocks].reverse() }],
    })).toThrow(/template structure/i);
    expect(() => applyDirectDraftEdits(content, {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [
        ...content.sections[0]!.blocks,
        { ...content.sections[0]!.blocks[1]!, id: "three" },
      ] }],
    })).toThrow(/template structure/i);
  });

  it("keeps structured row cells synchronized with attorney edits", () => {
    const structured: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [{
        ...content.sections[0]!.blocks[1]!,
        id: "row",
        kind: "table-row",
        text: "Hospital · $10.00",
        structuredCells: ["Hospital", "$10.00"],
        structuredRowRole: "body",
      }] }],
    };
    const candidate: GeneratedDraft = {
      ...structured,
      sections: [{ ...structured.sections[0]!, blocks: [{ ...structured.sections[0]!.blocks[0]!, text: "Clinic · $20.00" }] }],
    };
    expect(applyDirectDraftEdits(structured, candidate).sections[0]?.blocks[0]).toMatchObject({
      text: "Clinic · $20.00",
      structuredCells: ["Clinic", "$20.00"],
      attorneyEdited: true,
    });
    candidate.sections[0]!.blocks[0]!.text = "Malformed row";
    expect(() => applyDirectDraftEdits(structured, candidate)).toThrow(/preserve 2 cells/i);
  });
});
