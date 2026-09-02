import { describe, expect, it } from "vitest";
import { normalizeDraftContent } from "./draft-compat";

const citation = {
  sourceId: "10000000-0000-4000-8000-000000000001",
  sourceName: "claim.pdf",
  page: 1,
  quote: "Claim number: PPC-2026-0417",
  evidenceType: "text",
  visualDescription: null,
};

describe("legacy draft normalization", () => {
  it("normalizes old omission variants without retaining legacy flags or locks", () => {
    const normalized = normalizeDraftContent({
      title: "Historical draft",
      warnings: ["ignored"],
      reviewFlags: [{ id: "ignored" }],
      outcomes: [
        { id: "one", targetId: "one", targetKind: "narrative", status: "omitted_no_evidence", resolution: "confirmed", citations: [], note: "No records.", exemplarCount: 1, generatedCount: 0 },
        { id: "two", targetId: "two", targetKind: "narrative", status: "omitted_not_applicable", resolution: "not_required", citations: [], note: "Not applicable.", exemplarCount: 1, generatedCount: 0 },
      ],
      fields: {},
      sections: [{ id: "section", heading: null, blocks: [{
        id: "keep",
        kind: "paragraph",
        text: "Keep text",
        templateParagraphIndex: 0,
        citations: [],
        locked: true,
        verified: true,
      }] }],
    }, ["one"]);

    expect(normalized.outcomes.map((outcome) => outcome.status)).toEqual(["omitted", "omitted"]);
    expect(normalized.confirmedOmissionTargetIds).toEqual(["one"]);
    expect(normalized.sections[0]?.blocks[0]).not.toHaveProperty("locked");
    expect(normalized).not.toHaveProperty("warnings");
    expect(normalized).not.toHaveProperty("reviewFlags");
  });

  it("keeps valid values and converts legacy placeholders to null review items", () => {
    const normalized = normalizeDraftContent({
      title: "Historical draft",
      outcomes: [],
      sections: [],
      fields: {
        valid: { value: "PPC-2026-0417", templateValue: "OLD-123", citations: [citation] },
        missing: { value: "[ATTORNEY REVIEW REQUIRED]", templateValue: "OLD CLIENT" },
        corrected: { value: "Naomi Carter", templateValue: "OLD CLIENT", userConfirmed: true },
      },
    });
    expect(normalized.fields.valid).toMatchObject({ value: "PPC-2026-0417", oldValue: "OLD-123", attorneyEdited: false });
    expect(normalized.fields.missing).toMatchObject({ value: null, oldValue: "OLD CLIENT" });
    expect(normalized.fields.missing?.note).toMatch(/No grounded replacement/i);
    expect(normalized.fields.corrected).toMatchObject({ value: "Naomi Carter", attorneyEdited: true });
  });

  it("does not carry historical confirmations into a current regenerated snapshot", () => {
    const normalized = normalizeDraftContent({
      title: "Regenerated draft",
      confirmedOmissionTargetIds: [],
      fields: {},
      sections: [],
      outcomes: [{
        id: "one",
        targetId: "one",
        targetKind: "narrative",
        status: "omitted",
        citations: [],
        note: "Still unsupported after regeneration.",
        exemplarCount: 1,
        generatedCount: 0,
      }],
    }, ["one"]);
    expect(normalized.confirmedOmissionTargetIds).toEqual([]);
  });
});
