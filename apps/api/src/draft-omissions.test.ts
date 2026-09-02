import { describe, expect, it } from "vitest";
import type { GeneratedDraft, TemplateAnalysis } from "@steno/contracts";
import { confirmOmission } from "./draft-omissions";
import { deriveGenerationTargets } from "./template-map";

const template: TemplateAnalysis = {
  analysisVersion: 5,
  filename: "demand.docx",
  paragraphCount: 2,
  sectionCount: 1,
  hasMacros: false,
  hasTrackedChanges: false,
  hasComplexObjects: false,
  warnings: [],
  replacementCandidates: [],
  imageCandidates: [],
  regions: [
    { id: "word/document.xml:p:0", paragraphIndex: 0, text: "FUTURE MEDICAL CARE", role: "heading", semanticKind: "heading", section: "FUTURE MEDICAL CARE", aiRecommendation: "keep", confidence: 1, style: null, structuredGroup: null, figure: null },
    { id: "word/document.xml:p:1", paragraphIndex: 1, text: "Old future-care narrative.", role: "editable", semanticKind: "prose", section: "FUTURE MEDICAL CARE", aiRecommendation: "replace", confidence: 1, style: null, structuredGroup: null, figure: null },
  ],
};

const target = deriveGenerationTargets(template)[0]!;
const draft: GeneratedDraft = {
  title: "Demand",
  fields: {},
  confirmedOmissionTargetIds: [],
  outcomes: [{
    id: `outcome:${target.id}`,
    targetId: target.id,
    targetKind: "narrative",
    status: "omitted",
    citations: [],
    note: "No future-care evidence was located.",
    sourceId: null,
    page: null,
    sourceName: null,
    mediaType: null,
    caption: null,
    exemplarCount: 1,
    generatedCount: 0,
  }],
  sections: [{ id: "document", heading: null, blocks: [{
    id: "keep-template-word/document.xml:p:0",
    kind: "heading",
    text: "FUTURE MEDICAL CARE",
    templateParagraphIndex: 0,
    templateBlockId: "word/document.xml:p:0",
    citations: [],
    attorneyEdited: false,
  }] }],
};

describe("omission confirmation", () => {
  it("stores the decision in the draft snapshot and blanks an orphan heading", () => {
    const result = confirmOmission(draft, target.id, template);
    expect(result.headingCleared).toBe(true);
    expect(result.content.confirmedOmissionTargetIds).toEqual([target.id]);
    expect(result.content.sections[0]?.blocks[0]).toMatchObject({ text: "", attorneyEdited: true });
    expect(draft.confirmedOmissionTargetIds).toEqual([]);
  });

  it("rejects duplicate confirmation", () => {
    const confirmed = confirmOmission(draft, target.id, template).content;
    expect(() => confirmOmission(confirmed, target.id, template)).toThrow(/already confirmed/i);
  });
});
