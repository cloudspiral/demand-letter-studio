import { describe, expect, it } from "vitest";
import { createAiProvider, parseModelDraft } from "./ai";

const sourceId = "10000000-0000-4000-8000-000000000001";

describe("AI provider adapter", () => {
  it("returns schema-valid deterministic drafts through the same adapter", async () => {
    const provider = createAiProvider("mock");
    const draft = await provider.generate({
      matterName: "Jordan Canary matter",
      template: {
        filename: "canary.docx", paragraphCount: 1, sectionCount: 1,
        hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
        replacementCandidates: [],
        regions: [{ paragraphIndex: 0, text: "Old case narrative", role: "editable", confidence: 1, style: null }],
      },
      evidence: [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Patient: Jordan Canary\nTotal Charges: $12,345.67" }],
    });
    expect(provider.name).toBe("mock");
    expect(draft.matterName).toBe("Jordan Canary matter");
    expect(draft.sections[0]?.blocks[0]?.citations[0]?.sourceId).toBe(sourceId);
  });

  it("returns bounded edit proposals without mutating the draft", async () => {
    const proposal = await createAiProvider("mock").refine({
      instruction: "Make concise", selectedText: "This is very concise.", evidence: [],
    });
    expect(proposal.targetText).toBe("This is very concise.");
    expect(proposal.replacementText).toBe("This is concise.");
  });

  it("accepts only confirmed replacement candidates grounded on the cited page", () => {
    const template = {
      filename: "canary.docx", paragraphCount: 0, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [], regions: [],
      replacementCandidates: [{ value: "OLD-CLAIM", location: "word/header1.xml", kind: "claim-number" as const }],
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
  });
});
