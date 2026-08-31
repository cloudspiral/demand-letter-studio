#!/usr/bin/env python3
"""Deterministic document operations used by the local API and Lambda worker.

The model never touches OOXML. It supplies validated content; this module performs
bounded extraction and in-place package patches while retaining opaque parts.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from lxml import etree
from pypdf import PdfReader

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


class DocumentError(ValueError):
    pass


def _paragraph_text(paragraph: etree._Element) -> str:
    return "".join(paragraph.xpath(".//w:t/text()", namespaces=NS))


def _replace_paragraph_text(paragraph: etree._Element, text: str) -> None:
    direct_runs = paragraph.xpath("./w:r", namespaces=NS)
    first_rpr = None
    if direct_runs:
        rpr = direct_runs[0].find(f"{{{W}}}rPr")
        if rpr is not None:
            first_rpr = etree.fromstring(etree.tostring(rpr))
    for child in list(paragraph):
        if child.tag != f"{{{W}}}pPr":
            paragraph.remove(child)
    run = etree.SubElement(paragraph, f"{{{W}}}r")
    if first_rpr is not None:
        run.append(first_rpr)
    text_node = etree.SubElement(run, f"{{{W}}}t")
    if text.startswith(" ") or text.endswith(" "):
        text_node.set(XML_SPACE, "preserve")
    text_node.text = text


def _role_for(text: str, style: str | None) -> tuple[str, float]:
    stripped = text.strip()
    if not stripped:
        return "preserve", 1.0
    upper = stripped.upper()
    if (style or "").lower().startswith("heading") or (
        stripped == upper and any(ch.isalpha() for ch in stripped) and len(stripped) < 140
    ):
        return "heading", 0.94
    preserve_markers = (
        "SOCIAL SECURITY NUMBERS",
        "THIS OFFER IS SUBJECT",
        "STATUTORY LIEN",
        "SETTLEMENT CHECKS",
        "COMPLIANT RELEASE",
        "PURSUANT TO CODE",
        "A PURPORTED",
    )
    if any(marker in upper for marker in preserve_markers):
        return "preserve", 0.88
    case_markers = ("$", "MR. ", "MS. ", "CLAIM", "ACCIDENT", "COLLISION", "INJUR")
    if any(marker in upper for marker in case_markers) and len(stripped) > 30:
        return "editable", 0.78
    return "preserve", 0.58


def analyze_template(path: str) -> dict[str, Any]:
    source = Path(path)
    if source.suffix.lower() != ".docx":
        raise DocumentError("Only .docx templates are supported in v1.")
    if not zipfile.is_zipfile(source):
        raise DocumentError("The uploaded file is not a valid DOCX package.")
    with zipfile.ZipFile(source) as package:
        names = set(package.namelist())
        has_macros = "word/vbaProject.bin" in names or any("macroEnabled" in n for n in names)
        if has_macros:
            raise DocumentError("Macro-enabled Word templates are not accepted.")
        document_xml = package.read("word/document.xml")
        has_tracked = b"<w:ins" in document_xml or b"<w:del" in document_xml
        if has_tracked:
            raise DocumentError("Accept or reject existing tracked changes before importing this template.")
        has_complex = any(marker in document_xml for marker in (b"<w:txbxContent", b"<w:object", b"<v:shape"))
        root = etree.fromstring(document_xml)
        paragraphs = root.xpath("//w:body/w:p", namespaces=NS)
        regions = []
        for index, paragraph in enumerate(paragraphs):
            text = _paragraph_text(paragraph).strip()
            style_values = paragraph.xpath("./w:pPr/w:pStyle/@w:val", namespaces=NS)
            style = style_values[0] if style_values else None
            role, confidence = _role_for(text, style)
            if text:
                regions.append({
                    "paragraphIndex": index,
                    "text": text,
                    "role": role,
                    "confidence": confidence,
                    "style": style,
                })
        section_count = max(1, len(root.xpath("//w:sectPr", namespaces=NS)))
        warnings = []
        if has_complex:
            warnings.append("Complex positioned objects are preserved but cannot be selected as editable regions.")
        return {
            "filename": source.name,
            "paragraphCount": len(paragraphs),
            "sectionCount": section_count,
            "hasMacros": False,
            "hasTrackedChanges": False,
            "hasComplexObjects": has_complex,
            "warnings": warnings,
            "regions": regions,
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "packageParts": len(names),
        }


def _extract_facts(pages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    facts: list[dict[str, Any]] = []
    for page in pages:
        text = page["text"]
        for match in re.finditer(r"(?P<label>[A-Za-z][A-Za-z /&.-]{2,40}?)\s*[:\-]?\s*(?P<value>\$\s?\d[\d,]*(?:\.\d{2})?)", text):
            facts.append({"kind": "amount", "label": match.group("label").strip(), "value": match.group("value").replace(" ", ""), "page": page["page"], "confidence": 0.91})
        for match in re.finditer(r"(?im)^(?:patient(?: name)?|client|claimant)\s*[:\-]\s*(?P<value>[A-Z][A-Za-z' -]+)$", text):
            facts.append({"kind": "person", "label": "Patient", "value": match.group("value").strip(), "page": page["page"], "confidence": 0.94})
        for match in re.finditer(r"(?im)^(?P<label>date(?: of (?:service|loss|birth))?)\s*[:\-]\s*(?P<value>\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$", text):
            facts.append({"kind": "date", "label": match.group("label").title(), "value": match.group("value"), "page": page["page"], "confidence": 0.9})
    return facts


def extract_source(path: str, mime_type: str | None = None) -> dict[str, Any]:
    source = Path(path)
    mime = mime_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    pages: list[dict[str, Any]] = []
    if mime == "application/pdf" or source.suffix.lower() == ".pdf":
        reader = PdfReader(str(source))
        for index, page in enumerate(reader.pages):
            pages.append({"page": index + 1, "text": (page.extract_text() or "").strip()})
    elif mime.startswith("image/"):
        pages.append({"page": 1, "text": "[Image evidence: visual review required]"})
    else:
        raise DocumentError("Sources must be PDF or image files.")
    return {
        "filename": source.name,
        "mimeType": mime,
        "pageCount": len(pages),
        "pages": pages,
        "facts": _extract_facts(pages),
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    }


def export_docx(payload: dict[str, Any]) -> dict[str, Any]:
    source = Path(payload["templatePath"])
    output = Path(payload["outputPath"])
    patches = {int(item["paragraphIndex"]): str(item["text"]) for item in payload.get("patches", [])}
    replacements = {str(k): str(v) for k, v in payload.get("fieldReplacements", {}).items() if k and v}
    output.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(source) as zin, tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
        temp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(source) as zin, zipfile.ZipFile(temp_path, "w") as zout:
            for info in zin.infolist():
                data = zin.read(info.filename)
                if info.filename == "word/document.xml":
                    root = etree.fromstring(data)
                    paragraphs = root.xpath("//w:body/w:p", namespaces=NS)
                    for index, paragraph in enumerate(paragraphs):
                        original = _paragraph_text(paragraph)
                        updated = original
                        for old, new in replacements.items():
                            updated = updated.replace(old, new)
                        if index in patches:
                            updated = patches[index]
                        if updated != original:
                            _replace_paragraph_text(paragraph, updated)
                    settings = root.xpath("//w:settings", namespaces=NS)
                    data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
                zout.writestr(info, data)
        shutil.move(temp_path, output)
    finally:
        temp_path.unlink(missing_ok=True)

    with zipfile.ZipFile(output) as package:
        required = {"[Content_Types].xml", "word/document.xml", "word/styles.xml"}
        missing = sorted(required.difference(package.namelist()))
        if missing:
            raise DocumentError(f"Generated DOCX is missing required parts: {', '.join(missing)}")
    return {
        "path": str(output),
        "size": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "patchCount": len(patches),
    }


def dispatch(payload: dict[str, Any]) -> dict[str, Any]:
    operation = payload.get("operation")
    if operation == "analyze-template":
        return analyze_template(payload["path"])
    if operation == "extract-source":
        return extract_source(payload["path"], payload.get("mimeType"))
    if operation == "export-docx":
        return export_docx(payload)
    raise DocumentError(f"Unknown document operation: {operation}")


def main() -> None:
    try:
        payload = json.load(sys.stdin)
        print(json.dumps({"ok": True, "result": dispatch(payload)}))
    except Exception as exc:  # bounded CLI error contract
        print(json.dumps({"ok": False, "error": str(exc)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
