# ADR 0002: Reviewed DOCX as immutable formatting authority

Status: accepted

Accept reviewed `.docx` templates only. Preserve the upload as an immutable ZIP package and modify bounded body paragraphs plus confirmed, evidence-grounded header/footer text candidates during export. Do not ask a model to generate OOXML and do not rebuild the document with a high-level Word library. Any XML part with no real text change remains byte-identical.

This maximizes preservation of opaque Word features. Unsupported complex objects are preserved but cannot be editable regions. Desktop Word fidelity remains a manual signoff because LibreOffice is the automated renderer.
