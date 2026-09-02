import { describe, expect, it } from "vitest";
import { EvidenceReviewSchema, ExportReadinessSchema, GeneratedDraftSchema, GenerationOutcomeSchema, RefinementAnnotationSchema, RefinementProposalSchema, ReviewFlagSchema } from "./index";

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
  });

  it("normalizes legacy stored fields and bounds exact annotations", () => {
    const parsed = GeneratedDraftSchema.parse({
      title: "Demand",
      matterName: "Example",
      fields: { claim: { value: "123", verified: true } },
      sections: [],
      warnings: [],
    });
    expect(parsed.fields.claim).toMatchObject({
      confidence: null, userConfirmed: false, sourceId: null, page: null, sourceLabel: null,
    });
    expect(parsed.reviewFlags).toEqual([]);
    expect(RefinementAnnotationSchema.safeParse({ blockId: "one", quote: "exact", start: 2, end: 2 }).success).toBe(false);
  });

  it("keeps source-review flags generic and validates review/readiness transport", () => {
    const flag = ReviewFlagSchema.parse({
      id: "source-review-1",
      summary: "Needs source review",
      explanation: "Two uploaded pages contain dates that should be reviewed together.",
      citations: [],
      affectedTemplateParagraphIndexes: [4],
      affectedFieldKeys: [],
    });
    expect(flag).not.toHaveProperty("type");
    expect(flag).toMatchObject({ kind: "general", severity: "verification", affectedTargetIds: [] });
    expect(EvidenceReviewSchema.safeParse({
      sourceFingerprint: "a".repeat(64), reviewFlags: [flag], createdAt: new Date().toISOString(),
    }).success).toBe(true);
    expect(ExportReadinessSchema.parse({
      ready: false, blockIds: ["block-1"], fieldKeys: [], duplicateParagraphIndexes: [],
      imageIssue: null, staleEvidence: false, blockingReviewFlagIds: [flag.id],
    })).toMatchObject({
      outcomeIds: [], staleResolutionTargetIds: [], blockingReviewFlagIds: [flag.id],
    });
  });

  it("keeps omission outcome and approval state independent", () => {
    const base = {
      id: "outcome:target-1", targetId: "target-1", targetKind: "narrative" as const,
      citations: [], note: null, sourceId: null, page: null, sourceName: null,
      mediaType: null, caption: null, exemplarCount: 2, generatedCount: 0,
    };
    expect(GenerationOutcomeSchema.parse({
      ...base, status: "omitted_no_evidence", resolution: "unresolved",
    })).toMatchObject({ status: "omitted_no_evidence", resolution: "unresolved" });
    expect(GenerationOutcomeSchema.safeParse({
      ...base, status: "omitted_no_evidence", resolution: "not_required",
    }).success).toBe(false);
    expect(GenerationOutcomeSchema.safeParse({
      ...base, status: "omitted_not_applicable", resolution: "not_required",
    }).success).toBe(false);
  });
});
