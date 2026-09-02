import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAiProvider } from "./ai";

describe("completed-letter leakage canary", () => {
  it("uses mutated evidence without copying the prior claimant or amount", async () => {
    const evidenceText = await readFile(path.resolve("../../tests/fixtures/canary-evidence.txt"), "utf8");
    const sourceId = "10000000-0000-4000-8000-000000000099";
    const draft = await createAiProvider("mock").generate({
      matterName: "Jordan Canary matter",
      template: {
        analysisVersion: 2,
        filename: "completed-old-case.docx", paragraphCount: 1, sectionCount: 1,
        hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
        replacementCandidates: [],
        imageCandidates: [],
        regions: [{
          paragraphIndex: 8, text: "Patrick Donahue incurred $3,500.00.", role: "editable",
          semanticKind: "prose", section: null, aiRecommendation: "replace", confidence: 1,
          style: null, structuredGroup: null, figure: null,
        }],
      },
      evidence: [{ sourceId, sourceName: "canary-evidence.txt", page: 1, text: evidenceText }],
    });
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toMatch(/Patrick|Pat Donahue|\$3,500\.00/);
    expect(draft.title).toBe("Demand letter");
  });
});
