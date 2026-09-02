import io
import tempfile
import unittest
import zipfile
from pathlib import Path

from lxml import etree
from PIL import Image

from worker import DocumentError, _extract_facts, analyze_template, export_docx


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


def make_docx(path: Path, document: bytes = DOCUMENT, document_rels: bytes | None = None) -> None:
    with zipfile.ZipFile(path, "w") as package:
        package.writestr("[Content_Types].xml", CONTENT_TYPES)
        if document_rels is not None:
            package.writestr("word/_rels/document.xml.rels", document_rels)
        package.writestr("word/document.xml", document)
        package.writestr("word/styles.xml", STYLES)
        package.writestr("word/header1.xml", HEADER)
        package.writestr("word/media/immutable.png", b"preserve-me")


class DocumentWorkerTests(unittest.TestCase):
    def test_classifies_heading_and_case_specific_regions(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "template.docx"
            make_docx(source)
            analysis = analyze_template(str(source))
            self.assertEqual(analysis["paragraphCount"], 3)
            self.assertEqual(analysis["regions"][0]["role"], "heading")
            self.assertEqual(analysis["regions"][1]["role"], "editable")
            self.assertEqual(analysis["replacementCandidates"][0]["value"], "999999")

    def test_rejects_existing_tracked_changes(self):
        tracked = DOCUMENT.replace(b"<w:r><w:rPr>", b"<w:ins><w:r><w:rPr>").replace(
            b"</w:r></w:p>\n    <w:p><w:r><w:t>Reusable", b"</w:r></w:ins></w:p>\n    <w:p><w:r><w:t>Reusable", 1
        )
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "tracked.docx"
            make_docx(source, tracked)
            with self.assertRaisesRegex(DocumentError, "tracked changes"):
                analyze_template(str(source))

    def test_preserves_split_settlement_boilerplate_after_terms_marker(self):
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

    def test_exposes_only_split_deadline_time_as_a_body_field(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "deadline-template.docx"
            output = Path(directory) / "deadline-output.docx"
            make_docx(source, DEADLINE_DOCUMENT)

            analysis = analyze_template(str(source))
            self.assertEqual(analysis["analysisVersion"], 3)
            self.assertIn({
                "value": "12:00 p.m. PST",
                "location": "word/document.xml",
                "kind": "date",
            }, analysis["replacementCandidates"])
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
            self.assertEqual(analysis["regions"][0]["confidence"], 1.0)

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
                "paragraphIndex": 0,
                "relationshipId": "rId9",
                "partName": "word/media/immutable.png",
                "contentType": "image/png",
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

    def test_extracts_names_amounts_and_dates_with_page_lineage(self):
        facts = _extract_facts([{"page": 2, "text": "Patient: Jordan Canary\nDate of Service: 08/12/2026\nTotal Charges: $12,345.67"}])
        self.assertIn(("person", "Jordan Canary", 2), [(fact["kind"], fact["value"], fact["page"]) for fact in facts])
        self.assertIn(("date", "08/12/2026", 2), [(fact["kind"], fact["value"], fact["page"]) for fact in facts])
        self.assertIn(("amount", "$12,345.67", 2), [(fact["kind"], fact["value"], fact["page"]) for fact in facts])


if __name__ == "__main__":
    unittest.main()
