import { describe, expect, it } from "vitest";
import type { GeneratedDraft } from "@steno/contracts";
import { draftExportIssues, isDraftExportReady } from "./draft-export";

const content: GeneratedDraft = {
  title: "Demand",
  matterName: "Example",
  warnings: [],
  reviewFlags: [],
  outcomes: [],
  fields: {
    "old claim": {
      value: "new claim",
      verified: true,
      confidence: 0.95,
      userConfirmed: false,
      sourceId: null,
      page: null,
      sourceLabel: null,
    },
  },
  sections: [{
    id: "facts",
    heading: null,
    blocks: [{
      id: "supported",
      kind: "paragraph",
      text: "Supported replacement.",
      templateParagraphIndex: 4,
      templateBlockId: "word/document.xml:p:4",
      citations: [],
      verified: true,
    }],
  }],
};

describe("Word export readiness", () => {
  it("allows a fully grounded draft", () => {
    expect(isDraftExportReady(draftExportIssues(content))).toBe(true);
    expect(isDraftExportReady(draftExportIssues({
      ...content,
      fields: {
        semantic_claim_number: {
          ...content.fields["old claim"]!,
          templateValue: "old claim",
        },
      },
    }))).toBe(true);
  });

  it("blocks warning prose from being inserted into the immutable Word template", () => {
    const blocked: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [{
        ...content.sections[0]!.blocks[0]!,
        id: "unsupported",
        kind: "warning",
        text: "[ATTORNEY REVIEW REQUIRED — no supported replacement was generated.]",
        verified: false,
      }] }],
    };
    expect(draftExportIssues(blocked).blockIds).toEqual(["unsupported"]);
  });

  it("blocks a general conflict warning without a template paragraph mapping", () => {
    const blocked: GeneratedDraft = {
      ...content,
      sections: [{
        ...content.sections[0]!,
        blocks: [{
          id: "claim-conflict",
          kind: "warning",
          text: "The uploaded sources contain conflicting claim numbers.",
          templateParagraphIndex: null,
          citations: [],
          verified: false,
        }, ...content.sections[0]!.blocks],
      }],
    };
    expect(draftExportIssues(blocked).blockIds).toContain("claim-conflict");
    expect(isDraftExportReady(draftExportIssues(blocked))).toBe(false);
  });

  it("blocks any unconfirmed edited content even when it has no template mapping", () => {
    const blocked: GeneratedDraft = {
      ...content,
      sections: [{
        ...content.sections[0]!,
        blocks: [{
          ...content.sections[0]!.blocks[0]!,
          id: "unmapped-edit",
          templateParagraphIndex: null,
          templateBlockId: null,
          verified: false,
          userConfirmed: false,
        }],
      }],
    };
    expect(draftExportIssues(blocked).blockIds).toEqual(["unmapped-edit"]);
  });

  it("does not confuse equal paragraph indexes in different OOXML parts", () => {
    const crossPart: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [
        { ...content.sections[0]!.blocks[0]!, templateParagraphIndex: 0, templateBlockId: "word/document.xml:p:0" },
        { ...content.sections[0]!.blocks[0]!, id: "header", templateParagraphIndex: 0, templateBlockId: "word/header1.xml:p:0" },
      ] }],
    };
    expect(draftExportIssues(crossPart).duplicateParagraphIndexes).toEqual([]);
  });

  it("allows an attorney-confirmed replacement but rejects unresolved and duplicate slots", () => {
    const reviewed = {
      ...content.sections[0]!.blocks[0]!,
      id: "reviewed",
      text: "Attorney reviewed replacement.",
      verified: false,
      userConfirmed: true,
    };
    const unresolvedField: GeneratedDraft = {
      ...content,
      fields: {
        legacy: {
          value: "[ATTORNEY REVIEW REQUIRED]",
          verified: false,
          confidence: null,
          userConfirmed: false,
          sourceId: null,
          page: null,
          sourceLabel: null,
        },
      },
      sections: [{ ...content.sections[0]!, blocks: [reviewed, { ...reviewed, id: "duplicate" }] }],
    };
    const issues = draftExportIssues(unresolvedField);
    expect(issues.blockIds).toEqual([]);
    expect(issues.fieldKeys).toEqual(["legacy"]);
    expect(issues.duplicateParagraphIndexes).toEqual([4]);
  });

  it("allows elastic paragraphs from one stable target to share the final exemplar anchor", () => {
    const exemplar = content.sections[0]!.blocks[0]!;
    const elastic: GeneratedDraft = {
      ...content,
      sections: [{ ...content.sections[0]!, blocks: [
        { ...exemplar, id: "run-0", targetId: "narrative-1", sequence: 0 },
        { ...exemplar, id: "run-1", targetId: "narrative-1", sequence: 1 },
      ] }],
    };
    expect(draftExportIssues(elastic).duplicateParagraphIndexes).toEqual([]);
    expect(isDraftExportReady(draftExportIssues(elastic))).toBe(true);
  });

  it("uses the same readiness result for stale evidence", () => {
    const stale = draftExportIssues(content, {
      draftSourceFingerprint: "a".repeat(64),
      currentSourceFingerprint: "b".repeat(64),
    });
    expect(stale).toMatchObject({
      ready: false,
      staleEvidence: true,
      imageIssue: null,
    });
  });

  it("blocks only unresolved or stale omission decisions", () => {
    const omission = {
      id: "outcome:target-1", targetId: "target-1", targetKind: "narrative" as const,
      status: "omitted_no_evidence" as const, resolution: "unresolved" as const,
      citations: [], note: "No support located.", sourceId: null, page: null, sourceName: null,
      mediaType: null, caption: null, exemplarCount: 1, generatedCount: 0,
    };
    expect(draftExportIssues({ ...content, outcomes: [omission] })).toMatchObject({
      ready: false, outcomeIds: ["outcome:target-1"], staleResolutionTargetIds: [],
    });
    expect(draftExportIssues({
      ...content, outcomes: [{ ...omission, resolution: "preapproved" }],
    })).toMatchObject({ ready: true, outcomeIds: [] });
    expect(draftExportIssues({
      ...content, outcomes: [{ ...omission, resolution: "confirmed" }],
    }, { staleResolutionTargetIds: ["target-1"] })).toMatchObject({
      ready: false, outcomeIds: [], staleResolutionTargetIds: ["target-1"],
    });
  });

  it("links generic review flags only to concrete blocking targets", () => {
    const flagged: GeneratedDraft = {
      ...content,
      reviewFlags: [{
        id: "source-review-linked",
        kind: "missing_evidence",
        severity: "blocking",
        summary: "Needs source review",
        explanation: "Review this source-backed region.",
        citations: [],
        affectedTemplateParagraphIndexes: [4],
        affectedFieldKeys: [],
        affectedTargetIds: [],
      }, {
        id: "source-review-advisory",
        kind: "general",
        severity: "verification",
        summary: "Advisory",
        explanation: "This flag has no blocked target.",
        citations: [],
        affectedTemplateParagraphIndexes: [],
        affectedFieldKeys: [],
        affectedTargetIds: [],
      }],
      sections: [{ ...content.sections[0]!, blocks: [{
        ...content.sections[0]!.blocks[0]!, kind: "warning", verified: false,
      }] }],
    };
    expect(draftExportIssues(flagged).blockingReviewFlagIds).toEqual(["source-review-linked"]);
  });
});
