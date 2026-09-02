import { describe, expect, it } from "vitest";
import {
  isLegacySyntheticTemplate,
  mergedTemplateProvenance,
  templateAnalysisFilename,
  templateDisplayName,
  testTemplateFromHeader,
} from "./template-metadata";

describe("template metadata", () => {
  it.each([
    ["Firm Demand Letter.docx", "Firm Demand Letter"],
    ["AAA Insurance - Time Limited Demand.docx", "AAA Insurance - Time Limited Demand"],
    ["synthetic-demand-template.docx", "synthetic demand template"],
    ["firm_template_v2.DOCX", "firm template v2"],
    [
      `${"a".repeat(64)}-AAA-Insurance---Time-Limited-Policy-Limits-Demand---Pat-Donahue.docx`,
      "AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue",
    ],
    [
      `${"a".repeat(64)}-${"b".repeat(64)}-Nested-Storage-Copy.docx`,
      "Nested Storage Copy",
    ],
  ])("normalizes %s", (filename, expected) => {
    expect(templateDisplayName(filename)).toBe(expected);
  });

  it("preserves an extremely long unbroken logical name for accessible display", () => {
    const name = "x".repeat(180);
    expect(templateDisplayName(`${name}.docx`)).toBe(name);
    expect(templateAnalysisFilename(name)).toBe(`${name}.docx`);
  });

  it("recognizes only the exact legacy fixture filename during backfill", () => {
    expect(isLegacySyntheticTemplate("synthetic-demand-template.docx")).toBe(true);
    expect(isLegacySyntheticTemplate("customer-synthetic-demand-template.docx")).toBe(false);
    expect(isLegacySyntheticTemplate("AAA Insurance.docx")).toBe(false);
  });

  it("requires explicit test provenance from the upload header", () => {
    expect(testTemplateFromHeader("true")).toBe(true);
    expect(testTemplateFromHeader("TRUE")).toBe(true);
    expect(testTemplateFromHeader(undefined)).toBe(false);
    expect(testTemplateFromHeader("false")).toBe(false);
    expect(testTemplateFromHeader(["true"])).toBe(false);
  });

  it("allows a firm upload to promote a test record", () => {
    expect(mergedTemplateProvenance(
      { name: "stored-test.docx", displayName: "Stored test", isTest: true },
      { name: "Firm Letter.docx", displayName: "Firm Letter", isTest: false },
    )).toEqual({ name: "Firm Letter.docx", displayName: "Firm Letter", isTest: false });
  });

  it("never lets automation demote or rename a firm record", () => {
    const firm = { name: "Firm Letter.docx", displayName: "Firm Letter", isTest: false };
    expect(mergedTemplateProvenance(firm, {
      name: `${"c".repeat(64)}-Firm-Letter.docx`,
      displayName: "Firm Letter",
      isTest: true,
    })).toEqual(firm);
  });
});
