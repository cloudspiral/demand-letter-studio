import { describe, expect, it } from "vitest";
import type { GeneratedDraft } from "@steno/contracts";
import { draftExportIssues, isDraftExportReady } from "./draft-export";

const citation = {
  sourceId: "10000000-0000-4000-8000-000000000001",
  sourceName: "claim.pdf",
  page: 1,
  quote: "Claim number: PPC-2026-0417",
  evidenceType: "text" as const,
  visualDescription: null,
};

const content: GeneratedDraft = {
  title: "Demand",
  confirmedOmissionTargetIds: [],
  outcomes: [{
    id: "outcome:target-1",
    targetId: "target-1",
    targetKind: "narrative",
    status: "generated",
    citations: [citation],
    note: null,
    sourceId: null,
    page: null,
    sourceName: null,
    mediaType: null,
    caption: null,
    exemplarCount: 1,
    generatedCount: 1,
  }],
  fields: {
    claim_number: {
      fieldKey: "claim_number",
      oldValue: "OLD-123",
      value: "PPC-2026-0417",
      label: "Claim number",
      citations: [citation],
      note: null,
      attorneyEdited: false,
    },
  },
  sections: [{
    id: "facts",
    heading: null,
    blocks: [{
      id: "supported",
      kind: "paragraph",
      text: "The claim number is PPC-2026-0417.",
      templateParagraphIndex: 4,
      templateBlockId: "word/document.xml:p:4",
      citations: [citation],
      attorneyEdited: false,
      targetId: "target-1",
      outcomeId: "outcome:target-1",
      sequence: 0,
    }],
  }],
};

describe("Word export readiness", () => {
  it("allows a grounded draft and attorney edits without a second confirmation", () => {
    expect(isDraftExportReady(draftExportIssues(content))).toBe(true);
    const edited: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [{ ...content.sections[0]!.blocks[0]!, text: "Attorney revision.", attorneyEdited: true }] }],
    };
    expect(draftExportIssues(edited).ready).toBe(true);
  });

  it("blocks a null field until the attorney supplies a value", () => {
    const blocked: GeneratedDraft = {
      ...content,
      fields: {
        claim_number: {
          ...content.fields.claim_number!,
          value: null,
          citations: [],
          note: "No unambiguous claim number was found.",
        },
      },
    };
    expect(draftExportIssues(blocked)).toMatchObject({ ready: false, fieldKeys: ["claim_number"] });
  });

  it("blocks an omitted target exactly until its versioned omission is confirmed", () => {
    const omitted = {
      ...content.outcomes[0]!,
      status: "omitted" as const,
      citations: [],
      note: "No treatment records support this section.",
      generatedCount: 0,
    };
    expect(draftExportIssues({ ...content, outcomes: [omitted] })).toMatchObject({
      ready: false,
      omittedTargetIds: ["target-1"],
    });
    expect(draftExportIssues({
      ...content,
      outcomes: [omitted],
      confirmedOmissionTargetIds: ["target-1"],
    })).toMatchObject({ ready: true, omittedTargetIds: [] });
  });

  it("detects stale evidence and duplicate template mappings", () => {
    const stale = draftExportIssues(content, {
      draftSourceFingerprint: "a".repeat(64),
      currentSourceFingerprint: "b".repeat(64),
    });
    expect(stale).toMatchObject({ ready: false, staleEvidence: true });

    const duplicate: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [
        content.sections[0]!.blocks[0]!,
        {
          ...content.sections[0]!.blocks[0]!,
          id: "other-target",
          targetId: "target-2",
          outcomeId: "outcome:target-2",
        },
      ] }],
    };
    expect(draftExportIssues(duplicate)).toMatchObject({ ready: false, duplicateParagraphIndexes: [4] });
  });

  it("allows multiple generated paragraphs from one target to share its exemplar anchor", () => {
    const exemplar = content.sections[0]!.blocks[0]!;
    const elastic: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [
        { ...exemplar, id: "run-0", sequence: 0 },
        { ...exemplar, id: "run-1", sequence: 1 },
      ] }],
    };
    expect(draftExportIssues(elastic).duplicateParagraphIndexes).toEqual([]);
    expect(draftExportIssues(elastic).ready).toBe(true);
  });

  it("does not confuse equal paragraph indexes in different OOXML parts", () => {
    const exemplar = content.sections[0]!.blocks[0]!;
    const crossPart: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [
        { ...exemplar, templateParagraphIndex: 0, templateBlockId: "word/document.xml:p:0" },
        { ...exemplar, id: "header", templateParagraphIndex: 0, templateBlockId: "word/header1.xml:p:0" },
      ] }],
    };
    expect(draftExportIssues(crossPart).duplicateParagraphIndexes).toEqual([]);
  });
});
