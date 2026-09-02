#!/usr/bin/env python3
"""Deterministic document operations used by the local API and Lambda worker.

The model never touches OOXML. It supplies validated content; this module performs
bounded extraction and in-place package patches while retaining opaque parts.
"""

from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import os
import posixpath
import re
import shutil
import sys
import tempfile
import zipfile
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from lxml import etree
from PIL import Image, ImageOps
from pypdf import PdfReader

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": W, "r": R}
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
EMAIL_PATTERN = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
DEADLINE_TIME_PATTERN = re.compile(
    r"\b(\d{1,2}:\d{2}\s*(?:a|p)\.?m\.?\s*(?:PST|PDT|Pacific Time))\b",
    re.IGNORECASE,
)
Image.MAX_IMAGE_PIXELS = 50_000_000


class DocumentError(ValueError):
    pass


def _paragraph_text(paragraph: etree._Element) -> str:
    return "".join(paragraph.xpath(".//w:t/text()", namespaces=NS))


def _set_text_node(node: etree._Element, text: str) -> None:
    node.text = text
    if text.startswith(" ") or text.endswith(" "):
        node.set(XML_SPACE, "preserve")
    else:
        node.attrib.pop(XML_SPACE, None)


def _replace_tabular_paragraph_text(paragraph: etree._Element, text: str) -> bool:
    """Map reviewed text into the original tab-separated runs without flattening."""

    text_nodes = paragraph.xpath(".//w:t", namespaces=NS)
    meaningful_nodes = [
        node for node in text_nodes
        if (node.text or "").replace("\u00a0", " ").strip()
    ]
    label_matches = list(re.finditer(r"[^:]+:", text))
    if label_matches:
        pieces = [match.group(0).strip() for match in label_matches]
        tail = text[label_matches[-1].end():].strip()
        if tail:
            pieces.append(tail)
        if len(pieces) == len(meaningful_nodes):
            for node in text_nodes:
                _set_text_node(node, "")
            for node, piece in zip(meaningful_nodes, pieces, strict=True):
                _set_text_node(node, piece)
            return True

    if not meaningful_nodes:
        return False

    # Form-style legal templates commonly keep labels and values in separate
    # styled runs around tab stops. A reviewed value such as a claim number may
    # intentionally omit the repeated label. Preserve every label node and all
    # tab/bookmark structure, clear other old-case values, and place the new
    # value in the final styled text node.
    target = meaningful_nodes[-1]
    for node in text_nodes:
        original = (node.text or "").replace("\u00a0", " ").strip()
        if node is target:
            _set_text_node(node, text)
        elif original.endswith(":"):
            continue
        else:
            _set_text_node(node, "")
    return True


def _replace_paragraph_text(paragraph: etree._Element, text: str) -> None:
    """Replace visible text without flattening Word's run-level structure.

    The prior implementation deleted every run, hyperlink, bookmark and field
    child in the paragraph. That made the text deterministic but silently
    destroyed the formatting contract of production legal templates. This
    implementation retains every existing OOXML element and uses a character
    diff to assign changed text to the closest original text node/style.
    """

    if paragraph.xpath(".//w:drawing | .//w:object | .//w:pict", namespaces=NS):
        raise DocumentError("Cannot replace a paragraph containing an embedded object.")
    if paragraph.xpath(".//w:tab", namespaces=NS):
        if _replace_tabular_paragraph_text(paragraph, text):
            return
        raise DocumentError("Cannot safely map replacement text into a tab-separated template paragraph.")

    text_nodes = paragraph.xpath(".//w:t", namespaces=NS)
    if not text_nodes:
        run = etree.SubElement(paragraph, f"{{{W}}}r")
        text_node = etree.SubElement(run, f"{{{W}}}t")
        if text.startswith(" ") or text.endswith(" "):
            text_node.set(XML_SPACE, "preserve")
        text_node.text = text
        return

    original = "".join(node.text or "" for node in text_nodes)
    owner_by_character: list[int] = []
    for node_index, node in enumerate(text_nodes):
        owner_by_character.extend([node_index] * len(node.text or ""))

    chunks = [""] * len(text_nodes)
    matcher = SequenceMatcher(None, original, text, autojunk=False)
    for operation, old_start, old_end, new_start, new_end in matcher.get_opcodes():
        replacement = text[new_start:new_end]
        if operation == "equal":
            for offset, character in enumerate(replacement):
                chunks[owner_by_character[old_start + offset]] += character
            continue
        if operation == "delete":
            continue
        if old_start < len(owner_by_character):
            target_index = owner_by_character[old_start]
        elif owner_by_character:
            target_index = owner_by_character[-1]
        else:
            target_index = 0
        chunks[target_index] += replacement

    for node, chunk in zip(text_nodes, chunks, strict=True):
        _set_text_node(node, chunk)


def _hyperlink_replacements(paragraph: etree._Element, replacement: str) -> dict[str, str]:
    """Return relationship target updates for a changed mailto hyperlink."""

    hyperlinks = paragraph.xpath(".//w:hyperlink[@r:id]", namespaces=NS)
    replacement_emails = EMAIL_PATTERN.findall(replacement)
    if len(hyperlinks) != 1 or len(replacement_emails) != 1:
        return {}
    hyperlink = hyperlinks[0]
    original_emails = EMAIL_PATTERN.findall(_paragraph_text(hyperlink))
    if len(original_emails) != 1:
        return {}
    relationship_id = hyperlink.get(f"{{{R}}}id")
    if not relationship_id:
        return {}
    return {relationship_id: f"mailto:{replacement_emails[0]}"}


def _patch_relationship_targets(data: bytes, updates: dict[str, str]) -> bytes:
    if not updates:
        return data
    root = etree.fromstring(data)
    changed = False
    for relationship in root.findall(f"{{{PACKAGE_RELATIONSHIPS}}}Relationship"):
        relationship_id = relationship.get("Id")
        if relationship_id in updates and relationship.get("Target") != updates[relationship_id]:
            relationship.set("Target", updates[relationship_id])
            changed = True
    if not changed:
        raise DocumentError("A body hyperlink changed, but its DOCX relationship target was not found.")
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _image_for_part(source: Path, part_name: str) -> bytes:
    """Normalize an uploaded image into the existing OOXML part's format."""

    extension = Path(part_name).suffix.lower()
    formats = {".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG"}
    target_format = formats.get(extension)
    if not target_format:
        raise DocumentError(f"Unsupported template image format for {part_name}.")
    try:
        with Image.open(source) as opened:
            image = ImageOps.exif_transpose(opened)
            if target_format == "JPEG" and image.mode not in ("RGB", "L"):
                image = image.convert("RGB")
            output = io.BytesIO()
            save_options = {"quality": 95, "optimize": True} if target_format == "JPEG" else {"optimize": True}
            image.save(output, format=target_format, **save_options)
            return output.getvalue()
    except (OSError, Image.DecompressionBombError) as error:
        raise DocumentError(f"Uploaded replacement for {part_name} is not a safe supported image.") from error


def _role_for(text: str, style: str | None) -> tuple[str, float]:
    stripped = text.strip()
    if not stripped:
        return "preserve", 1.0
    if stripped == "///":
        return "preserve", 1.0
    upper = stripped.upper()
    case_specific_patterns = (
        r"\$\s?\d",
        r"\b(?:19|20)\d{2}\b",
        r"\b(?:Mr|Ms|Mrs|Dr)\.\s+[A-Z][A-Za-z]+",
        r"\bClaim\s+(?:Number|No\.)",
    )
    if any(re.search(pattern, stripped, re.IGNORECASE) for pattern in case_specific_patterns):
        return "editable", 0.9
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
        "ONLY RELEASES YOUR SETTLING INSURED",
        "CANNOT CONTAIN ANY TERMS",
        "DOES NOT REQUIRE OUR FIRM",
        "A DECLARATION SIGNED BY ALL",
        "THAT IDENTIFIES ALL APPLICABLE INSURANCE",
        "THAT STATES THERE IS NO OTHER INSURANCE",
        "ESQ.",
    )
    if any(marker in upper for marker in preserve_markers):
        return "preserve", 0.88
    case_markers = ("PATIENT", "ACCIDENT", "COLLISION", "INJUR", "TREATMENT", "MEDICAL", "DAMAGES")
    if any(marker in upper for marker in case_markers) and len(stripped) > 30:
        return "editable", 0.78
    return "editable", 0.62


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
        root = etree.fromstring(document_xml)
        has_tracked = bool(root.xpath("//w:ins | //w:del | //w:moveFrom | //w:moveTo", namespaces=NS))
        if has_tracked:
            raise DocumentError("Accept or reject existing tracked changes before importing this template.")
        has_complex = any(marker in document_xml for marker in (b"<w:txbxContent", b"<w:object", b"<v:shape"))
        paragraphs = root.xpath("//w:body/w:p", namespaces=NS)
        relationships: dict[str, str] = {}
        relationships_name = "word/_rels/document.xml.rels"
        if relationships_name in names:
            relationship_root = etree.fromstring(package.read(relationships_name))
            relationships = {
                relationship.get("Id", ""): relationship.get("Target", "")
                for relationship in relationship_root.findall(f"{{{PACKAGE_RELATIONSHIPS}}}Relationship")
            }
        regions = []
        image_candidates: list[dict[str, Any]] = []
        seen_image_relationships: set[str] = set()
        boilerplate_tail = False
        for index, paragraph in enumerate(paragraphs):
            for relationship_id in paragraph.xpath(".//*[@r:embed]/@r:embed", namespaces=NS):
                target = relationships.get(relationship_id)
                if not target or relationship_id in seen_image_relationships:
                    continue
                part_name = posixpath.normpath(posixpath.join("word", target))
                if part_name.startswith("word/media/") and part_name in names:
                    seen_image_relationships.add(relationship_id)
                    image_candidates.append({
                        "paragraphIndex": index,
                        "relationshipId": relationship_id,
                        "partName": part_name,
                        "contentType": mimetypes.guess_type(part_name)[0] or "application/octet-stream",
                    })
            text = _paragraph_text(paragraph).strip()
            style_values = paragraph.xpath("./w:pPr/w:pStyle/@w:val", namespaces=NS)
            style = style_values[0] if style_values else None
            if paragraph.xpath(".//w:instrText", namespaces=NS):
                role, confidence = "preserve", 1.0
            else:
                role, confidence = _role_for(text, style)
            upper_text = text.upper()
            if "THIS OFFER IS SUBJECT TO YOU COMPLYING" in upper_text or "FOLLOWING EXPRESS TERMS AND CONDITIONS" in upper_text:
                boilerplate_tail = True
            if boilerplate_tail and role == "editable" and confidence < 0.9:
                role, confidence = "preserve", 0.9
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
        replacement_candidates: list[dict[str, Any]] = []
        seen_candidates: set[tuple[str, str]] = set()
        # Legal templates often split a time-limited offer sentence across two
        # Word paragraphs. The first paragraph is case-specific and editable,
        # while the second starts with the old deadline time before continuing
        # into immutable settlement boilerplate. Expose only that exact time as
        # a grounded field replacement so the boilerplate remains untouched.
        for index, paragraph in enumerate(paragraphs[1:], start=1):
            previous_text = _paragraph_text(paragraphs[index - 1]).upper()
            current_text = _paragraph_text(paragraph)
            if "OFFER EXPIRES" not in previous_text:
                continue
            for match in DEADLINE_TIME_PATTERN.finditer(current_text):
                value = match.group(1)
                key = ("word/document.xml", value)
                if key not in seen_candidates:
                    seen_candidates.add(key)
                    replacement_candidates.append({
                        "value": value,
                        "location": "word/document.xml",
                        "kind": "date",
                    })
        for part_name in sorted(n for n in names if n.startswith(("word/header", "word/footer")) and n.endswith(".xml")):
            part_root = etree.fromstring(package.read(part_name))
            full_text = " ".join(part_root.xpath("//w:t/text()", namespaces=NS))
            patterns = (
                ("claim-number", r"(?i)claim\s+(?:number|no\.)\s*:\s*([A-Z0-9-]{5,})"),
                ("person", r"(?i)\b(?:Mr|Ms|Mrs|Dr)\.\s+([A-Z][A-Za-z' -]{2,50})"),
                ("amount", r"(\$\s?\d[\d,]*(?:\.\d{2})?)"),
            )
            for kind, pattern in patterns:
                for match in re.finditer(pattern, full_text):
                    value = match.group(1).strip()
                    key = (part_name, value)
                    if key not in seen_candidates:
                        seen_candidates.add(key)
                        replacement_candidates.append({"value": value, "location": part_name, "kind": kind})
            has_dynamic_date = bool(part_root.xpath("//w:instrText[contains(., 'DATE')]", namespaces=NS))
            if not has_dynamic_date:
                for match in re.finditer(r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b", full_text):
                    value = match.group(0)
                    key = (part_name, value)
                    if key not in seen_candidates:
                        seen_candidates.add(key)
                        replacement_candidates.append({"value": value, "location": part_name, "kind": "date"})
        if has_complex:
            warnings.append("Complex positioned objects are preserved but cannot be selected as editable regions.")
        return {
            "analysisVersion": 3,
            "filename": source.name,
            "paragraphCount": len(paragraphs),
            "sectionCount": section_count,
            "hasMacros": False,
            "hasTrackedChanges": False,
            "hasComplexObjects": has_complex,
            "warnings": warnings,
            "regions": regions,
            "replacementCandidates": replacement_candidates,
            "imageCandidates": image_candidates,
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
    image_replacements = {
        str(item["partName"]): Path(str(item["sourcePath"]))
        for item in payload.get("imageReplacements", [])
    }
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
        temp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(source) as zin, zipfile.ZipFile(temp_path, "w") as zout:
            infos = zin.infolist()
            package_data = {info.filename: zin.read(info.filename) for info in infos}
            for part_name, replacement_path in image_replacements.items():
                if not part_name.startswith("word/media/") or part_name not in package_data:
                    raise DocumentError(f"Template image part is missing or invalid: {part_name}")
                package_data[part_name] = _image_for_part(replacement_path, part_name)
            hyperlink_updates: dict[str, str] = {}
            for part_name, data in list(package_data.items()):
                is_text_part = part_name == "word/document.xml" or (
                    part_name.startswith(("word/header", "word/footer")) and part_name.endswith(".xml")
                )
                if is_text_part:
                    root = etree.fromstring(data)
                    changed = False
                    for text_node in root.xpath("//w:t", namespaces=NS):
                        original = text_node.text or ""
                        updated = original
                        for old, new in replacements.items():
                            updated = updated.replace(old, new)
                        if updated != original:
                            text_node.text = updated
                            changed = True
                    if part_name == "word/document.xml":
                        paragraphs = root.xpath("//w:body/w:p", namespaces=NS)
                        for index, paragraph in enumerate(paragraphs):
                            if index in patches:
                                replacement = patches[index]
                                if replacement != _paragraph_text(paragraph):
                                    hyperlink_updates.update(_hyperlink_replacements(paragraph, replacement))
                                    _replace_paragraph_text(paragraph, replacement)
                                    changed = True
                    if changed:
                        data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
                        package_data[part_name] = data
            relationships_name = "word/_rels/document.xml.rels"
            if hyperlink_updates:
                if relationships_name not in package_data:
                    raise DocumentError("A body hyperlink changed, but the DOCX relationships part is missing.")
                package_data[relationships_name] = _patch_relationship_targets(
                    package_data[relationships_name], hyperlink_updates
                )
            for info in infos:
                zout.writestr(info, package_data[info.filename])
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
        "imagePatchCount": len(image_replacements),
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
