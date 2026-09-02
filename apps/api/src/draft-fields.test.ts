import { describe, expect, it } from "vitest";
import type { GeneratedDraft } from "@steno/contracts";
import { confirmDraftField, exportableFieldKeys, exportableFieldReplacements } from "./draft-fields";

const draft: GeneratedDraft = {
  title: "Demand",
  outcomes: [],
  confirmedOmissionTargetIds: [],
  sections: [],
  fields: {
    grounded: {
      fieldKey: "grounded",
      oldValue: "OLD-123",
      value: "NEW-456",
      label: "Claim number",
      citations: [{
        sourceId: "10000000-0000-4000-8000-000000000001",
        sourceName: "claim.pdf",
        page: 1,
        quote: "Claim number: NEW-456",
        evidenceType: "text",
        visualDescription: null,
      }],
      note: null,
      attorneyEdited: false,
    },
    missing: {
      fieldKey: "missing",
      oldValue: "OLD CLIENT",
      value: null,
      label: "Client name",
      citations: [],
      note: "No unambiguous client name was found.",
      attorneyEdited: false,
    },
  },
};

describe("draft fields", () => {
  it("treats an attorney-supplied value as approval without another confirmation", () => {
    const result = confirmDraftField(draft, "missing", "Naomi Carter");
    expect(result.corrected).toBe(true);
    expect(result.content.fields.missing).toMatchObject({
      value: "Naomi Carter",
      note: null,
      attorneyEdited: true,
    });
    expect(result.content.fields.missing?.citations).toEqual([]);
    expect(draft.fields.missing?.value).toBeNull();
  });

  it("rejects a blank correction and exports only non-null values", () => {
    expect(() => confirmDraftField(draft, "missing", "   ")).toThrow(/cannot be blank/i);
    const corrected = confirmDraftField(draft, "missing", "Naomi Carter").content;
    expect(exportableFieldReplacements(corrected.fields)).toEqual({
      "OLD-123": "NEW-456",
      "OLD CLIENT": "Naomi Carter",
    });
    expect(exportableFieldKeys(draft.fields)).toEqual(["grounded"]);
  });
});
