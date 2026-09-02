import { describe, expect, it } from "vitest";
import type { GeneratedDraft } from "@steno/contracts";
import { draftExportIssues, isDraftExportReady } from "./draft-export";

const content: GeneratedDraft = {
  title: "Demand",
  matterName: "Example",
  warnings: [],
  reviewFlags: [],
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
      citations: [],
      verified: true,
    }],
  }],
};

describe("Word export readiness", () => {
  it("allows a fully grounded draft", () => {
    expect(isDraftExportReady(draftExportIssues(content))).toBe(true);
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
          verified: false,
          userConfirmed: false,
        }],
      }],
    };
    expect(draftExportIssues(blocked).blockIds).toEqual(["unmapped-edit"]);
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

  it("uses the same readiness result for stale evidence and ambiguous image mappings", () => {
    const stale = draftExportIssues(content, {
      draftSourceFingerprint: "a".repeat(64),
      currentSourceFingerprint: "b".repeat(64),
      imageCandidates: 1,
      imageSources: 2,
    });
    expect(stale).toMatchObject({
      ready: false,
      staleEvidence: true,
      imageIssue: { templateCandidates: 1, sourceImages: 2 },
    });
  });

  it("links generic review flags only to concrete blocking targets", () => {
    const flagged: GeneratedDraft = {
      ...content,
      reviewFlags: [{
        id: "source-review-linked",
        summary: "Needs source review",
        explanation: "Review this source-backed region.",
        citations: [],
        affectedTemplateParagraphIndexes: [4],
        affectedFieldKeys: [],
      }, {
        id: "source-review-advisory",
        summary: "Advisory",
        explanation: "This flag has no blocked target.",
        citations: [],
        affectedTemplateParagraphIndexes: [],
        affectedFieldKeys: [],
      }],
      sections: [{ ...content.sections[0]!, blocks: [{
        ...content.sections[0]!.blocks[0]!, kind: "warning", verified: false,
      }] }],
    };
    expect(draftExportIssues(flagged).blockingReviewFlagIds).toEqual(["source-review-linked"]);
  });
});
