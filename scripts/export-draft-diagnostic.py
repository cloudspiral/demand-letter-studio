#!/usr/bin/env python3
"""Render a saved acceptance draft locally without mutating application state."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

WORKER_DIR = Path(__file__).resolve().parents[1] / "services" / "document-worker"
sys.path.insert(0, str(WORKER_DIR))

from worker import analyze_template, export_docx  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("template", type=Path)
    parser.add_argument("draft", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--image", type=Path)
    args = parser.parse_args()

    draft = json.loads(args.draft.read_text(encoding="utf-8"))
    content = draft["content"]
    analysis = analyze_template(str(args.template))
    patches = [
        {"paragraphIndex": block["templateParagraphIndex"], "text": block["text"]}
        for section in content["sections"]
        for block in section["blocks"]
        if block["templateParagraphIndex"] is not None
    ]
    fields = {
        key: field["value"]
        for key, field in content["fields"].items()
        if field.get("verified") or field.get("userConfirmed")
    }
    image_replacements = []
    if args.image:
        image_replacements = [
            {"partName": candidate["partName"], "sourcePath": str(args.image)}
            for candidate in analysis["imageCandidates"]
        ]
    result = export_docx({
        "templatePath": str(args.template),
        "outputPath": str(args.output),
        "patches": patches,
        "fieldReplacements": fields,
        "imageReplacements": image_replacements,
    })
    print(json.dumps(result))


if __name__ == "__main__":
    main()
