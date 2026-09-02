import { describe, expect, it } from "vitest";
import { ExportReadinessSchema, GeneratedDraftSchema, GenerationOutcomeSchema, RefinementAnnotationSchema, RefinementProposalSchema } from "./index";

const citation = {
  sourceId: "00000000-0000-4000-8000-000000000999",
  sourceName: "record.pdf",
  page: 1,
  quote: "No future care is recommended.",
  evidenceType: "text" as const,
  visualDescription: null,
};

describe("contracts", () => {
  it("accepts editable fixed-structure blocks and defaults attorney-edit state", () => {
    const parsed = GeneratedDraftSchema.parse({
      title: "Demand",
      fields: {},
      sections: [{ id: "facts", heading: "Facts", blocks: [{ id: "p1", kind: "paragraph", text: "Reusable text", templateParagraphIndex: 2, citations: [] }] }],
      outcomes: [],
    });
    expect(parsed.sections[0]?.blocks[0]?.attorneyEdited).toBe(false);
    expect(parsed.confirmedOmissionTargetIds).toEqual([]);
  });

  it("normalizes legacy proposals and validates bounded multi-edit proposals", () => {
    const legacy = RefinementProposalSchema.parse({
      targetText: "Old text", replacementText: "New text", summary: "Tightened", citedSourceIds: [],
    });
    expect(legacy.edits[0]?.targetText).toBe("Old text");
    const proposal = RefinementProposalSchema.parse({
      edits: [
        { blockId: "one", targetText: "first", replacementText: "1st", start: 0, end: 5 },
        { blockId: "two", targetText: "second", replacementText: "2nd", start: 4, end: 10 },
      ],
      summary: "Two bounded edits", citedSourceIds: [],
    });
    expect(proposal.edits).toHaveLength(2);
    expect(RefinementAnnotationSchema.safeParse({ blockId: "one", quote: "exact", start: 2, end: 2 }).success).toBe(false);
  });

  it("uses generated, omitted, and attorney-supplied target outcomes with conditional notes and citations", () => {
    const base = {
      id: "outcome:target-1", targetId: "target-1", targetKind: "narrative" as const,
      sourceId: null, page: null, sourceName: null, mediaType: null, caption: null, exemplarCount: 2, generatedCount: 1,
    };
    expect(GenerationOutcomeSchema.parse({ ...base, status: "generated", citations: [citation], note: null })).toMatchObject({ status: "generated" });
    expect(GenerationOutcomeSchema.parse({ ...base, status: "omitted", citations: [], note: "The packet contains no support." })).toMatchObject({ status: "omitted" });
    expect(GenerationOutcomeSchema.parse({ ...base, status: "attorney-supplied", citations: [], note: null })).toMatchObject({ status: "attorney-supplied" });
    expect(GenerationOutcomeSchema.safeParse({ ...base, status: "omitted", citations: [], note: null }).success).toBe(false);
    expect(GenerationOutcomeSchema.safeParse({ ...base, status: "omitted_no_evidence", citations: [], note: "Missing" }).success).toBe(false);
  });

  it("uses nullable field values without a field status enum", () => {
    const generated = GeneratedDraftSchema.parse({
      title: "Demand", sections: [], outcomes: [],
      fields: { claim: { fieldKey: "claim", oldValue: "OLD", value: "NEW", citations: [citation], note: null } },
    });
    expect(generated.fields.claim?.value).toBe("NEW");
    expect(GeneratedDraftSchema.safeParse({
      title: "Demand", sections: [], outcomes: [],
      fields: { claim: { fieldKey: "claim", oldValue: "OLD", value: null, citations: [], note: null } },
    }).success).toBe(false);
  });

  it("exposes only concrete server-derived readiness blockers", () => {
    expect(ExportReadinessSchema.parse({
      ready: false, fieldKeys: ["claim"], omittedTargetIds: ["target-1"], duplicateParagraphIndexes: [],
      imageIssue: null, staleEvidence: false,
    })).toEqual({
      ready: false, fieldKeys: ["claim"], omittedTargetIds: ["target-1"], duplicateParagraphIndexes: [],
      imageIssue: null, staleEvidence: false,
    });
  });
});
