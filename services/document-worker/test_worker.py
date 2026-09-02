import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from lxml import etree
from PIL import Image
from pypdf import PdfWriter

from worker import DocumentError, analyze_template, export_docx, extract_source


DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>TIME-LIMITED POLICY LIMITS DEMAND</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Mr. Canary has medical expenses of $9,999.00.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Reusable settlement boilerplate.</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
  </w:body>
</w:document>'''

STYLES = b'''<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'''
CONTENT_TYPES = b'''<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'''
HEADER = b'''<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Claim Number: 999999 - Demand</w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p></w:hdr>'''
COMPLEX_DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE \\@ "MMMM d, yyyy" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>May 29, 2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>
    <w:p><w:bookmarkStart w:id="0" w:name="claim"/><w:r><w:rPr><w:b/></w:rPr><w:t>Claim Number:</w:t></w:r><w:r><w:tab/></w:r><w:bookmarkEnd w:id="0"/><w:r><w:rPr><w:i/></w:rPr><w:t>OLD-1</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Sent via email: </w:t></w:r><w:hyperlink r:id="rId8"><w:r><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr><w:t>old@example.com</w:t></w:r></w:hyperlink></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
  </w:body>
</w:document>'''
DOCUMENT_RELS = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="mailto:old@example.com" TargetMode="External"/></Relationships>'''
IMAGE_DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body><w:p><w:r><w:drawing><a:blip r:embed="rId9"/></w:drawing></w:r></w:p><w:p><w:r><w:t>Photograph 1: old vehicle.</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>'''
IMAGE_RELS = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/immutable.png"/></Relationships>'''
DEADLINE_DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>This offer is subject to you complying with the following express terms and conditions:</w:t></w:r></w:p>
    <w:p><w:r><w:t>This offer expires unless accepted by October 15, 2026, </w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">at 12:00 p.m. PST. Acceptance requires complete compliance.</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
  </w:body>
</w:document>'''
TABLE_DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Medical expenses</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Old provider</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$9,999.00</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:sectPr/>
  </w:body>
</w:document>'''
NARRATIVE_DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>FACTS</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t>Old narrative one.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr><w:r><w:t>Old narrative two.</w:t></w:r></w:p>
    <w:p><w:r><w:t>Reusable tail.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>'''
PARAGRAPH_EXPENSE_DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>MEDICAL EXPENSES</w:t></w:r></w:p>
    <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr><w:r><w:t>Old Hospital:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>$9,000.00</w:t></w:r></w:p>
    <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Total:</w:t></w:r><w:r><w:tab/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>$9,000.00</w:t></w:r></w:p>
    <w:p><w:r><w:t>Reusable tail.</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>'''
FULL_TABLE_DOCUMENT = b'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tblGrid><w:gridCol w:w="6000"/><w:gridCol w:w="3000"/></w:tblGrid>
      <w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Provider</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Amount</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Old Hospital</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$9,000</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Total</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>$9,000</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>Reusable tail.</w:t></w:r></w:p><w:sectPr/>
  </w:body>
</w:document>'''


def make_docx(path: Path, document: bytes = DOCUMENT, document_rels: bytes | None = None) -> None:
    with zipfile.ZipFile(path, "w") as package:
        package.writestr("[Content_Types].xml", CONTENT_TYPES)
        if document_rels is not None:
            package.writestr("word/_rels/document.xml.rels", document_rels)
        package.writestr("word/document.xml", document)
        package.writestr("word/styles.xml", STYLES)
        package.writestr("word/header1.xml", HEADER)
        package.writestr("word/media/immutable.png", b"preserve-me")


class FixtureOcrProvider:
    def extract(self, _image_bytes: bytes):
        return {
            "text": "Patient: Jordan Canary\nTotal Charges: $12,345.67",
            "confidence": 0.97,
            "geometry": [{"text": "Total Charges: $12,345.67", "confidence": 0.97, "boundingBox": {"Top": 0.2}}],
            "structuredData": {"tables": [{"rows": 1, "columns": 2, "cells": [{"row": 1, "column": 2, "text": "$12,345.67"}]}]},
        }


class DocumentWorkerTests(unittest.TestCase):
    @staticmethod
    def operation_anchor(block):
        return {
            "blockId": block["id"],
            "partName": block["anchor"]["partName"],
            "paragraphIndex": block["paragraphIndex"],
            "structuredGroup": block.get("structuredGroup"),
            "figure": block.get("figure"),
        }

    def test_extracts_exact_structure_without_semantic_regex_classification(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "template.docx"
            make_docx(source)
            analysis = analyze_template(str(source))
            self.assertEqual(analysis["paragraphCount"], 3)
            self.assertTrue(all(region["needsAttention"] for region in analysis["regions"]))
            self.assertTrue(all(region["confidence"] == 0 for region in analysis["regions"]))
            self.assertEqual(analysis["regions"][1]["text"], "Mr. Canary has medical expenses of $9,999.00.")
            self.assertEqual(analysis["regions"][1]["anchor"]["partName"], "word/document.xml")
            self.assertEqual(analysis["replacementCandidates"], [])
            self.assertTrue(any(block["anchor"]["kind"] == "header" for block in analysis["blocks"]))

    def test_rejects_existing_tracked_changes(self):
        tracked = DOCUMENT.replace(b"<w:r><w:rPr>", b"<w:ins><w:r><w:rPr>").replace(
            b"</w:r></w:p>\n    <w:p><w:r><w:t>Reusable", b"</w:r></w:ins></w:p>\n    <w:p><w:r><w:t>Reusable", 1
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "tracked.docx"
            make_docx(source, tracked)
            with self.assertRaisesRegex(DocumentError, "tracked changes"):
                analyze_template(str(source))

    def test_does_not_apply_deterministic_boilerplate_rules(self):
        boilerplate = DOCUMENT.replace(
            b"Mr. Canary has medical expenses of $9,999.00.",
            b"This offer is subject to you complying with the following express terms and conditions:",
        ).replace(
            b"Reusable settlement boilerplate.",
            b"must provide written proof that any asserted lien has been legally perfected.",
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "boilerplate.docx"
            make_docx(source, boilerplate)
            analysis = analyze_template(str(source))
            self.assertEqual(analysis["regions"][1]["role"], "preserve")
            self.assertEqual(analysis["regions"][2]["role"], "preserve")
            self.assertEqual(analysis["regions"][1]["explanation"], "Awaiting model template analysis.")
            self.assertTrue(analysis["regions"][2]["needsAttention"])

    def test_export_can_patch_a_user_confirmed_inline_deadline_field(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "deadline-template.docx"
            output = Path(directory) / "deadline-output.docx"
            make_docx(source, DEADLINE_DOCUMENT)

            analysis = analyze_template(str(source))
            self.assertEqual(analysis["analysisVersion"], 5)
            self.assertEqual(analysis["replacementCandidates"], [])
            self.assertEqual(analysis["regions"][2]["role"], "preserve")

            export_docx({
                "templatePath": str(source),
                "outputPath": str(output),
                "patches": [{
                    "paragraphIndex": 1,
                    "text": "This offer expires unless accepted by October 15, 2026, ",
                }],
                "fieldReplacements": {"12:00 p.m. PST": "5:00 p.m. Pacific Time"},
            })
            with zipfile.ZipFile(output) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                text = " ".join(root.xpath("//w:body/w:p//w:t/text()", namespaces={
                    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                }))
                self.assertIn("at 5:00 p.m. Pacific Time. Acceptance requires", text)
                self.assertNotIn("12:00 p.m. PST", text)

    def test_export_patches_text_and_preserves_opaque_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "template.docx"
            output = Path(directory) / "output.docx"
            make_docx(source)
            result = export_docx({"templatePath": str(source), "outputPath": str(output), "patches": [{"paragraphIndex": 1, "text": "Canary-safe replacement."}], "fieldReplacements": {"999999": "123456"}})
            self.assertEqual(result["patchCount"], 1)
            with zipfile.ZipFile(output) as package:
                self.assertEqual(package.read("word/media/immutable.png"), b"preserve-me")
                root = etree.fromstring(package.read("word/document.xml"))
                text = "".join(root.xpath("//w:body/w:p[2]//w:t/text()", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}))
                self.assertEqual(text, "Canary-safe replacement.")
                header = package.read("word/header1.xml")
                self.assertIn(b"Claim Number: 123456", header)
                self.assertIn(b"fldSimple", header)

    def test_export_patches_a_confirmed_header_block_by_part_and_anchor(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "template.docx"
            output = Path(directory) / "output.docx"
            make_docx(source)
            result = export_docx({
                "templatePath": str(source),
                "outputPath": str(output),
                "patches": [{
                    "partName": "word/header1.xml",
                    "paragraphIndex": 0,
                    "text": "Claim Number: NEW-123 - Demand",
                }],
                "fieldReplacements": {},
            })
            self.assertEqual(result["patchCount"], 1)
            with zipfile.ZipFile(output) as package:
                header = etree.fromstring(package.read("word/header1.xml"))
                text = "".join(header.xpath("//w:t/text()", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}))
                self.assertEqual(text, "Claim Number: NEW-123 - Demand")
                self.assertTrue(header.xpath("//w:fldSimple", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}))

    def test_uses_one_stable_sequence_for_body_and_table_cell_slots(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "table-template.docx"
            output = Path(directory) / "table-output.docx"
            make_docx(source, TABLE_DOCUMENT)
            analysis = analyze_template(str(source))
            self.assertEqual(analysis["paragraphCount"], 3)
            self.assertEqual([block["anchor"]["kind"] for block in analysis["regions"]], ["paragraph", "table-cell", "table-cell"])
            export_docx({
                "templatePath": str(source),
                "outputPath": str(output),
                "patches": [{"paragraphIndex": 2, "text": "$12,345.67"}],
                "fieldReplacements": {},
            })
            with zipfile.ZipFile(output) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                table_text = "".join(root.xpath("//w:tbl//w:t/text()", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}))
                self.assertEqual(table_text, "Old provider$12,345.67")

    def test_export_keeps_untouched_xml_parts_byte_identical(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "template.docx"
            output = Path(directory) / "output.docx"
            make_docx(source)
            export_docx({"templatePath": str(source), "outputPath": str(output), "patches": [], "fieldReplacements": {"not-present": "replacement"}})
            with zipfile.ZipFile(source) as original, zipfile.ZipFile(output) as exported:
                self.assertEqual(exported.read("word/document.xml"), original.read("word/document.xml"))
                self.assertEqual(exported.read("word/header1.xml"), original.read("word/header1.xml"))
                self.assertEqual(exported.read("word/styles.xml"), original.read("word/styles.xml"))

    def test_preserves_fields_bookmarks_run_styles_and_hyperlink_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "complex-template.docx"
            output = Path(directory) / "complex-output.docx"
            make_docx(source, COMPLEX_DOCUMENT, DOCUMENT_RELS)

            analysis = analyze_template(str(source))
            self.assertEqual(analysis["regions"][0]["role"], "preserve")
            self.assertEqual(analysis["regions"][0]["confidence"], 0.0)

            export_docx({
                "templatePath": str(source),
                "outputPath": str(output),
                "patches": [
                    {"paragraphIndex": 1, "text": "Claim Number: NEW-987"},
                    {"paragraphIndex": 2, "text": "Sent via email: new@example.com"},
                ],
                "fieldReplacements": {},
            })

            with zipfile.ZipFile(output) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                namespaces = {
                    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
                    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
                }
                paragraphs = root.xpath("//w:body/w:p", namespaces=namespaces)
                self.assertEqual("".join(paragraphs[0].xpath(".//w:t/text()", namespaces=namespaces)), "May 29, 2026")
                self.assertTrue(paragraphs[0].xpath(".//w:instrText", namespaces=namespaces))
                self.assertTrue(paragraphs[1].xpath("./w:bookmarkStart | ./w:bookmarkEnd", namespaces=namespaces))
                self.assertEqual(
                    "".join(paragraphs[1].xpath(".//w:r[w:rPr/w:b]/w:t/text()", namespaces=namespaces)),
                    "Claim Number:",
                )
                self.assertEqual(
                    "".join(paragraphs[1].xpath(".//w:r[w:rPr/w:i]/w:t/text()", namespaces=namespaces)),
                    "NEW-987",
                )
                self.assertEqual(
                    "".join(paragraphs[2].xpath(".//w:hyperlink//w:t/text()", namespaces=namespaces)),
                    "new@example.com",
                )
                relationships = etree.fromstring(package.read("word/_rels/document.xml.rels"))
                target = relationships.xpath(
                    "string(//*[local-name()='Relationship' and @Id='rId8']/@Target)"
                )
                self.assertEqual(target, "mailto:new@example.com")

    def test_tabular_value_only_replacement_preserves_label_tabs_and_styles(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "complex-template.docx"
            output = Path(directory) / "complex-output.docx"
            make_docx(source, COMPLEX_DOCUMENT, DOCUMENT_RELS)

            export_docx({
                "templatePath": str(source),
                "outputPath": str(output),
                "patches": [{"paragraphIndex": 1, "text": "NEW-987"}],
                "fieldReplacements": {},
            })

            with zipfile.ZipFile(output) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
                paragraph = root.xpath("//w:body/w:p", namespaces=namespaces)[1]
                self.assertEqual("".join(paragraph.xpath(".//w:t/text()", namespaces=namespaces)), "Claim Number:NEW-987")
                self.assertTrue(paragraph.xpath(".//w:tab", namespaces=namespaces))
                self.assertTrue(paragraph.xpath("./w:bookmarkStart | ./w:bookmarkEnd", namespaces=namespaces))
                self.assertEqual(
                    "".join(paragraph.xpath(".//w:r[w:rPr/w:b]/w:t/text()", namespaces=namespaces)),
                    "Claim Number:",
                )
                self.assertEqual(
                    "".join(paragraph.xpath(".//w:r[w:rPr/w:i]/w:t/text()", namespaces=namespaces)),
                    "NEW-987",
                )

    def test_identifies_and_replaces_only_the_body_image_media_part(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "image-template.docx"
            output = Path(directory) / "image-output.docx"
            replacement = Path(directory) / "replacement.jpg"
            make_docx(source, IMAGE_DOCUMENT, IMAGE_RELS)
            Image.new("RGB", (32, 20), (17, 91, 203)).save(replacement, format="JPEG")

            analysis = analyze_template(str(source))
            self.assertEqual(analysis["imageCandidates"], [{
                "blockId": "word/document.xml:figure:rId9",
                "paragraphIndex": 0,
                "relationshipId": "rId9",
                "partName": "word/media/immutable.png",
                "contentType": "image/png",
                "captionBlockId": "word/document.xml:p:1",
            }])
            result = export_docx({
                "templatePath": str(source),
                "outputPath": str(output),
                "patches": [{"paragraphIndex": 1, "text": "Photograph 1: replacement vehicle."}],
                "fieldReplacements": {},
                "imageReplacements": [{
                    "partName": "word/media/immutable.png",
                    "sourcePath": str(replacement),
                }],
            })
            self.assertEqual(result["imagePatchCount"], 1)
            with zipfile.ZipFile(output) as package:
                with Image.open(io.BytesIO(package.read("word/media/immutable.png"))) as image:
                    self.assertEqual(image.format, "PNG")
                    self.assertEqual(image.size, (32, 20))
                self.assertEqual(package.read("word/styles.xml"), STYLES)

    def test_target_operations_expand_and_contract_narrative_runs_using_exemplar_styles(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "narrative-template.docx"
            expanded = Path(directory) / "narrative-expanded.docx"
            contracted = Path(directory) / "narrative-contracted.docx"
            make_docx(source, NARRATIVE_DOCUMENT)
            analysis = analyze_template(str(source))
            narrative_blocks = analysis["regions"][1:3]
            anchors = [self.operation_anchor(block) for block in narrative_blocks]
            export_docx({
                "templatePath": str(source), "outputPath": str(expanded), "patches": [], "fieldReplacements": {},
                "targetOperations": [{
                    "targetId": "narrative-1", "kind": "narrative", "status": "generated", "anchors": anchors,
                    "paragraphs": ["Generated one.", "Generated two.", "Generated three."],
                }],
            })
            export_docx({
                "templatePath": str(source), "outputPath": str(contracted), "patches": [], "fieldReplacements": {},
                "targetOperations": [{
                    "targetId": "narrative-1", "kind": "narrative", "status": "generated", "anchors": anchors,
                    "paragraphs": ["Only supported paragraph."],
                }],
            })
            namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            with zipfile.ZipFile(expanded) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                paragraphs = root.xpath("//w:body/w:p", namespaces=namespaces)
                self.assertEqual(["".join(p.xpath(".//w:t/text()", namespaces=namespaces)) for p in paragraphs], [
                    "FACTS", "Generated one.", "Generated two.", "Generated three.", "Reusable tail.",
                ])
                self.assertTrue(paragraphs[3].xpath("./w:pPr/w:pStyle[@w:val='BodyText']", namespaces=namespaces))
            with zipfile.ZipFile(contracted) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                text = ["".join(p.xpath(".//w:t/text()", namespaces=namespaces)) for p in root.xpath("//w:body/w:p", namespaces=namespaces)]
                self.assertEqual(text, ["FACTS", "Only supported paragraph.", "Reusable tail."])

    def test_target_operations_rebuild_paragraph_expense_rows_and_remove_the_optional_group(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "paragraph-expenses.docx"
            generated = Path(directory) / "paragraph-expenses-generated.docx"
            omitted = Path(directory) / "paragraph-expenses-omitted.docx"
            make_docx(source, PARAGRAPH_EXPENSE_DOCUMENT)
            analysis = analyze_template(str(source))
            group_blocks = [block for block in analysis["regions"] if block.get("structuredGroup")]
            self.assertEqual(len(group_blocks), 3)
            anchors = [self.operation_anchor(block) for block in group_blocks]
            base = {"templatePath": str(source), "patches": [], "fieldReplacements": {}}
            export_docx({**base, "outputPath": str(generated), "targetOperations": [{
                "targetId": "structured-1", "kind": "structured", "status": "generated", "anchors": anchors,
                "rows": [
                    {"role": "body", "cells": ["Canary Hospital", "$12,000.00"]},
                    {"role": "body", "cells": ["Canary Imaging", "$345.67"]},
                    {"role": "total", "cells": ["Total", "$12,345.67"]},
                ],
            }]})
            export_docx({**base, "outputPath": str(omitted), "targetOperations": [{
                "targetId": "structured-1", "kind": "structured", "status": "omitted_no_evidence", "anchors": anchors,
            }]})
            namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            with zipfile.ZipFile(generated) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                paragraphs = root.xpath("//w:body/w:p", namespaces=namespaces)
                text = ["".join(p.xpath(".//w:t/text()", namespaces=namespaces)) for p in paragraphs]
                self.assertEqual(text[1:4], ["Canary Hospital:$12,000.00", "Canary Imaging:$345.67", "Total:$12,345.67"])
                self.assertTrue(paragraphs[3].xpath(".//w:rPr/w:b", namespaces=namespaces))
                self.assertTrue(all(p.xpath("./w:pPr/w:tabs/w:tab", namespaces=namespaces) for p in paragraphs[1:4]))
            with zipfile.ZipFile(omitted) as package:
                text = package.read("word/document.xml")
                self.assertNotIn(b"Old Hospital", text)
                self.assertNotIn(b"$9,000.00", text)
                self.assertNotIn(b"MEDICAL EXPENSES", text)
                self.assertIn(b"Reusable tail", text)

    def test_target_operations_preserve_word_table_shell_and_total_style_or_remove_the_table(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "table-template.docx"
            generated = Path(directory) / "table-generated.docx"
            omitted = Path(directory) / "table-omitted.docx"
            make_docx(source, FULL_TABLE_DOCUMENT)
            analysis = analyze_template(str(source))
            table_blocks = [block for block in analysis["regions"] if block.get("structuredGroup")]
            anchors = [self.operation_anchor(block) for block in table_blocks]
            base = {"templatePath": str(source), "patches": [], "fieldReplacements": {}}
            export_docx({**base, "outputPath": str(generated), "targetOperations": [{
                "targetId": "table-1", "kind": "structured", "status": "generated", "anchors": anchors,
                "rows": [
                    {"role": "body", "cells": ["Canary Hospital", "$12,000"]},
                    {"role": "body", "cells": ["Canary Imaging", "$345.67"]},
                    {"role": "total", "cells": ["Total", "$12,345.67"]},
                ],
            }]})
            export_docx({**base, "outputPath": str(omitted), "targetOperations": [{
                "targetId": "table-1", "kind": "structured", "status": "omitted_not_applicable", "anchors": anchors,
            }]})
            namespaces = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            with zipfile.ZipFile(generated) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                rows = root.xpath("//w:tbl/w:tr", namespaces=namespaces)
                self.assertEqual(len(rows), 4)
                self.assertEqual("".join(rows[0].xpath(".//w:t/text()", namespaces=namespaces)), "ProviderAmount")
                self.assertEqual("".join(rows[-1].xpath(".//w:t/text()", namespaces=namespaces)), "Total$12,345.67")
                self.assertTrue(rows[-1].xpath(".//w:rPr/w:b", namespaces=namespaces))
                self.assertTrue(root.xpath("//w:tblGrid/w:gridCol[@w:w='6000']", namespaces=namespaces))
            with zipfile.ZipFile(omitted) as package:
                root = etree.fromstring(package.read("word/document.xml"))
                self.assertFalse(root.xpath("//w:tbl", namespaces=namespaces))
                self.assertIn(b"Reusable tail", package.read("word/document.xml"))

    def test_target_operations_replace_or_remove_a_figure_and_its_caption(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "figure-template.docx"
            generated = Path(directory) / "figure-generated.docx"
            omitted = Path(directory) / "figure-omitted.docx"
            replacement = Path(directory) / "replacement.jpg"
            make_docx(source, IMAGE_DOCUMENT, IMAGE_RELS)
            Image.new("RGB", (40, 24), (31, 122, 72)).save(replacement, format="JPEG")
            analysis = analyze_template(str(source))
            figure = next(block for block in analysis["regions"] if block["semanticKind"] == "figure")
            anchor = self.operation_anchor(figure)
            base = {"templatePath": str(source), "patches": [], "fieldReplacements": {}}
            export_docx({**base, "outputPath": str(generated), "targetOperations": [{
                "targetId": "figure-1", "kind": "figure", "status": "generated", "anchors": [anchor],
                "sourcePath": str(replacement), "caption": "Photograph: documented rear-impact damage.",
            }]})
            export_docx({**base, "outputPath": str(omitted), "targetOperations": [{
                "targetId": "figure-1", "kind": "figure", "status": "omitted_no_evidence", "anchors": [anchor],
            }]})
            with zipfile.ZipFile(generated) as package:
                with Image.open(io.BytesIO(package.read("word/media/immutable.png"))) as image:
                    self.assertEqual(image.size, (40, 24))
                self.assertIn(b"documented rear-impact damage", package.read("word/document.xml"))
                self.assertEqual(package.read("word/header1.xml"), HEADER)
            with zipfile.ZipFile(omitted) as package:
                document = package.read("word/document.xml")
                root = etree.fromstring(document)
                self.assertFalse(root.xpath("//w:drawing", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}))
                self.assertNotIn(b"Photograph 1", document)
                self.assertEqual(package.read("word/media/immutable.png"), b"preserve-me")

    def test_ocr_preserves_amounts_geometry_tables_and_never_creates_regex_facts(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "bill.png"
            Image.new("RGB", (200, 100), "white").save(source, format="PNG")
            extraction = extract_source(str(source), "image/png", FixtureOcrProvider())
            self.assertEqual(extraction["pages"][0]["extractionMethod"], "ocr")
            self.assertIn("$12,345.67", extraction["pages"][0]["text"])
            self.assertEqual(extraction["pages"][0]["confidence"], 0.97)
            self.assertEqual(extraction["pages"][0]["structuredData"]["tables"][0]["cells"][0]["text"], "$12,345.67")
            self.assertEqual(extraction["facts"], [])

    def test_scanned_page_without_configured_ocr_is_visible_and_not_authoritative(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "scan.pdf"
            writer = PdfWriter()
            writer.add_blank_page(width=612, height=792)
            with source.open("wb") as output:
                writer.write(output)
            extraction = extract_source(str(source), "application/pdf")
            self.assertEqual(extraction["pages"][0]["extractionStatus"], "ocr-required")
            self.assertEqual(extraction["pages"][0]["text"], "")
            self.assertTrue(extraction["pages"][0]["visualInput"])
            self.assertEqual(extraction["pages"][0]["visualMimeType"], "image/png")
            self.assertTrue(extraction["pages"][0]["visualDataBase64"])


if __name__ == "__main__":
    unittest.main()
