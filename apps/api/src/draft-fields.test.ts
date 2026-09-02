import { describe, expect, it } from "vitest";
import type { GeneratedDraft } from "@steno/contracts";
import { confirmDraftField, exportableFieldReplacements } from "./draft-fields";

const draft: GeneratedDraft = {
  title: "Demand",
  matterName: "Example",
  warnings: [],
  reviewFlags: [],
  sections: [],
  fields: {
    legacy: { value: "LEGACY", verified: true, confidence: null, userConfirmed: false, sourceId: null, page: null, sourceLabel: null },
    strong: { value: "STRONG", verified: true, confidence: 0.92, userConfirmed: false, sourceId: null, page: null, sourceLabel: "declarations.pdf · p. 1" },
    weak: { value: "WEAK", verified: true, confidence: 0.55, userConfirmed: false, sourceId: null, page: null, sourceLabel: "scan.pdf · p. 2" },
    missing: { value: "[ATTORNEY REVIEW REQUIRED]", verified: false, confidence: null, userConfirmed: false, sourceId: null, page: null, sourceLabel: null },
  },
};

describe("draft field safety", () => {
  it("preserves provenance while marking a correction explicitly confirmed", () => {
    const result = confirmDraftField(draft, "weak", "CORRECTED");
    expect(result.corrected).toBe(true);
    expect(result.content.fields.weak).toMatchObject({
      value: "CORRECTED", userConfirmed: true, confidence: 0.55, sourceLabel: "scan.pdf · p. 2",
    });
    expect(draft.fields.weak?.value).toBe("WEAK");
  });

  it("exports only sufficiently grounded or explicitly confirmed non-placeholder fields", () => {
    const corrected = confirmDraftField(draft, "weak", "CORRECTED").content;
    expect(exportableFieldReplacements(corrected.fields)).toEqual({
      legacy: "LEGACY",
      strong: "STRONG",
      weak: "CORRECTED",
    });
  });
});
