#!/usr/bin/env python3
"""Patch every editable template paragraph to stress OOXML style retention."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1] / "services" / "document-worker"
sys.path.insert(0, str(WORKER_DIR))

from worker import analyze_template, export_docx  # noqa: E402


def transform(text: str) -> str:
    updated = text
    replacements = (
        ("Patrick Donahue", "Jordan Rivera"),
        ("Pat Donahue", "Jordan Rivera"),
        ("PATRICK DONAHUE", "JORDAN RIVERA"),
        ("PAT DONAHUE", "JORDAN RIVERA"),
        ("Mr. Donahue", "Ms. Rivera"),
        ("MR. DONAHUE", "MS. RIVERA"),
        ("Donahue", "Rivera"),
        ("DONAHUE", "RIVERA"),
        ("017204635", "SYNTH-2027-001"),
        ("collins.elaine@ace.aaa.com", "claims@example.test"),
    )
    for old, new in replacements:
        updated = updated.replace(old, new)
    updated = re.sub(r"\b2026\b", "2027", updated)
    updated = re.sub(
        r"\$\s?\d[\d,]*(?:\.\d{2})?",
        lambda match: "$98,765.43" if "." in match.group(0) else "$98,765",
        updated,
    )
    if updated == text:
        updated += " [SYNTHETIC FORMAT TEST]"
    return updated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("template", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--image", type=Path)
    args = parser.parse_args()

    analysis = analyze_template(str(args.template))
    patches = [
        {"paragraphIndex": region["paragraphIndex"], "text": transform(region["text"])}
        for region in analysis["regions"]
        if region["role"] == "editable"
    ]
    field_replacements: dict[str, str] = {}
    for candidate in analysis["replacementCandidates"]:
        value = candidate["value"]
        field_replacements[value] = transform(value)
    result = export_docx({
        "templatePath": str(args.template),
        "outputPath": str(args.output),
        "patches": patches,
        "fieldReplacements": field_replacements,
        "imageReplacements": [
            {"partName": candidate["partName"], "sourcePath": str(args.image)}
            for candidate in analysis["imageCandidates"]
        ] if args.image else [],
    })
    print(
        f"{result['path']} ({result['patchCount']} text patches, "
        f"{result['imagePatchCount']} image patches, {result['sha256']})"
    )


if __name__ == "__main__":
    main()
