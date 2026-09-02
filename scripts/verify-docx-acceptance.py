#!/usr/bin/env python3
"""Verify that an exported DOCX changes content without damaging its package.

This is deliberately independent of the application export code. It treats the
uploaded template as the immutable formatting source, compares OOXML structure,
and can render both files through LibreOffice to catch pagination drift.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from lxml import etree
from pypdf import PdfReader

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W14 = "http://schemas.microsoft.com/office/word/2010/wordml"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": W}
DEFAULT_MUTABLE_PATTERNS = (
    re.compile(r"^word/document\.xml$"),
    re.compile(r"^word/(?:header|footer)\d+\.xml$"),
    re.compile(r"^word/_rels/document\.xml\.rels$"),
)
SPECIAL_TAGS = (
    "hyperlink",
    "bookmarkStart",
    "bookmarkEnd",
    "fldChar",
    "instrText",
    "drawing",
    "object",
    "pict",
    "tab",
    "br",
    "cr",
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(element: etree._Element | None) -> bytes:
    if element is None:
        return b""
    return etree.tostring(element, method="c14n", exclusive=True, with_comments=False)


def paragraph_text(paragraph: etree._Element) -> str:
    return "".join(paragraph.xpath(".//w:t/text()", namespaces=NS))


def paragraph_id(paragraph: etree._Element) -> str | None:
    return paragraph.get(f"{{{W14}}}paraId")


def paragraph_signature(paragraph: etree._Element) -> dict[str, Any]:
    return {
        "pPr": sha256(canonical(paragraph.find(f"{{{W}}}pPr"))),
        "runProperties": [sha256(canonical(item)) for item in paragraph.xpath(".//w:rPr", namespaces=NS)],
        "special": {
            tag: len(paragraph.xpath(f".//w:{tag}", namespaces=NS))
            for tag in SPECIAL_TAGS
        },
    }


def is_mutable_part(name: str, allowed_media: set[str]) -> bool:
    return name in allowed_media or any(pattern.match(name) for pattern in DEFAULT_MUTABLE_PATTERNS)


def find_soffice() -> str | None:
    command = shutil.which("soffice")
    if command:
        return command
    mac_path = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")
    return str(mac_path) if mac_path.exists() else None


def render_docx(source: Path, output_dir: Path) -> dict[str, Any]:
    soffice = find_soffice()
    if not soffice:
        raise RuntimeError("LibreOffice/soffice is not installed.")
    output_dir.mkdir(parents=True, exist_ok=True)
    profile_dir = Path(tempfile.mkdtemp(prefix="steno-lo-profile-"))
    try:
        completed = subprocess.run(
            [
                soffice,
                "--headless",
                f"-env:UserInstallation=file://{profile_dir}",
                "--convert-to",
                "pdf",
                "--outdir",
                str(output_dir),
                str(source),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if completed.returncode != 0:
            raise RuntimeError(f"LibreOffice failed: {completed.stderr.strip() or completed.stdout.strip()}")
        pdf_path = output_dir / f"{source.stem}.pdf"
        if not pdf_path.exists():
            raise RuntimeError("LibreOffice did not create the expected PDF.")
        reader = PdfReader(str(pdf_path))
        page_sizes = [
            [float(page.mediabox.width), float(page.mediabox.height)]
            for page in reader.pages
        ]
        return {
            "pdf": str(pdf_path),
            "pageCount": len(reader.pages),
            "pageSizes": page_sizes,
            "sha256": sha256(pdf_path.read_bytes()),
        }
    finally:
        shutil.rmtree(profile_dir, ignore_errors=True)


def relationship_map(data: bytes) -> dict[str, dict[str, str]]:
    root = etree.fromstring(data)
    return {
        item.get("Id", ""): dict(item.attrib)
        for item in root.findall(f"{{{REL}}}Relationship")
    }


def verify(
    original: Path,
    candidate: Path,
    forbidden: list[str],
    render_dir: Path | None,
    allowed_media: set[str],
    allow_page_count_change: bool,
) -> dict[str, Any]:
    failures: list[str] = []
    warnings: list[str] = []
    with zipfile.ZipFile(original) as before_zip, zipfile.ZipFile(candidate) as after_zip:
        before_names = set(before_zip.namelist())
        after_names = set(after_zip.namelist())
        if before_names != after_names:
            failures.append(
                f"Package part set changed: removed={sorted(before_names - after_names)}, added={sorted(after_names - before_names)}"
            )

        shared_names = sorted(before_names & after_names)
        changed_parts: list[str] = []
        for name in shared_names:
            before_data = before_zip.read(name)
            after_data = after_zip.read(name)
            if name.endswith((".xml", ".rels")):
                for label, data in (("original", before_data), ("candidate", after_data)):
                    try:
                        etree.fromstring(data)
                    except etree.XMLSyntaxError as error:
                        failures.append(f"{label} {name} is not valid XML: {error}")
            if before_data != after_data:
                changed_parts.append(name)
                if not is_mutable_part(name, allowed_media):
                    failures.append(f"Immutable package part changed: {name}")

        if "word/document.xml" not in shared_names:
            failures.append("word/document.xml is missing")
            before_paragraphs: list[etree._Element] = []
            after_paragraphs: list[etree._Element] = []
        else:
            before_root = etree.fromstring(before_zip.read("word/document.xml"))
            after_root = etree.fromstring(after_zip.read("word/document.xml"))
            before_paragraphs = before_root.xpath("//w:body/w:p", namespaces=NS)
            after_paragraphs = after_root.xpath("//w:body/w:p", namespaces=NS)
            if len(before_paragraphs) != len(after_paragraphs):
                message = (
                    f"Body paragraph count changed from {len(before_paragraphs)} to {len(after_paragraphs)}"
                )
                (warnings if allow_page_count_change else failures).append(message)
            before_sections = [canonical(item) for item in before_root.xpath("//w:sectPr", namespaces=NS)]
            after_sections = [canonical(item) for item in after_root.xpath("//w:sectPr", namespaces=NS)]
            if before_sections != after_sections:
                failures.append("Section geometry/properties changed")

        changed_paragraphs: list[dict[str, Any]] = []
        before_by_id = {
            identifier: paragraph
            for paragraph in before_paragraphs
            if (identifier := paragraph_id(paragraph)) is not None
        }
        for index, after in enumerate(after_paragraphs):
            identifier = paragraph_id(after)
            before = before_by_id.get(identifier) if identifier is not None else None
            if before is None and len(before_paragraphs) == len(after_paragraphs):
                before = before_paragraphs[index]
            if before is None:
                failures.append(f"Candidate paragraph {index} has no stable source paragraph anchor")
                continue
            before_signature = paragraph_signature(before)
            after_signature = paragraph_signature(after)
            if before_signature != after_signature:
                failures.append(f"Paragraph {index} formatting or special OOXML structure changed")
            before_text = paragraph_text(before)
            after_text = paragraph_text(after)
            if before_text != after_text:
                risk = len(after_text) / max(1, len(before_text))
                if len(after_text) - len(before_text) > 80 and risk > 1.75:
                    warnings.append(
                        f"Paragraph {index} grew from {len(before_text)} to {len(after_text)} characters and may repaginate"
                    )
                changed_paragraphs.append({
                    "index": index,
                    "paragraphId": identifier,
                    "beforeCharacters": len(before_text),
                    "afterCharacters": len(after_text),
                    "growthRatio": round(risk, 3),
                })

        relationship_name = "word/_rels/document.xml.rels"
        if relationship_name in shared_names:
            before_relationships = relationship_map(before_zip.read(relationship_name))
            after_relationships = relationship_map(after_zip.read(relationship_name))
            if set(before_relationships) != set(after_relationships):
                failures.append("Document relationship IDs changed")
            for relationship_id in sorted(set(before_relationships) & set(after_relationships)):
                before_item = before_relationships[relationship_id]
                after_item = after_relationships[relationship_id]
                if before_item == after_item:
                    continue
                if not before_item.get("Type", "").endswith("/hyperlink"):
                    failures.append(f"Non-hyperlink relationship changed: {relationship_id}")
                    continue
                for attribute in ("Id", "Type", "TargetMode"):
                    if before_item.get(attribute) != after_item.get(attribute):
                        failures.append(f"Hyperlink relationship {relationship_id} changed {attribute}")

        candidate_text = "\n".join(
            paragraph_text(paragraph)
            for paragraph in after_paragraphs
        )
        for name in sorted(after_names):
            if name.startswith(("word/header", "word/footer")) and name.endswith(".xml"):
                part_root = etree.fromstring(after_zip.read(name))
                candidate_text += "\n" + "".join(part_root.xpath("//w:t/text()", namespaces=NS))
        for marker in forbidden:
            if marker.casefold() in candidate_text.casefold():
                failures.append(f"Forbidden marker remains in exported text: {marker!r}")

        media_hashes = {
            name: sha256(after_zip.read(name))
            for name in sorted(after_names)
            if name.startswith("word/media/")
        }

    rendering: dict[str, Any] | None = None
    if render_dir is not None:
        original_render = render_docx(original, render_dir / "original")
        candidate_render = render_docx(candidate, render_dir / "candidate")
        if original_render["pageCount"] != candidate_render["pageCount"]:
            message = (
                f"Rendered page count changed from {original_render['pageCount']} to {candidate_render['pageCount']}"
            )
            (warnings if allow_page_count_change else failures).append(message)
        original_page_sizes = {tuple(size) for size in original_render["pageSizes"]}
        candidate_page_sizes = {tuple(size) for size in candidate_render["pageSizes"]}
        if original_page_sizes != candidate_page_sizes:
            failures.append("Rendered page sizes changed")
        rendering = {"original": original_render, "candidate": candidate_render}

    return {
        "passed": not failures,
        "original": str(original),
        "candidate": str(candidate),
        "originalSha256": sha256(original.read_bytes()),
        "candidateSha256": sha256(candidate.read_bytes()),
        "changedParts": changed_parts,
        "changedParagraphs": changed_paragraphs,
        "mediaSha256": media_hashes,
        "allowedMediaChanges": sorted(allowed_media),
        "rendering": rendering,
        "warnings": warnings,
        "failures": failures,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("original", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--forbid", action="append", default=[])
    parser.add_argument("--render-dir", type=Path)
    parser.add_argument("--allow-media", action="append", default=[])
    parser.add_argument(
        "--allow-page-count-change",
        action="store_true",
        help="Allow intentional target expansion/omission to change paragraph and rendered page counts while preserving anchors and page geometry.",
    )
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    report = verify(
        args.original.resolve(),
        args.candidate.resolve(),
        args.forbid,
        args.render_dir.resolve() if args.render_dir else None,
        set(args.allow_media),
        args.allow_page_count_change,
    )
    output = json.dumps(report, indent=2)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(output + "\n", encoding="utf-8")
    print(output)
    raise SystemExit(0 if report["passed"] else 1)


if __name__ == "__main__":
    main()
