import tempfile
import unittest
import zipfile
from pathlib import Path

from lxml import etree

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


def make_docx(path: Path, document: bytes = DOCUMENT) -> None:
    with zipfile.ZipFile(path, "w") as package:
        package.writestr("[Content_Types].xml", CONTENT_TYPES)
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

    def test_extracts_names_amounts_and_dates_with_page_lineage(self):
        facts = _extract_facts([{"page": 2, "text": "Patient: Jordan Canary\nDate of Service: 08/12/2026\nTotal Charges: $12,345.67"}])
        self.assertIn(("person", "Jordan Canary", 2), [(fact["kind"], fact["value"], fact["page"]) for fact in facts])
        self.assertIn(("date", "08/12/2026", 2), [(fact["kind"], fact["value"], fact["page"]) for fact in facts])
        self.assertIn(("amount", "$12,345.67", 2), [(fact["kind"], fact["value"], fact["page"]) for fact in facts])


if __name__ == "__main__":
    unittest.main()
