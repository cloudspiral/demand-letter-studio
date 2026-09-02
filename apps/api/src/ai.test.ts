import { describe, expect, it } from "vitest";
import {
  TemplateAnalysisSchema,
  TemplateRegionSchema,
  type TemplateAnalysis,
  type TemplateRegion,
} from "@steno/contracts";
import {
  createAiProvider,
  generatedDraftJsonSchema,
  parseModelDraft,
  parseTemplateAnalysis,
  promptForTemplateAnalysis,
} from "./ai";
import { deriveGenerationTargets } from "./template-map";

const sourceId = "10000000-0000-4000-8000-000000000001";

function region(overrides: Partial<TemplateRegion> & Pick<TemplateRegion, "paragraphIndex" | "text">): TemplateRegion {
  return TemplateRegionSchema.parse({
    id: `word/document.xml:p:${overrides.paragraphIndex}`,
    role: "preserve",
    semanticKind: "prose",
    section: null,
    aiRecommendation: "keep",
    confidence: 1,
    style: null,
    structuredGroup: null,
    figure: null,
    inlineFields: [],
    ...overrides,
  });
}

function template(blocks: TemplateRegion[], overrides: Partial<TemplateAnalysis> = {}): TemplateAnalysis {
  return TemplateAnalysisSchema.parse({
    analysisVersion: 5,
    filename: "canary.docx",
    paragraphCount: blocks.length,
    sectionCount: 1,
    hasMacros: false,
    hasTrackedChanges: false,
    hasComplexObjects: false,
    warnings: [],
    blocks,
    regions: blocks.filter((block) => (block.anchor?.partName ?? "word/document.xml") === "word/document.xml"),
    replacementCandidates: [],
    knownCaseSpecificValues: [],
    imageCandidates: [],
    ...overrides,
  });
}

const citation = {
  sourceId,
  sourceName: "canary.pdf",
  page: 1,
  quote: "Total Charges: $12,345.67",
  evidenceType: "text" as const,
  visualDescription: null,
};

function modelOutput(targetId: string, text = "The records document charges of $12,345.67.") {
  return {
    outcomes: [{
      targetId,
      status: "generated" as const,
      paragraphs: [{ text, citations: [citation] }],
      rows: [],
      caption: null,
      sourceId: null,
      page: null,
      mediaType: null,
      citations: [],
      note: null,
    }],
    replacements: [],
  };
}

describe("AI provider adapter", () => {
  it("maps every exact original block and permits replaceable fields inside locked headings", () => {
    const structural = template([
      region({ paragraphIndex: 0, text: "DEMAND FOR JORDAN CANARY" }),
      region({ paragraphIndex: 1, text: "Claim Number: OLD-123" }),
    ]);
    const input = { filename: structural.filename, templateHash: "a".repeat(64), structuralAnalysis: structural };
    const result = parseTemplateAnalysis({
      decisions: [
        {
          blockId: "word/document.xml:p:0",
          role: "heading",
          caseIndependentRemainder: true,
          confidence: 0.99,
          explanation: "Document heading with a matter-specific name.",
          inlineFields: [{
            key: "heading_client_name", label: "Client name", start: 11, end: 24,
            originalText: "JORDAN CANARY", kind: "person", confidence: 0.99,
            explanation: "Previous matter name.", role: "replace",
          }],
        },
        {
          blockId: "word/document.xml:p:1",
          role: "keep",
          caseIndependentRemainder: true,
          confidence: 0.96,
          explanation: "Keep the label and replace the identifier.",
          inlineFields: [{
            key: "claim_number", label: "Claim number", start: 14, end: 21,
            originalText: "OLD-123", kind: "claim-number", confidence: 0.99,
            explanation: "Previous matter identifier.", role: "replace",
          }],
        },
      ],
      knownCaseSpecificValues: ["JORDAN CANARY", "OLD-123"],
    }, input);

    expect(result.regions.map((block) => block.role)).toEqual(["heading", "preserve"]);
    expect(result.analysisVersion).toBe(7);
    expect(result.regions[0]?.inlineFields?.[0]).toMatchObject({ key: "heading_client_name", role: "replace" });
    expect(result.replacementCandidates.map((field) => field.fieldKey)).toEqual(["heading_client_name", "claim_number"]);
    expect(() => parseTemplateAnalysis({ decisions: [], knownCaseSpecificValues: [] }, input)).toThrow();
  });

  it("makes repeated model field keys unique", () => {
    const first = region({
      id: "word/header1.xml:p:0", paragraphIndex: 0, text: "Claim Number: OLD-123",
      anchor: { partName: "word/header1.xml", kind: "header", paragraphIndex: 0, path: "/header/p[0]" },
    });
    const second = region({ paragraphIndex: 0, text: "Claim Number: OLD-123" });
    const structural = template([first, second]);
    const result = parseTemplateAnalysis({
      decisions: [first, second].map((block) => ({
        blockId: block.id!, role: "keep" as const, confidence: 0.99,
        caseIndependentRemainder: true,
        explanation: "Keep the label and replace the identifier.",
        inlineFields: [{
          key: "claim_number", label: "Claim number", start: 14, end: 21,
          originalText: "OLD-123", kind: "claim-number" as const, confidence: 0.99,
          explanation: "Previous matter identifier.", role: "replace" as const,
        }],
      })),
      knownCaseSpecificValues: ["OLD-123"],
    }, { filename: structural.filename, templateHash: "b".repeat(64), structuralAnalysis: structural });
    expect(result.blocks?.flatMap((block) => block.inlineFields?.map((field) => field.key) ?? []))
      .toEqual(["claim_number", "claim_number_2"]);
  });

  it("rejects Keep when a replaced person leaves case-dependent surrounding language", () => {
    const text = "Mr. Donahue's claim is compensable because he suffered harm affecting his life.";
    const structural = template([region({ paragraphIndex: 0, text })]);
    const input = { filename: structural.filename, templateHash: "c".repeat(64), structuralAnalysis: structural };
    const decision = {
      blockId: "word/document.xml:p:0",
      role: "keep" as const,
      caseIndependentRemainder: false,
      confidence: 0.99,
      explanation: "The name is replaceable, but surrounding references still depend on that person.",
      inlineFields: [{
        key: "client_name", label: "Client name", start: 0, end: 11,
        originalText: "Mr. Donahue", kind: "person" as const, confidence: 0.99,
        explanation: "Previous matter name.", role: "replace" as const,
      }],
    };

    expect(() => parseTemplateAnalysis({ decisions: [decision], knownCaseSpecificValues: ["Mr. Donahue"] }, input))
      .toThrow(/remaining text is case-dependent/i);
    expect(promptForTemplateAnalysis(input)).toContain("choose replace for the entire block");
  });

  it("keeps child fields independent under Keep and forces them to Replace under a replaced parent", () => {
    const kept = region({ paragraphIndex: 0, text: "Claim Number: OLD-123" });
    const replaced = region({ paragraphIndex: 1, text: "Old narrative OLD-456" });
    const structural = template([kept, replaced]);
    const input = { filename: structural.filename, templateHash: "d".repeat(64), structuralAnalysis: structural };
    const field = (key: string, originalText: string, start: number) => ({
      key, label: "Identifier", start, end: start + originalText.length, originalText,
      kind: "claim-number" as const, confidence: 0.99,
      explanation: "Previous matter identifier.", role: "keep" as const,
    });
    const result = parseTemplateAnalysis({
      decisions: [
        {
          blockId: kept.id!, role: "keep" as const, caseIndependentRemainder: true, confidence: 0.99,
          explanation: "Reusable label.", inlineFields: [field("kept_claim", "OLD-123", 14)],
        },
        {
          blockId: replaced.id!, role: "replace" as const, caseIndependentRemainder: false, confidence: 0.99,
          explanation: "Replace the complete narrative.", inlineFields: [field("replaced_claim", "OLD-456", 14)],
        },
      ],
      knownCaseSpecificValues: ["OLD-123", "OLD-456"],
    }, input);

    expect(result.blocks?.[0]?.inlineFields?.[0]?.role).toBe("keep");
    expect(result.blocks?.[1]?.inlineFields?.[0]?.role).toBe("replace");
    expect(promptForTemplateAnalysis(input)).toContain("block keep preserves the surrounding block");
  });

  it("repairs a model field offset when its exact text identifies one span", () => {
    const text = "TOTAL MEDICAL EXPENSES: $12,345.67";
    const structural = template([region({ paragraphIndex: 63, text })]);
    const result = parseTemplateAnalysis({
      decisions: [{
        blockId: "word/document.xml:p:63",
        role: "keep",
        caseIndependentRemainder: true,
        confidence: 0.99,
        explanation: "Keep the label and replace the total.",
        inlineFields: [{
          key: "total_medical_expenses", label: "Total medical expenses",
          start: 23, end: 32, originalText: "$12,345.67", kind: "amount",
          confidence: 0.99, explanation: "Previous matter total.", role: "replace",
        }],
      }],
      knownCaseSpecificValues: ["$12,345.67"],
    }, { filename: structural.filename, templateHash: "e".repeat(64), structuralAnalysis: structural });

    const field = result.blocks?.[0]?.inlineFields?.[0];
    expect(field).toMatchObject({ start: text.indexOf("$12,345.67"), end: text.length });
    expect(text.slice(field?.start, field?.end)).toBe("$12,345.67");
  });

  it("keeps every strict generation-schema property explicitly required", () => {
    const schema = generatedDraftJsonSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
    expect(schema.properties).not.toHaveProperty("title");
    expect(schema.properties).not.toHaveProperty("warnings");
    expect(schema.properties).not.toHaveProperty("reviewFlags");
  });

  it("configures the Bedrock adapter without static credentials", () => {
    const provider = createAiProvider("bedrock");
    expect(provider.name).toBe("bedrock");
    expect(provider.model).toMatch(/anthropic\.claude/);
  });

  it("returns schema-valid deterministic whole-document outcomes through the mock adapter", async () => {
    const mapped = template([region({ paragraphIndex: 0, text: "Old case narrative", role: "editable", aiRecommendation: "replace" })]);
    const provider = createAiProvider("mock");
    const draft = await provider.generate({
      matterName: "Jordan Canary matter",
      template: mapped,
      evidence: [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Total Charges: $12,345.67" }],
    });
    expect(draft.outcomes).toHaveLength(1);
    expect(draft.outcomes[0]).toMatchObject({ status: "generated", targetKind: "narrative" });
    expect(draft.sections[0]?.blocks[0]?.citations[0]?.sourceId).toBe(sourceId);
  });

  it("returns bounded refinement proposals without mutating the draft", async () => {
    const proposal = await createAiProvider("mock").refine({
      instruction: "Make concise",
      annotations: [{ blockId: "block-1", quote: "This is very concise.", start: 0, end: 21 }],
      evidence: [],
    });
    expect(proposal.edits[0]?.replacementText).toBe("This is concise.");
  });
});

describe("whole-document generation validation", () => {
  const mapped = template([
    region({ paragraphIndex: 3, text: "Old claimant narrative.", role: "editable", aiRecommendation: "replace" }),
    region({ paragraphIndex: 4, text: "Old medical narrative.", role: "editable", aiRecommendation: "replace" }),
  ], { knownCaseSpecificValues: ["Old claimant"] });
  const target = deriveGenerationTargets(mapped)[0]!;
  const evidence = [{ sourceId, sourceName: "canary.pdf", page: 1, text: "Total Charges: $12,345.67" }];

  it("requires exact target coverage with no missing or duplicate outcomes", () => {
    expect(() => parseModelDraft({ ...modelOutput(target.id), outcomes: [] }, evidence, mapped)).toThrow(/omitted 1 required/i);
    const output = modelOutput(target.id);
    expect(() => parseModelDraft({ ...output, outcomes: [output.outcomes[0], output.outcomes[0]] }, evidence, mapped)).toThrow(/duplicate/i);
  });

  it("rejects oversized narrative runs and uncited paragraphs", () => {
    const output = modelOutput(target.id);
    expect(() => parseModelDraft({
      ...output,
      outcomes: [{ ...output.outcomes[0]!, paragraphs: Array.from({ length: 13 }, (_, index) => ({ text: `Paragraph ${index}`, citations: [citation] })) }],
    }, evidence, mapped)).toThrow();
    expect(() => parseModelDraft({
      ...output,
      outcomes: [{ ...output.outcomes[0]!, paragraphs: [{ text: "Unsupported", citations: [] }] }],
    }, evidence, mapped)).toThrow();
  });

  it("rejects citations outside the packet and previous-matter leakage", () => {
    const output = modelOutput(target.id);
    expect(() => parseModelDraft({
      ...output,
      outcomes: [{ ...output.outcomes[0]!, paragraphs: [{ text: "Unknown source", citations: [{ ...citation, sourceId: "20000000-0000-4000-8000-000000000002" }] }] }],
    }, evidence, mapped)).toThrow(/unknown source page/i);
    expect(() => parseModelDraft(modelOutput(target.id, "Old claimant remains copied."), evidence, mapped)).toThrow(/previous-case/i);
  });

  it("uses one omitted status with a concise note and optional conflict citations", () => {
    const omitted = {
      ...modelOutput(target.id),
      outcomes: [{
        targetId: target.id, status: "omitted" as const, paragraphs: [], rows: [],
        caption: null, sourceId: null, page: null, mediaType: null, citations: [citation], note: "The records conflict about this section.",
      }],
    };
    expect(parseModelDraft(omitted, evidence, mapped).outcomes[0]).toMatchObject({
      status: "omitted",
      note: "The records conflict about this section.",
      citations: [citation],
    });
  });

  it("requires an explicit grounded outcome for every replaceable inline field", () => {
    const heading = region({
      paragraphIndex: 0, text: "DEMAND FOR OLD CLIENT", role: "heading", semanticKind: "heading",
      inlineFields: [{
        key: "heading_client", label: "Client name", start: 11, end: 21,
        originalText: "OLD CLIENT", kind: "person", confidence: 1,
        explanation: "Matter-specific heading value.", source: "model", role: "replace",
      }],
    });
    const withField = template([heading], {
      replacementCandidates: [{
        value: "OLD CLIENT", fieldKey: "heading_client", label: "Client name",
        location: "word/document.xml:p:0", kind: "person", blockId: "word/document.xml:p:0", start: 11, end: 21,
      }],
      knownCaseSpecificValues: ["OLD CLIENT"],
    });
    const base = { outcomes: [], replacements: [] };
    expect(() => parseModelDraft(base, evidence, withField)).toThrow(/omitted 1 required inline-field/i);
    const replacement = {
      fieldKey: "heading_client", oldValue: "OLD CLIENT",
      value: "$12,345.67", citations: [citation], note: null,
    };
    expect(parseModelDraft({ ...base, replacements: [replacement] }, evidence, withField).fields.heading_client)
      .toMatchObject({ fieldKey: "heading_client", oldValue: "OLD CLIENT", value: "$12,345.67", attorneyEdited: false });
    expect(() => parseModelDraft({ ...base, replacements: [replacement, replacement] }, evidence, withField)).toThrow(/duplicate/i);
    expect(() => parseModelDraft({
      ...base,
      replacements: [{ ...replacement, fieldKey: "unknown" }],
    }, evidence, withField)).toThrow(/unknown inline field/i);
  });

  it("rejects PDF page renders as figure replacements", () => {
    const figure = region({
      paragraphIndex: 0, text: "[Figure]", role: "editable", semanticKind: "figure",
      figure: { relationshipId: "rId9", partName: "word/media/image1.png", contentType: "image/png", captionBlockId: null },
    });
    const mappedFigure = template([figure]);
    const targetId = deriveGenerationTargets(mappedFigure)[0]!.id;
    const visualEvidence = [{
      sourceId, sourceName: "record.pdf", mimeType: "application/pdf", page: 1, text: "",
      visualInput: true, imageData: { mediaType: "image/png" as const, base64: "AA==" },
    }];
    expect(() => parseModelDraft({
      replacements: [],
      outcomes: [{
        targetId, status: "generated", paragraphs: [], rows: [], caption: "Rendered PDF page",
        sourceId, page: 1, mediaType: "image/png", citations: [{
          sourceId, sourceName: "record.pdf", page: 1, quote: "", evidenceType: "visual",
          visualDescription: "A rendered PDF page.",
        }], note: null,
      }],
    }, visualEvidence, mappedFigure)).toThrow(/valid uploaded evidence image/i);
  });
});
