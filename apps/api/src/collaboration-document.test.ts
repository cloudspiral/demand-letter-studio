import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { GeneratedDraft } from "@steno/contracts";
import { draftFromCollaborationDocument, validateCollaborativeDraft } from "./collaboration-document";

const base: GeneratedDraft = {
  title: "Demand",
  matterName: "Sample matter",
  fields: {},
  warnings: [],
  sections: [{
    id: "facts",
    heading: "Facts",
    blocks: [{
      id: "medical-total",
      kind: "paragraph",
      text: "The documented charges total $12,500.00.",
      templateParagraphIndex: 7,
      citations: [{ sourceId: "11111111-1111-4111-8111-111111111111", sourceName: "bill.pdf", page: 1, quote: "$12,500.00" }],
      verified: true,
    }],
  }],
};

function collaborative(text: string, amount = "$12,500.00") {
  const document = new Y.Doc();
  const metadata = document.getMap("steno");
  metadata.set("title", base.title);
  metadata.set("matterName", base.matterName);
  metadata.set("fields", JSON.stringify(base.fields));
  metadata.set("warnings", JSON.stringify(base.warnings));
  const fragment = document.getXmlFragment("default");
  const heading = new Y.XmlElement("heading");
  heading.setAttribute("stenoRole", "section-heading");
  heading.setAttribute("sectionId", "facts");
  heading.insert(0, [new Y.XmlText("Facts")]);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.setAttribute("stenoRole", "draft-block");
  paragraph.setAttribute("sectionId", "facts");
  paragraph.setAttribute("blockId", "medical-total");
  paragraph.setAttribute("blockKind", "paragraph");
  paragraph.setAttribute("templateParagraphIndex", "7");
  paragraph.setAttribute("citations", JSON.stringify(base.sections[0]!.blocks[0]!.citations));
  paragraph.setAttribute("verified", "true");
  paragraph.setAttribute("originalText", base.sections[0]!.blocks[0]!.text);
  paragraph.insert(0, [new Y.XmlText(text)]);
  fragment.insert(0, [heading, paragraph]);
  return { document, amount };
}

describe("canonical collaboration documents", () => {
  it("round-trips evidence and template metadata from Yjs", () => {
    const { document } = collaborative(base.sections[0]!.blocks[0]!.text);
    expect(draftFromCollaborationDocument(document, base)).toEqual(base);
  });

  it("anchors immutable evidence and Word mappings to the persisted draft", () => {
    const { document } = collaborative(base.sections[0]!.blocks[0]!.text);
    document.getMap("steno").set("title", "Forged title");
    const paragraph = document.getXmlFragment("default").toArray()[1] as Y.XmlElement;
    paragraph.setAttribute("templateParagraphIndex", "999");
    paragraph.setAttribute("citations", "[]");
    paragraph.setAttribute("originalText", "Forged original text");

    const content = draftFromCollaborationDocument(document, base);
    expect(content.title).toBe(base.title);
    expect(content.sections[0]!.blocks[0]).toEqual(base.sections[0]!.blocks[0]);
  });

  it("warns on edited citations and blocks a changed unsupported amount", () => {
    const { document } = collaborative("The documented charges total $21,500.00.");
    const content = draftFromCollaborationDocument(document, base);
    const { report } = validateCollaborativeDraft(document, content, [{
      sourceId: base.sections[0]!.blocks[0]!.citations[0]!.sourceId,
      sourceName: "bill.pdf",
      page: 1,
      text: "Amount due: $12,500.00",
    }]);
    expect(report.status).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["edited-citation", "unsupported-value"]));
  });

  it("blocks duplicate mappings to one Word-template paragraph", () => {
    const { document } = collaborative(base.sections[0]!.blocks[0]!.text);
    const duplicate = new Y.XmlElement("paragraph");
    duplicate.setAttribute("stenoRole", "draft-block");
    duplicate.setAttribute("sectionId", "facts");
    duplicate.setAttribute("blockId", "duplicate-medical-total");
    duplicate.setAttribute("blockKind", "paragraph");
    duplicate.setAttribute("templateParagraphIndex", "7");
    duplicate.setAttribute("citations", "[]");
    duplicate.setAttribute("verified", "false");
    duplicate.setAttribute("originalText", "Additional review language.");
    duplicate.insert(0, [new Y.XmlText("Additional review language.")]);
    document.getXmlFragment("default").insert(2, [duplicate]);

    const content = draftFromCollaborationDocument(document, base);
    const { report } = validateCollaborativeDraft(document, content, []);
    expect(report.status).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toContain("duplicate-template-mapping");
  });
});
