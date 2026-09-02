import { describe, expect, it } from "vitest";
import { createAiProvider, evidenceReviewJsonSchema, parseEvidenceReview, parseModelDraft } from "./ai";

const sourceId = "10000000-0000-4000-8000-000000000001";

describe("AI provider adapter", () => {
  it("keeps provider review constraints aligned with the runtime ReviewFlag contract", () => {
    const item = evidenceReviewJsonSchema.properties.reviewFlags.items as {
      properties: Record<string, { minLength?: number; maxLength?: number; maxItems?: number }>;
    };
    expect(evidenceReviewJsonSchema.properties.reviewFlags.maxItems).toBe(100);
    expect(item.properties.id).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(item.properties.summary).toMatchObject({ minLength: 1, maxLength: 240 });
    expect(item.properties.explanation).toMatchObject({ minLength: 1, maxLength: 2_000 });
    expect(item.properties.citations).toMatchObject({ maxItems: 12 });
    expect(item.properties.affectedTemplateParagraphIndexes).toMatchObject({ maxItems: 100 });
    expect(item.properties.affectedFieldKeys).toMatchObject({ maxItems: 100 });
  });

  it("configures the Bedrock adapter without static credentials", () => {
    const provider = createAiProvider("bedrock");
    expect(provider.name).toBe("bedrock");
    expect(provider.model).toMatch(/anthropic\.claude/);
  });

  it("returns schema-valid deterministic drafts through the same adapter", async () => {
    const provider = createAiProvider("mock");
    const draft = await provider.generate({
      matterName: "Jordan Canary matter",
      template: {
        analysisVersion: 2,
        filename: "canary.docx", paragraphCount: 1, sectionCount: 1,
        hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
        replacementCandidates: [],
        imageCandidates: [],
        regions: [{ paragraphIndex: 0, text: "Old case narrative", role: "editable", confidence: 1, style: null }],
      },
      evidence: [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Patient: Jordan Canary\nTotal Charges: $12,345.67" }],
    });
    expect(provider.name).toBe("mock");
    expect(draft.matterName).toBe("Jordan Canary matter");
    expect(draft.sections[0]?.blocks[0]?.citations[0]?.sourceId).toBe(sourceId);
    expect((await provider.review({
      matterName: "Jordan Canary matter",
      template: {
        analysisVersion: 2,
        filename: "canary.docx", paragraphCount: 1, sectionCount: 1,
        hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
        replacementCandidates: [], imageCandidates: [],
        regions: [{ paragraphIndex: 0, text: "Old case narrative", role: "editable", confidence: 1, style: null }],
      },
      evidence: [],
    })).length).toBeGreaterThan(0);
  });

  it("drops unsupported review citations and normalizes uncited flags as missing support", () => {
    const template = {
      analysisVersion: 2,
      filename: "canary.docx", paragraphCount: 1, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
      replacementCandidates: [], imageCandidates: [],
      regions: [{ paragraphIndex: 4, text: "Case-specific treatment", role: "editable" as const, confidence: 1, style: null }],
    };
    const evidence = [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Service date: January 4, 2026" }];
    const review = parseEvidenceReview({ reviewFlags: [{
      id: "model-id",
      summary: "Unsupported conflict claim",
      explanation: "The dates conflict.",
      citations: [{ sourceId, sourceName: "wrong.pdf", page: 1, quote: "Not on the page" }],
      affectedTemplateParagraphIndexes: [4], affectedFieldKeys: [],
    }, {
      id: "missing",
      summary: "Model-specific missing claim",
      explanation: "Model prose must not become an uncited factual assertion.",
      citations: [], affectedTemplateParagraphIndexes: [4], affectedFieldKeys: [],
    }] }, evidence, template);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ summary: "Supporting evidence not located", citations: [] });
    expect(review[0]?.id).toMatch(/^source-review-/);
  });

  it("returns bounded edit proposals without mutating the draft", async () => {
    const proposal = await createAiProvider("mock").refine({
      instruction: "Make concise",
      annotations: [{ blockId: "block-1", quote: "This is very concise.", start: 0, end: 21 }],
      evidence: [],
    });
    expect(proposal.edits[0]?.targetText).toBe("This is very concise.");
    expect(proposal.edits[0]?.replacementText).toBe("This is concise.");
  });

  it("accepts only confirmed replacement candidates grounded on the cited page", () => {
    const template = {
      analysisVersion: 2,
      filename: "canary.docx", paragraphCount: 0, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [], regions: [],
      replacementCandidates: [{ value: "OLD-CLAIM", location: "word/header1.xml", kind: "claim-number" as const }],
      imageCandidates: [],
    };
    const draft = parseModelDraft({
      title: "Demand", matterName: "Canary", sections: [], warnings: [],
      replacements: [
        { oldValue: "not-a-template-value", newValue: "Jordan Canary", sourceId, page: 1 },
        { oldValue: "OLD-CLAIM", newValue: "invented-value", sourceId, page: 1 },
      ],
    }, [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Claim #: NEW-123\nPatient: Jordan Canary" }], template);
    expect(draft.fields).toEqual({});

    const grounded = parseModelDraft({
      title: "Demand", matterName: "Canary", sections: [], warnings: [],
      replacements: [{ oldValue: "OLD-CLAIM", newValue: "NEW-123", sourceId, page: 1 }],
    }, [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Claim #: NEW-123" }], template);
    expect(grounded.fields["OLD-CLAIM"]?.value).toBe("NEW-123");
    expect(grounded.fields["OLD-CLAIM"]?.sourceId).toBe(sourceId);
    expect(grounded.fields["OLD-CLAIM"]?.confidence).toBe(1);
  });

  it("keeps a verified split deadline time in its preserved continuation only", () => {
    const template = {
      analysisVersion: 3,
      filename: "deadline.docx", paragraphCount: 89, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
      regions: [
        { paragraphIndex: 87, text: "This offer expires on October 1, 2026, ", role: "editable" as const, confidence: 0.9, style: null },
        { paragraphIndex: 88, text: "at 12:00 p.m. PST. Acceptance requires compliance.", role: "preserve" as const, confidence: 0.9, style: null },
      ],
      replacementCandidates: [{ value: "12:00 p.m. PST", location: "word/document.xml", kind: "date" as const }],
      imageCandidates: [],
    };
    const draft = parseModelDraft({
      title: "Demand", matterName: "Canary", warnings: [],
      sections: [{
        id: "terms", heading: null, blocks: [{
          id: "deadline", kind: "paragraph", verified: true, citations: [], templateParagraphIndex: 87,
          text: "This offer expires on October 15, 2026 at 5:00 p.m. Pacific Time.",
        }],
      }],
      replacements: [{ oldValue: "12:00 p.m. PST", newValue: "5:00 p.m. Pacific Time", sourceId, page: 1 }],
    }, [{
      sourceId, sourceName: "instructions.pdf", page: 1,
      text: "Deadline: October 15, 2026 at 5:00 p.m. Pacific Time",
    }], template);

    expect(draft.sections[0]?.blocks[0]?.text).toBe("This offer expires on October 15, 2026,");
    expect(draft.fields["12:00 p.m. PST"]?.value).toBe("5:00 p.m. Pacific Time");
  });
});
