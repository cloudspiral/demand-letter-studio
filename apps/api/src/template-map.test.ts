import { describe, expect, it } from "vitest";
import {
  TemplateAnalysisSchema,
  TemplateMapSchema,
  TemplateRegionSchema,
  type TemplateAnalysis,
  type TemplateRegion,
} from "@steno/contracts";
import { analysisWithConfirmedMap, deriveGenerationTargets, validateConfirmedBlocks } from "./template-map";

const actorId = "00000000-0000-4000-8000-000000000101";

function region(overrides: Partial<TemplateRegion> & Pick<TemplateRegion, "paragraphIndex" | "text">): TemplateRegion {
  return TemplateRegionSchema.parse({
    id: `word/document.xml:p:${overrides.paragraphIndex}`,
    role: "preserve",
    semanticKind: "prose",
    section: "Facts",
    aiRecommendation: "keep",
    confidence: 0.94,
    style: "BodyText",
    explanation: "Mapped content.",
    needsAttention: false,
    anchor: {
      partName: "word/document.xml", kind: "paragraph",
      paragraphIndex: overrides.paragraphIndex, path: `/word/document.xml/paragraph[${overrides.paragraphIndex}]`,
    },
    structuredGroup: null,
    figure: null,
    inlineFields: [],
    ...overrides,
  });
}

function analysis(blocks: TemplateRegion[]): TemplateAnalysis {
  return TemplateAnalysisSchema.parse({
    analysisVersion: 5, filename: "original.docx", paragraphCount: blocks.length, sectionCount: 1,
    hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
    regions: blocks, blocks, replacementCandidates: [], knownCaseSpecificValues: [], imageCandidates: [],
  });
}

const heading = region({
  paragraphIndex: 0,
  text: "DEMAND FOR JORDAN CANARY",
  role: "heading",
  semanticKind: "heading",
  section: "DEMAND FOR JORDAN CANARY",
  inlineFields: [{
    key: "heading_client_name", label: "Client name", start: 11, end: 24, originalText: "JORDAN CANARY",
    kind: "person", confidence: 1, explanation: "Previous matter name.", source: "user", role: "replace",
  }],
});

describe("schema-v2 template maps", () => {
  it("preserves exact locked heading text while deriving its replaceable inline field", () => {
    const source = analysis([heading]);
    const blocks = validateConfirmedBlocks(source, [heading]);
    const map = TemplateMapSchema.parse({
      schemaVersion: 2, mapVersion: 1, templateHash: "a".repeat(64), analysisVersion: 5,
      blocks, confirmedBy: actorId, confirmedAt: new Date().toISOString(),
    });
    const confirmed = analysisWithConfirmedMap(source, map);
    expect(confirmed.replacementCandidates[0]).toMatchObject({
      fieldKey: "heading_client_name", value: "JORDAN CANARY", location: "word/document.xml",
    });
    expect(confirmed.blocks?.[0]).toMatchObject({ role: "heading", semanticKind: "heading" });
  });

  it("rejects altered originals, shifted anchors, unlocked headings, and invalid spans", () => {
    const source = analysis([heading]);
    expect(() => validateConfirmedBlocks(source, [{ ...heading, text: "Changed text", inlineFields: [] }])).toThrow(/immutable original/i);
    expect(() => validateConfirmedBlocks(source, [{ ...heading, role: "editable", semanticKind: "prose" }])).toThrow();
    expect(() => validateConfirmedBlocks(source, [{
      ...heading,
      inlineFields: [{ ...heading.inlineFields![0]!, start: 0, end: 6 }],
    }])).toThrow(/exact original template text/i);
  });

  it("derives elastic prose runs and breaks them at headings, Keep blocks, and style changes", () => {
    const blocks = [
      region({ paragraphIndex: 0, text: "Facts", role: "heading", semanticKind: "heading", section: "Facts" }),
      region({ paragraphIndex: 1, text: "Old fact one.", role: "editable", aiRecommendation: "replace" }),
      region({ paragraphIndex: 2, text: "Old fact two.", role: "editable", aiRecommendation: "replace" }),
      region({ paragraphIndex: 3, text: "Reusable bridge.", role: "preserve" }),
      region({ paragraphIndex: 4, text: "Old damage one.", role: "editable", aiRecommendation: "replace", style: "Indented" }),
      region({ paragraphIndex: 5, text: "Old damage two.", role: "editable", aiRecommendation: "replace", style: "BodyText" }),
    ];
    const targets = deriveGenerationTargets(analysis(blocks));
    expect(targets.map((target) => target.blockIds)).toEqual([
      ["word/document.xml:p:1", "word/document.xml:p:2"],
      ["word/document.xml:p:4"],
      ["word/document.xml:p:5"],
    ]);
    expect(targets[0]).toMatchObject({ kind: "narrative", exemplarCount: 2, maxItems: 12 });
  });

  it("derives one target for a complete structured group and one for a figure/caption pair", () => {
    const expense = {
      id: "expense-group", representation: "paragraph-rows" as const, rowRole: "body" as const,
      tableIndex: null, rowIndex: 0, cellIndex: null, columnCount: 2, columnWidths: [],
    };
    const blocks = [
      region({ paragraphIndex: 1, text: "Hospital\t$1,000", role: "editable", aiRecommendation: "replace", structuredGroup: expense }),
      region({ paragraphIndex: 2, text: "Total\t$1,000", role: "editable", aiRecommendation: "replace", structuredGroup: { ...expense, rowIndex: 1, rowRole: "total" } }),
      region({
        paragraphIndex: 3, text: "[figure]", role: "editable", semanticKind: "figure", aiRecommendation: "replace",
        figure: { relationshipId: "rId8", partName: "word/media/image1.png", contentType: "image/png", captionBlockId: "word/document.xml:p:4" },
      }),
      region({ paragraphIndex: 4, text: "Old vehicle photograph" }),
    ];
    const targets = deriveGenerationTargets(analysis(blocks));
    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({ kind: "structured", exemplarCount: 2, structuredGroupId: "expense-group" });
    expect(targets[1]).toMatchObject({ kind: "figure", blockIds: ["word/document.xml:p:3"] });
  });

  it("requires one decision across every member of a structured group", () => {
    const group = {
      id: "expenses", representation: "paragraph-rows" as const, rowRole: "body" as const,
      tableIndex: null, rowIndex: 0, cellIndex: null, columnCount: 2, columnWidths: [],
    };
    const first = region({ paragraphIndex: 1, text: "Hospital\t$1", role: "editable", structuredGroup: group });
    const second = region({ paragraphIndex: 2, text: "Total\t$1", structuredGroup: { ...group, rowIndex: 1, rowRole: "total" } });
    expect(() => validateConfirmedBlocks(analysis([first, second]), [first, second])).toThrow(/complete group/i);
  });
});
