#!/usr/bin/env python3
"""Deterministic document operations used by the local API and Lambda worker.

The model never touches OOXML. It supplies validated content; this module performs
bounded extraction and in-place package patches while retaining opaque parts.
"""

from __future__ import annotations

import hashlib
import base64
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
from copy import deepcopy
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Protocol

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from lxml import etree
from PIL import Image, ImageOps
from pypdf import PdfReader
import pypdfium2 as pdfium

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": W, "r": R}
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
EMAIL_PATTERN = re.compile(r"(?i)\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
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


def _optional_int(paragraph: etree._Element, expression: str) -> int | None:
    values = paragraph.xpath(expression, namespaces=NS)
    if not values:
        return None
    try:
        return int(values[0])
    except (TypeError, ValueError):
        return None


def _formatting_for(paragraph: etree._Element, style: str | None) -> dict[str, Any]:
    alignments = paragraph.xpath("./w:pPr/w:jc/@w:val", namespaces=NS)
    runs = paragraph.xpath(".//w:r", namespaces=NS)
    numbering_ids = paragraph.xpath("./w:pPr/w:numPr/w:numId/@w:val", namespaces=NS)
    numbering_levels = paragraph.xpath("./w:pPr/w:numPr/w:ilvl/@w:val", namespaces=NS)
    return {
        "styleId": style,
        "styleFamily": style,
        "alignment": alignments[0] if alignments else None,
        "bold": bool(paragraph.xpath(".//w:rPr/w:b", namespaces=NS)),
        "italic": bool(paragraph.xpath(".//w:rPr/w:i", namespaces=NS)),
        "underline": bool(paragraph.xpath(".//w:rPr/w:u[not(@w:val='none')]", namespaces=NS)),
        "runCount": len(runs),
        "indentLeft": _optional_int(paragraph, "./w:pPr/w:ind/@w:left"),
        "indentRight": _optional_int(paragraph, "./w:pPr/w:ind/@w:right"),
        "firstLine": _optional_int(paragraph, "./w:pPr/w:ind/@w:firstLine"),
        "hanging": _optional_int(paragraph, "./w:pPr/w:ind/@w:hanging"),
        "spacingBefore": _optional_int(paragraph, "./w:pPr/w:spacing/@w:before"),
        "spacingAfter": _optional_int(paragraph, "./w:pPr/w:spacing/@w:after"),
        "lineSpacing": _optional_int(paragraph, "./w:pPr/w:spacing/@w:line"),
        "numberingId": numbering_ids[0] if numbering_ids else None,
        "numberingLevel": int(numbering_levels[0]) if numbering_levels else None,
        "hasTabs": bool(paragraph.xpath(".//w:tab | ./w:pPr/w:tabs/w:tab", namespaces=NS)),
        "keepNext": bool(paragraph.xpath("./w:pPr/w:keepNext", namespaces=NS)),
        "pageBreakBefore": bool(paragraph.xpath("./w:pPr/w:pageBreakBefore", namespaces=NS)),
    }


def _structural_block(
    paragraph: etree._Element,
    *,
    part_name: str,
    paragraph_index: int,
    order: int,
    kind: str,
    semantic_kind: str = "prose",
    figure: dict[str, Any] | None = None,
    structured_group: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    text = _paragraph_text(paragraph)
    if not text.strip() and semantic_kind != "figure":
        return None
    style_values = paragraph.xpath("./w:pPr/w:pStyle/@w:val", namespaces=NS)
    style = style_values[0] if style_values else None
    return {
        "id": f"{part_name}:p:{paragraph_index}",
        "paragraphIndex": paragraph_index,
        "text": text,
        # Structure extraction intentionally makes no semantic Keep/Replace
        # decision. The template-analysis model fills these fields.
        "role": "preserve",
        "semanticKind": semantic_kind,
        "section": None,
        "aiRecommendation": "keep",
        "confidence": 0.0,
        "style": style,
        "explanation": "Awaiting model template analysis.",
        "needsAttention": True,
        "anchor": {
            "partName": part_name,
            "kind": kind,
            "paragraphIndex": paragraph_index,
            "path": f"/{part_name}/paragraph[{paragraph_index}]",
        },
        "formatting": _formatting_for(paragraph, style),
        "structuredGroup": structured_group,
        "figure": figure,
        "inlineFields": [],
        "order": order,
    }


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
        # One stable paragraph sequence covers ordinary body paragraphs and
        # paragraphs inside table cells. Export uses the same sequence.
        paragraphs = root.xpath("//w:body//w:p", namespaces=NS)
        relationships: dict[str, str] = {}
        relationships_name = "word/_rels/document.xml.rels"
        if relationships_name in names:
            relationship_root = etree.fromstring(package.read(relationships_name))
            relationships = {
                relationship.get("Id", ""): relationship.get("Target", "")
                for relationship in relationship_root.findall(f"{{{PACKAGE_RELATIONSHIPS}}}Relationship")
            }
        tables = root.xpath("//w:body//w:tbl", namespaces=NS)

        def table_metadata(paragraph: etree._Element) -> dict[str, Any] | None:
            ancestors = paragraph.xpath("ancestor::w:tbl[1]", namespaces=NS)
            if not ancestors:
                return None
            table = ancestors[0]
            table_index = next((position for position, candidate in enumerate(tables) if candidate is table), None)
            if table_index is None:
                return None
            row = paragraph.xpath("ancestor::w:tr[1]", namespaces=NS)[0]
            cell = paragraph.xpath("ancestor::w:tc[1]", namespaces=NS)[0]
            rows = table.xpath("./w:tr", namespaces=NS)
            cells = row.xpath("./w:tc", namespaces=NS)
            row_index = next(position for position, candidate in enumerate(rows) if candidate is row)
            cell_index = next(position for position, candidate in enumerate(cells) if candidate is cell)
            row_text = " ".join(_paragraph_text(item) for item in row.xpath(".//w:p", namespaces=NS))
            row_role = "total" if re.search(r"\b(?:grand\s+)?total\b", row_text, re.I) else (
                "header" if len(rows) > 1 and row_index == 0 else "body"
            )
            widths = []
            for value in table.xpath("./w:tblGrid/w:gridCol/@w:w", namespaces=NS):
                try:
                    widths.append(int(value))
                except (TypeError, ValueError):
                    widths.append(0)
            return {
                "id": f"word-table-{table_index}",
                "representation": "word-table",
                "rowRole": row_role,
                "tableIndex": table_index,
                "rowIndex": row_index,
                "cellIndex": cell_index,
                "columnCount": max(1, len(cells)),
                "columnWidths": widths,
            }

        regions: list[dict[str, Any]] = []
        body_blocks: list[dict[str, Any]] = []
        header_blocks: list[dict[str, Any]] = []
        footer_blocks: list[dict[str, Any]] = []
        image_candidates: list[dict[str, Any]] = []
        seen_image_relationships: set[str] = set()
        for index, paragraph in enumerate(paragraphs):
            embedded_relationships = paragraph.xpath(".//*[@r:embed]/@r:embed", namespaces=NS)
            figure_added = False
            for relationship_id in embedded_relationships:
                target = relationships.get(relationship_id)
                if not target or relationship_id in seen_image_relationships:
                    continue
                part_name = posixpath.normpath(posixpath.join("word", target))
                if part_name.startswith("word/media/") and part_name in names:
                    seen_image_relationships.add(relationship_id)
                    figure_id = f"word/document.xml:figure:{relationship_id}"
                    figure = {
                        "relationshipId": relationship_id,
                        "partName": part_name,
                        "contentType": mimetypes.guess_type(part_name)[0] or "application/octet-stream",
                        "captionBlockId": None,
                    }
                    image_candidates.append({
                        "blockId": figure_id,
                        "paragraphIndex": index,
                        "relationshipId": relationship_id,
                        "partName": part_name,
                        "contentType": mimetypes.guess_type(part_name)[0] or "application/octet-stream",
                        "captionBlockId": None,
                    })
                    block = _structural_block(
                        paragraph,
                        part_name="word/document.xml",
                        paragraph_index=index,
                        order=len(body_blocks),
                        kind="paragraph",
                        semantic_kind="figure",
                        figure=figure,
                    )
                    if block:
                        block["id"] = figure_id
                        body_blocks.append(block)
                        regions.append(block)
                        figure_added = True
            if figure_added:
                continue
            block = _structural_block(
                paragraph,
                part_name="word/document.xml",
                paragraph_index=index,
                order=len(body_blocks),
                kind="table-cell" if paragraph.xpath("ancestor::w:tc", namespaces=NS) else "paragraph",
                structured_group=table_metadata(paragraph),
            )
            if block:
                body_blocks.append(block)
                regions.append(block)

        def looks_like_group_heading(block: dict[str, Any]) -> bool:
            text = str(block.get("text", "")).strip()
            style = str(block.get("style") or "").lower()
            return bool(text and len(text) <= 120 and (
                text == text.upper() or text.endswith(":") or "heading" in style or "title" in style
            ))

        # Associate an immediately preceding label with a real Word table so
        # optional table omission removes the label and table shell together.
        for table_index, table in enumerate(tables):
            previous = table.getprevious()
            if previous is None or previous.tag != f"{{{W}}}p":
                continue
            paragraph_index = next((position for position, paragraph in enumerate(paragraphs) if paragraph is previous), None)
            heading = next((block for block in body_blocks if block["paragraphIndex"] == paragraph_index), None)
            if not heading or heading.get("structuredGroup") or not looks_like_group_heading(heading):
                continue
            first_row_cells = table.xpath("./w:tr[1]/w:tc", namespaces=NS)
            widths = []
            for value in table.xpath("./w:tblGrid/w:gridCol/@w:w", namespaces=NS):
                try:
                    widths.append(int(value))
                except (TypeError, ValueError):
                    widths.append(0)
            heading["structuredGroup"] = {
                "id": f"word-table-{table_index}",
                "representation": "word-table",
                "rowRole": "header",
                "tableIndex": table_index,
                "rowIndex": None,
                "cellIndex": None,
                "columnCount": max(1, len(first_row_cells)),
                "columnWidths": widths,
            }

        # Consecutive tab/currency rows outside a real Word table form one
        # deterministic paragraph-row group (for example medical expenses).
        cursor = 0
        while cursor < len(body_blocks):
            candidate = body_blocks[cursor]
            if candidate.get("semanticKind") != "prose" or candidate.get("structuredGroup"):
                cursor += 1
                continue
            text = candidate.get("text", "")
            row_like = bool(candidate.get("formatting", {}).get("hasTabs")) or bool(
                re.search(r":\s*(?:\$[\d,]+(?:\.\d{2})?|pending\b)", text, re.I)
            )
            if not row_like:
                cursor += 1
                continue
            run = [candidate]
            scan = cursor + 1
            while scan < len(body_blocks):
                next_block = body_blocks[scan]
                next_text = next_block.get("text", "")
                next_row_like = bool(next_block.get("formatting", {}).get("hasTabs")) or bool(
                    re.search(r":\s*(?:\$[\d,]+(?:\.\d{2})?|pending\b)", next_text, re.I)
                )
                if (
                    next_block.get("semanticKind") != "prose"
                    or next_block.get("structuredGroup")
                    or not next_row_like
                    or next_block["paragraphIndex"] != run[-1]["paragraphIndex"] + 1
                ):
                    break
                run.append(next_block)
                scan += 1
            if len(run) >= 2:
                group_id = f"paragraph-rows-{run[0]['paragraphIndex']}"
                heading = body_blocks[cursor - 1] if cursor > 0 else None
                include_heading = bool(
                    heading
                    and not heading.get("structuredGroup")
                    and heading["paragraphIndex"] + 1 == run[0]["paragraphIndex"]
                    and looks_like_group_heading(heading)
                )
                if include_heading:
                    heading["structuredGroup"] = {
                        "id": group_id,
                        "representation": "paragraph-rows",
                        "rowRole": "header",
                        "tableIndex": None,
                        "rowIndex": None,
                        "cellIndex": None,
                        "columnCount": max(2, len(run[0]["text"].split("\t"))),
                        "columnWidths": [],
                    }
                for row_index, row_block in enumerate(run):
                    row_block["structuredGroup"] = {
                        "id": group_id,
                        "representation": "paragraph-rows",
                        "rowRole": "total" if re.search(r"\b(?:grand\s+)?total\b", row_block["text"], re.I) else "body",
                        "tableIndex": None,
                        "rowIndex": row_index,
                        "cellIndex": None,
                        "columnCount": max(2, len(row_block["text"].split("\t"))),
                        "columnWidths": [],
                    }
            cursor = max(scan, cursor + 1)

        # Link a body image to an immediately following caption-like paragraph.
        by_paragraph = {block["paragraphIndex"]: block for block in body_blocks if block.get("semanticKind") == "prose"}
        for image in image_candidates:
            caption = by_paragraph.get(image["paragraphIndex"] + 1)
            if caption and (
                re.match(r"\s*(?:figure|photograph|photo)\b", caption["text"], re.I)
                or (caption.get("style") or "").lower() == "caption"
            ):
                image["captionBlockId"] = caption["id"]
                figure_block = next((block for block in body_blocks if block["id"] == image["blockId"]), None)
                if figure_block:
                    figure_block["figure"]["captionBlockId"] = caption["id"]

        for part_name in sorted(n for n in names if n.startswith(("word/header", "word/footer")) and n.endswith(".xml")):
            part_root = etree.fromstring(package.read(part_name))
            part_kind = "header" if part_name.startswith("word/header") else "footer"
            for index, paragraph in enumerate(part_root.xpath("//w:p", namespaces=NS)):
                block = _structural_block(
                    paragraph,
                    part_name=part_name,
                    paragraph_index=index,
                    order=index,
                    kind=part_kind,
                )
                if block:
                    (header_blocks if part_kind == "header" else footer_blocks).append(block)
        # Present the complete letter in visual reading order while each OOXML
        # anchor retains its part-specific paragraph index for deterministic patching.
        blocks = [*header_blocks, *body_blocks, *footer_blocks]
        section_count = max(1, len(root.xpath("//w:sectPr", namespaces=NS)))
        warnings = []
        if has_complex:
            warnings.append("Complex positioned objects are preserved but cannot be selected as editable regions.")
        return {
            "analysisVersion": 5,
            "filename": source.name,
            "paragraphCount": len(paragraphs),
            "sectionCount": section_count,
            "hasMacros": False,
            "hasTrackedChanges": False,
            "hasComplexObjects": has_complex,
            "warnings": warnings,
            "regions": regions,
            "blocks": blocks,
            "replacementCandidates": [],
            "imageCandidates": image_candidates,
            "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "packageParts": len(names),
        }


class OcrProvider(Protocol):
    def extract(self, image_bytes: bytes) -> dict[str, Any]: ...


class TextractOcrProvider:
    """AWS Textract adapter that returns text plus auditable layout metadata."""

    def __init__(self) -> None:
        self._client = boto3.client(
            "textract",
            region_name=os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-1",
            config=Config(
                connect_timeout=5,
                read_timeout=60,
                retries={"mode": "adaptive", "max_attempts": 5},
            ),
        )

    def extract(self, image_bytes: bytes) -> dict[str, Any]:
        try:
            response = self._client.analyze_document(
                Document={"Bytes": image_bytes},
                FeatureTypes=["TABLES", "FORMS"],
            )
        except (BotoCoreError, ClientError) as error:
            raise DocumentError("AWS Textract could not extract this page.") from error
        blocks = response.get("Blocks", [])
        lines = [block for block in blocks if block.get("BlockType") == "LINE" and block.get("Text")]
        lines.sort(key=lambda block: (
            block.get("Geometry", {}).get("BoundingBox", {}).get("Top", 0),
            block.get("Geometry", {}).get("BoundingBox", {}).get("Left", 0),
        ))
        confidences = [float(block.get("Confidence", 0)) / 100 for block in lines]
        geometry = [{
            "text": block["Text"],
            "confidence": float(block.get("Confidence", 0)) / 100,
            "boundingBox": block.get("Geometry", {}).get("BoundingBox", {}),
        } for block in lines]
        tables = _textract_tables(blocks)
        forms = _textract_forms(blocks)
        return {
            "text": "\n".join(block["Text"] for block in lines),
            "confidence": sum(confidences) / len(confidences) if confidences else 0.0,
            "geometry": geometry,
            "structuredData": {"tables": tables, "forms": forms},
        }


def _textract_tables(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {block.get("Id"): block for block in blocks if block.get("Id")}

    def child_ids(block: dict[str, Any], relation_type: str) -> list[str]:
        return [child for relation in block.get("Relationships", [])
                if relation.get("Type") == relation_type for child in relation.get("Ids", [])]

    def cell_text(cell: dict[str, Any]) -> str:
        words = [by_id.get(child_id, {}) for child_id in child_ids(cell, "CHILD")]
        return " ".join(str(word.get("Text", "")) for word in words if word.get("BlockType") in {"WORD", "SELECTION_ELEMENT"}).strip()

    tables: list[dict[str, Any]] = []
    for table in (block for block in blocks if block.get("BlockType") == "TABLE"):
        cells = [by_id[cell_id] for cell_id in child_ids(table, "CHILD") if by_id.get(cell_id, {}).get("BlockType") == "CELL"]
        tables.append({
            "rows": max((int(cell.get("RowIndex", 0)) for cell in cells), default=0),
            "columns": max((int(cell.get("ColumnIndex", 0)) for cell in cells), default=0),
            "cells": [{
                "row": int(cell.get("RowIndex", 0)),
                "column": int(cell.get("ColumnIndex", 0)),
                "text": cell_text(cell),
                "confidence": float(cell.get("Confidence", 0)) / 100,
                "boundingBox": cell.get("Geometry", {}).get("BoundingBox", {}),
            } for cell in cells],
        })
    return tables


def _textract_forms(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {block.get("Id"): block for block in blocks if block.get("Id")}

    def related_ids(block: dict[str, Any], relation_type: str) -> list[str]:
        return [child for relation in block.get("Relationships", [])
                if relation.get("Type") == relation_type for child in relation.get("Ids", [])]

    def block_text(block: dict[str, Any]) -> str:
        words = [by_id.get(child_id, {}) for child_id in related_ids(block, "CHILD")]
        return " ".join(str(word.get("Text", "")) for word in words
                        if word.get("BlockType") in {"WORD", "SELECTION_ELEMENT"}).strip()

    forms: list[dict[str, Any]] = []
    for key in (block for block in blocks
                if block.get("BlockType") == "KEY_VALUE_SET" and "KEY" in block.get("EntityTypes", [])):
        for value_id in related_ids(key, "VALUE"):
            value = by_id.get(value_id, {})
            if value.get("BlockType") != "KEY_VALUE_SET":
                continue
            forms.append({
                "key": block_text(key),
                "value": block_text(value),
                "keyConfidence": float(key.get("Confidence", 0)) / 100,
                "valueConfidence": float(value.get("Confidence", 0)) / 100,
                "keyBoundingBox": key.get("Geometry", {}).get("BoundingBox", {}),
                "valueBoundingBox": value.get("Geometry", {}).get("BoundingBox", {}),
            })
    return forms


def _ocr_provider_from_environment() -> OcrProvider | None:
    provider = os.getenv("OCR_PROVIDER", "").strip().lower()
    if not provider or provider in {"none", "disabled"}:
        return None
    if provider in {"textract", "aws-textract"}:
        return TextractOcrProvider()
    raise DocumentError(f"Unsupported OCR provider: {provider}")


def _requires_ocr(text: str) -> bool:
    compact = "".join(character for character in text if not character.isspace())
    if len(compact) < 40:
        return True
    readable = sum(character.isprintable() and (character.isalnum() or character in "$.,:;/-()") for character in compact)
    return readable / max(1, len(compact)) < 0.65


def _render_pdf_page(document: pdfium.PdfDocument, page_index: int) -> bytes:
    page = document[page_index]
    try:
        bitmap = page.render(scale=2.0)
        image = bitmap.to_pil()
        output = io.BytesIO()
        image.save(output, format="PNG", optimize=True)
        return output.getvalue()
    finally:
        page.close()


def _standalone_image_as_png(source: Path) -> bytes:
    with Image.open(source) as image:
        output = io.BytesIO()
        image.convert("RGB").save(output, format="PNG", optimize=True)
        return output.getvalue()


def _extract_native_pdf_page(page: Any) -> tuple[str, list[dict[str, Any]]]:
    geometry: list[dict[str, Any]] = []

    def visitor(text: str, _cm: list[float], tm: list[float], _font: Any, font_size: float) -> None:
        if text.strip():
            geometry.append({
                "text": text,
                "confidence": 1.0,
                "origin": {"x": float(tm[4]), "y": float(tm[5])},
                "fontSize": float(font_size),
            })

    text = (page.extract_text(visitor_text=visitor) or "").strip()
    return text, geometry


def _page_result(
    page_number: int,
    *,
    text: str,
    method: str,
    status: str,
    confidence: float | None,
    geometry: list[dict[str, Any]] | None = None,
    structured_data: dict[str, Any] | None = None,
    visual_input: bool = False,
    visual_data: bytes | None = None,
) -> dict[str, Any]:
    return {
        "page": page_number,
        "text": text,
        "extractionMethod": method,
        "extractionStatus": status,
        "confidence": confidence,
        "geometry": geometry or [],
        "structuredData": structured_data or {"tables": []},
        "visualInput": visual_input,
        "visualDataBase64": base64.b64encode(visual_data).decode("ascii") if visual_data else None,
        "visualMimeType": "image/png" if visual_data else None,
    }


def extract_source(path: str, mime_type: str | None = None, ocr_provider: OcrProvider | None = None) -> dict[str, Any]:
    source = Path(path)
    mime = mime_type or mimetypes.guess_type(source.name)[0] or "application/octet-stream"
    pages: list[dict[str, Any]] = []
    ocr = ocr_provider or _ocr_provider_from_environment()
    if mime == "application/pdf" or source.suffix.lower() == ".pdf":
        reader = PdfReader(str(source))
        rendered: pdfium.PdfDocument | None = None
        for index, page in enumerate(reader.pages):
            native_text, native_geometry = _extract_native_pdf_page(page)
            if not _requires_ocr(native_text):
                pages.append(_page_result(index + 1, text=native_text, method="native", status="ready", confidence=1.0, geometry=native_geometry))
                continue
            if ocr:
                if rendered is None:
                    rendered = pdfium.PdfDocument(str(source))
                rendered_page = _render_pdf_page(rendered, index)
                result = ocr.extract(rendered_page)
                pages.append(_page_result(
                    index + 1,
                    text=str(result.get("text", "")).strip(),
                    method="ocr",
                    status="ready" if result.get("text") else "ocr-failed",
                    confidence=float(result.get("confidence", 0)),
                    geometry=result.get("geometry"),
                    structured_data=result.get("structuredData"),
                    visual_input=True,
                    visual_data=rendered_page,
                ))
            else:
                if rendered is None:
                    rendered = pdfium.PdfDocument(str(source))
                rendered_page = _render_pdf_page(rendered, index)
                pages.append(_page_result(
                    index + 1,
                    text="",
                    method="none",
                    status="ocr-required",
                    confidence=None,
                    visual_input=True,
                    visual_data=rendered_page,
                ))
        if rendered is not None:
            rendered.close()
    elif mime.startswith("image/"):
        if ocr:
            result = ocr.extract(_standalone_image_as_png(source))
            pages.append(_page_result(
                1,
                text=str(result.get("text", "")).strip(),
                method="ocr",
                status="ready" if result.get("text") else "visual-only",
                confidence=float(result.get("confidence", 0)),
                geometry=result.get("geometry"),
                structured_data=result.get("structuredData"),
                visual_input=True,
            ))
        else:
            pages.append(_page_result(1, text="", method="visual", status="visual-only", confidence=None, visual_input=True))
    else:
        raise DocumentError("Sources must be PDF or image files.")
    return {
        "filename": source.name,
        "mimeType": mime,
        "pageCount": len(pages),
        "pages": pages,
        # Values are returned by grounded generation with provenance.
        # Regex extraction is intentionally not an authoritative fact source.
        "facts": [],
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    }


def _remove_element(element: etree._Element) -> None:
    parent = element.getparent()
    if parent is not None:
        parent.remove(element)


def _insert_after(reference: etree._Element, element: etree._Element) -> None:
    parent = reference.getparent()
    if parent is None:
        raise DocumentError("Template insertion anchor is detached.")
    parent.insert(parent.index(reference) + 1, element)


def _plain_paragraph(text: str) -> etree._Element:
    paragraph = etree.Element(f"{{{W}}}p")
    run = etree.SubElement(paragraph, f"{{{W}}}r")
    text_node = etree.SubElement(run, f"{{{W}}}t")
    _set_text_node(text_node, text)
    return paragraph


def _row_text(cells: list[str], exemplar: etree._Element) -> str:
    if exemplar.xpath(".//w:tab | ./w:pPr/w:tabs/w:tab", namespaces=NS):
        return "\t".join(cells)
    if len(cells) == 2:
        return f"{cells[0]}: {cells[1]}"
    return "\t".join(cells)


def _replace_table_row(row: etree._Element, cells: list[str]) -> None:
    table_cells = row.xpath("./w:tc", namespaces=NS)
    if len(table_cells) != len(cells):
        raise DocumentError(f"Structured output has {len(cells)} columns but the template row has {len(table_cells)}.")
    for table_cell, text in zip(table_cells, cells, strict=True):
        paragraphs = table_cell.xpath("./w:p", namespaces=NS)
        if not paragraphs:
            paragraph = etree.SubElement(table_cell, f"{{{W}}}p")
            _replace_paragraph_text(paragraph, text)
            continue
        _replace_paragraph_text(paragraphs[0], text)
        for extra in paragraphs[1:]:
            _remove_element(extra)


def _replace_structured_paragraph_row(paragraph: etree._Element, cells: list[str]) -> None:
    """Replace row cells while retaining the exemplar's tabs and run styling."""

    if not paragraph.xpath(".//w:tab | ./w:pPr/w:tabs/w:tab", namespaces=NS):
        _replace_paragraph_text(paragraph, _row_text(cells, paragraph))
        return
    text_nodes = paragraph.xpath(".//w:t", namespaces=NS)
    if len(cells) != 2 or len(text_nodes) < 2:
        raise DocumentError("Tab-aligned paragraph rows require two generated cells and at least two styled text runs.")
    original_label = text_nodes[0].text or ""
    label = cells[0]
    if original_label.rstrip().endswith(":") and not label.rstrip().endswith(":"):
        label = f"{label.rstrip()}:"
    _set_text_node(text_nodes[0], label)
    for node in text_nodes[1:-1]:
        _set_text_node(node, "")
    _set_text_node(text_nodes[-1], cells[1])


def _apply_narrative_operation(
    operation: dict[str, Any],
    originals: dict[str, list[etree._Element]],
) -> None:
    anchors = operation.get("anchors", [])
    if not anchors:
        raise DocumentError("Narrative generation target has no OOXML anchors.")
    nodes: list[etree._Element] = []
    for anchor in anchors:
        part_name = str(anchor["partName"])
        paragraph_index = int(anchor["paragraphIndex"])
        part_paragraphs = originals.get(part_name, [])
        if paragraph_index >= len(part_paragraphs):
            raise DocumentError(f"Narrative target anchor is missing: {part_name} paragraph {paragraph_index}")
        nodes.append(part_paragraphs[paragraph_index])
    if operation["status"] != "generated":
        for node in nodes:
            _remove_element(node)
        return
    paragraphs = [str(text) for text in operation.get("paragraphs", [])]
    if not paragraphs:
        raise DocumentError("Generated narrative target has no paragraphs.")
    if len({str(anchor["partName"]) for anchor in anchors}) != 1:
        raise DocumentError("One narrative target cannot span multiple OOXML parts.")
    for index, text in enumerate(paragraphs[:len(nodes)]):
        _replace_paragraph_text(nodes[index], text)
    previous = nodes[-1]
    for text in paragraphs[len(nodes):]:
        clone = deepcopy(nodes[-1])
        _replace_paragraph_text(clone, text)
        _insert_after(previous, clone)
        previous = clone
    for unused in nodes[len(paragraphs):]:
        _remove_element(unused)


def _apply_paragraph_rows_operation(
    operation: dict[str, Any],
    originals: dict[str, list[etree._Element]],
) -> None:
    anchors = operation.get("anchors", [])
    nodes = []
    roles = []
    for anchor in anchors:
        part_name = str(anchor["partName"])
        paragraph_index = int(anchor["paragraphIndex"])
        part_paragraphs = originals.get(part_name, [])
        if paragraph_index >= len(part_paragraphs):
            raise DocumentError(f"Structured target anchor is missing: {part_name} paragraph {paragraph_index}")
        node = part_paragraphs[paragraph_index]
        if node not in nodes:
            nodes.append(node)
            roles.append((anchor.get("structuredGroup") or {}).get("rowRole", "body"))
    if operation["status"] != "generated":
        for node in nodes:
            _remove_element(node)
        return
    rows = operation.get("rows", [])
    if not rows:
        raise DocumentError("Generated structured target has no rows.")
    dynamic = [(node, role) for node, role in zip(nodes, roles, strict=True) if role != "header"]
    if not dynamic:
        raise DocumentError("Structured paragraph group needs a body or total exemplar row.")
    body_template = next((node for node, role in dynamic if role == "body"), dynamic[0][0])
    total_template = next((node for node, role in zip(nodes, roles, strict=True) if role == "total"), body_template)
    first = dynamic[0][0]
    parent = first.getparent()
    if parent is None:
        raise DocumentError("Structured paragraph group is detached.")
    insert_index = parent.index(first)
    for node, _role in dynamic:
        _remove_element(node)
    for offset, row in enumerate(rows):
        exemplar = total_template if row.get("role") == "total" else body_template
        clone = deepcopy(exemplar)
        _replace_structured_paragraph_row(clone, [str(cell) for cell in row.get("cells", [])])
        parent.insert(insert_index + offset, clone)


def _apply_word_table_operation(
    operation: dict[str, Any],
    original_tables: dict[str, list[etree._Element]],
    originals: dict[str, list[etree._Element]],
) -> None:
    anchors = operation.get("anchors", [])
    structured = next((anchor.get("structuredGroup") for anchor in anchors if anchor.get("structuredGroup")), None)
    if not structured or structured.get("tableIndex") is None:
        raise DocumentError("Word-table operation is missing its table index.")
    part_name = str(anchors[0]["partName"])
    tables = original_tables.get(part_name)
    if tables is None:
        raise DocumentError("Word-table target part is missing.")
    table_index = int(structured["tableIndex"])
    if table_index >= len(tables):
        raise DocumentError(f"Word-table target {table_index} is missing.")
    table = tables[table_index]
    if operation["status"] != "generated":
        _remove_element(table)
        for anchor in anchors:
            group = anchor.get("structuredGroup") or {}
            if group.get("rowIndex") is None:
                paragraph_index = int(anchor["paragraphIndex"])
                paragraphs = originals.get(str(anchor["partName"]), [])
                if paragraph_index < len(paragraphs):
                    _remove_element(paragraphs[paragraph_index])
        return
    rows = table.xpath("./w:tr", namespaces=NS)
    metadata_by_row: dict[int, str] = {}
    for anchor in anchors:
        group = anchor.get("structuredGroup") or {}
        if group.get("rowIndex") is not None:
            metadata_by_row[int(group["rowIndex"])] = str(group.get("rowRole", "body"))
    generated_indexes = sorted(index for index, role in metadata_by_row.items() if role != "header")
    if not generated_indexes:
        raise DocumentError("Word-table target needs at least one body or total exemplar row.")
    body_template = next((rows[index] for index in generated_indexes if metadata_by_row[index] == "body"), rows[generated_indexes[0]])
    total_template = next((rows[index] for index in generated_indexes if metadata_by_row[index] == "total"), body_template)
    insert_index = table.index(rows[generated_indexes[0]])
    for index in reversed(generated_indexes):
        _remove_element(rows[index])
    generated_rows = operation.get("rows", [])
    if not generated_rows:
        raise DocumentError("Generated Word-table target has no rows.")
    for offset, generated in enumerate(generated_rows):
        clone = deepcopy(total_template if generated.get("role") == "total" else body_template)
        _replace_table_row(clone, [str(cell) for cell in generated.get("cells", [])])
        table.insert(insert_index + offset, clone)


def _caption_index(caption_block_id: str | None) -> int | None:
    if not caption_block_id:
        return None
    match = re.fullmatch(r"word/document\.xml:p:(\d+)", caption_block_id)
    return int(match.group(1)) if match else None


def _apply_figure_operation(
    operation: dict[str, Any],
    originals: dict[str, list[etree._Element]],
    package_data: dict[str, bytes],
) -> None:
    anchors = operation.get("anchors", [])
    anchor = next((item for item in anchors if item.get("figure")), None)
    if not anchor:
        raise DocumentError("Figure operation is missing immutable figure metadata.")
    part_name = str(anchor["partName"])
    paragraphs = originals.get(part_name, [])
    paragraph_index = int(anchor["paragraphIndex"])
    if paragraph_index >= len(paragraphs):
        raise DocumentError("Figure paragraph anchor is missing.")
    figure_node = paragraphs[paragraph_index]
    figure = anchor["figure"]
    caption_index = _caption_index(figure.get("captionBlockId"))
    caption_node = paragraphs[caption_index] if caption_index is not None and caption_index < len(paragraphs) else None
    if operation["status"] != "generated":
        _remove_element(figure_node)
        if caption_node is not None:
            _remove_element(caption_node)
        return
    media_part = str(figure["partName"])
    source_path = operation.get("sourcePath")
    if not source_path or media_part not in package_data:
        raise DocumentError("Generated figure is missing its uploaded image or template media part.")
    package_data[media_part] = _image_for_part(Path(str(source_path)), media_part)
    caption = str(operation.get("caption") or "").strip()
    if not caption:
        raise DocumentError("Generated figure caption is empty.")
    if caption_node is not None:
        _replace_paragraph_text(caption_node, caption)
    else:
        _insert_after(figure_node, _plain_paragraph(caption))


def export_docx(payload: dict[str, Any]) -> dict[str, Any]:
    source = Path(payload["templatePath"])
    output = Path(payload["outputPath"])
    patches: dict[tuple[str, int], str] = {}
    for item in payload.get("patches", []):
        part_name = str(item.get("partName", "word/document.xml"))
        is_text_part = part_name == "word/document.xml" or (
            part_name.startswith(("word/header", "word/footer")) and part_name.endswith(".xml")
        )
        if not is_text_part:
            raise DocumentError(f"Template patch part is not a supported text part: {part_name}")
        key = (part_name, int(item["paragraphIndex"]))
        if key in patches:
            raise DocumentError(f"Template patch is duplicated: {part_name} paragraph {key[1]}")
        patches[key] = str(item["text"])
    replacements = {str(k): str(v) for k, v in payload.get("fieldReplacements", {}).items() if k and v}
    image_replacements = {
        str(item["partName"]): Path(str(item["sourcePath"]))
        for item in payload.get("imageReplacements", [])
    }
    target_operations = payload.get("targetOperations", [])
    target_ids: set[str] = set()
    occupied_anchors: set[tuple[str, int]] = set()
    for operation in target_operations:
        target_id = str(operation.get("targetId", ""))
        if not target_id or target_id in target_ids:
            raise DocumentError("Generation target operations require unique target ids.")
        target_ids.add(target_id)
        for anchor in operation.get("anchors", []):
            key = (str(anchor["partName"]), int(anchor["paragraphIndex"]))
            if key in occupied_anchors:
                raise DocumentError(f"Generation target operations overlap at {key[0]} paragraph {key[1]}.")
            occupied_anchors.add(key)
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as tmp:
        temp_path = Path(tmp.name)
    try:
        with zipfile.ZipFile(source) as zin, zipfile.ZipFile(temp_path, "w") as zout:
            infos = zin.infolist()
            package_data = {info.filename: zin.read(info.filename) for info in infos}
            text_parts = [part_name for part_name in package_data if part_name == "word/document.xml" or (
                part_name.startswith(("word/header", "word/footer")) and part_name.endswith(".xml")
            )]
            roots = {part_name: etree.fromstring(package_data[part_name]) for part_name in text_parts}
            originals = {
                part_name: root.xpath("//w:body//w:p", namespaces=NS) if part_name == "word/document.xml" else root.xpath("//w:p", namespaces=NS)
                for part_name, root in roots.items()
            }
            original_tables = {
                part_name: root.xpath("//w:body//w:tbl", namespaces=NS) if part_name == "word/document.xml" else []
                for part_name, root in roots.items()
            }
            changed_parts: set[str] = set()
            for part_name, replacement_path in image_replacements.items():
                if not part_name.startswith("word/media/") or part_name not in package_data:
                    raise DocumentError(f"Template image part is missing or invalid: {part_name}")
                package_data[part_name] = _image_for_part(replacement_path, part_name)
            hyperlink_updates: dict[str, dict[str, str]] = {}
            applied_patches: set[tuple[str, int]] = set()
            for part_name, root in roots.items():
                for text_node in root.xpath("//w:t", namespaces=NS):
                    original = text_node.text or ""
                    updated = original
                    for old, new in replacements.items():
                        updated = updated.replace(old, new)
                    if updated != original:
                        _set_text_node(text_node, updated)
                        changed_parts.add(part_name)
                for index, paragraph in enumerate(originals[part_name]):
                    patch_key = (part_name, index)
                    if patch_key in patches:
                        applied_patches.add(patch_key)
                        replacement = patches[patch_key]
                        if replacement != _paragraph_text(paragraph):
                            part_updates = _hyperlink_replacements(paragraph, replacement)
                            if part_updates:
                                hyperlink_updates.setdefault(part_name, {}).update(part_updates)
                            _replace_paragraph_text(paragraph, replacement)
                            changed_parts.add(part_name)
            missing_patches = sorted(set(patches).difference(applied_patches))
            if missing_patches:
                part_name, paragraph_index = missing_patches[0]
                raise DocumentError(f"Template patch target is missing: {part_name} paragraph {paragraph_index}")
            target_image_count = 0
            for operation in target_operations:
                anchors = operation.get("anchors", [])
                kind = operation.get("kind")
                if kind == "narrative":
                    _apply_narrative_operation(operation, originals)
                elif kind == "structured":
                    representation = next((
                        (anchor.get("structuredGroup") or {}).get("representation")
                        for anchor in anchors if anchor.get("structuredGroup")
                    ), None)
                    if representation == "word-table":
                        _apply_word_table_operation(operation, original_tables, originals)
                    elif representation == "paragraph-rows":
                        _apply_paragraph_rows_operation(operation, originals)
                    else:
                        raise DocumentError("Structured generation target has no supported representation.")
                elif kind == "figure":
                    _apply_figure_operation(operation, originals, package_data)
                    if operation.get("status") == "generated":
                        target_image_count += 1
                else:
                    raise DocumentError(f"Unsupported generation target kind: {kind}")
                changed_parts.update(str(anchor["partName"]) for anchor in anchors)
            for part_name in changed_parts:
                package_data[part_name] = etree.tostring(
                    roots[part_name], xml_declaration=True, encoding="UTF-8", standalone=True
                )
            for text_part_name, updates in hyperlink_updates.items():
                relationships_name = posixpath.join(
                    posixpath.dirname(text_part_name),
                    "_rels",
                    f"{posixpath.basename(text_part_name)}.rels",
                )
                if relationships_name not in package_data:
                    raise DocumentError(f"A hyperlink changed, but its relationships part is missing: {relationships_name}")
                package_data[relationships_name] = _patch_relationship_targets(
                    package_data[relationships_name], updates
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
        "imagePatchCount": len(image_replacements) + target_image_count,
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
