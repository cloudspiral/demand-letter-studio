#!/usr/bin/env python3
"""Generate a complete fictional case packet and adversarial variants.

Every name, address, claim number, event, diagnosis and amount is fictional.
The packet is designed to exercise all case-specific regions of the supplied
six-page demand-letter template without transmitting another person's records.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path


def pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def write_text_pdf(path: Path, title: str, lines: list[str]) -> None:
    content_lines = [
        "BT",
        "/F1 15 Tf",
        "54 750 Td",
        f"({pdf_escape(title)}) Tj",
        "/F1 10 Tf",
        "0 -26 Td",
    ]
    for line in lines:
        content_lines.extend([f"({pdf_escape(line)}) Tj", "0 -16 Td"])
    content_lines.append("ET")
    stream = "\n".join(content_lines).encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    payload = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(payload))
        payload.extend(f"{index} 0 obj\n".encode("ascii"))
        payload.extend(obj)
        payload.extend(b"\nendobj\n")
    xref_offset = len(payload)
    payload.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    payload.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        payload.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    payload.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    path.write_bytes(payload)


SOURCES: dict[str, tuple[str, list[str]]] = {
    "01-claim-coverage-and-recipient.pdf": (
        "Synthetic Claim File - Coverage and Recipient",
        [
            "SYNTHETIC TEST DATA - NOT A REAL CLAIM",
            "Claimant: Jordan Rivera",
            "Claimant pronouns: he and him",
            "Claim Number: GLD-2026-31415",
            "Named insured: Casey Bennett",
            "Insurer: Sentinel Mutual Insurance Company",
            "Adjuster: Morgan Lee",
            "Adjuster email: claims@example.test",
            "Delivery method: email only",
            "Adjuster mailing address: 400 Fiction Avenue",
            "Adjuster mailing address line 2: Suite 1200",
            "Adjuster city state zip: Sacramento, CA 95814",
            "Bodily injury policy limit: $250,000.00 per person",
            "Policy active on March 14, 2026: Yes",
            "Sentinel accepted 100 percent liability in writing on April 2, 2026.",
        ],
    ),
    "02-collision-and-liability-report.pdf": (
        "Synthetic Collision and Liability Report",
        [
            "SYNTHETIC TEST DATA - NOT A REAL POLICE REPORT",
            "Claimant: Jordan Rivera",
            "Insured driver: Casey Bennett",
            "Date of Loss: 03/14/2026",
            "Time of collision: 4:20 p.m.",
            "Location: westbound Interstate 80 near the Madison Avenue exit",
            "City and state: Sacramento, California",
            "Jordan Rivera stopped his blue hatchback for congested traffic.",
            "Traffic ahead had been stopped for several seconds before impact.",
            "Casey Bennett failed to stop and struck the rear of Rivera's vehicle.",
            "Bennett told the responding officer that she looked down before impact.",
            "There was no intervening vehicle between Bennett and Rivera.",
            "Rivera wore his seat belt and did not contribute to the collision.",
            "Rivera maintained his lane and made no sudden or unsafe movement.",
            "The impact crushed the rear-left bumper and cracked the left tail lamp.",
            "The impact pushed Rivera's stopped vehicle forward several feet.",
            "Rivera's head and torso moved forward and backward during the impact.",
            "Rivera reported immediate neck, mid-back, and low-back pain.",
            "Photographs taken after the collision show rear-left vehicle damage.",
            "No evidence indicates comparative negligence by Jordan Rivera.",
            "Police conclusion: Casey Bennett caused the rear-end collision.",
            "Insurer liability position: 100 percent accepted.",
        ],
    ),
    "03-emergency-record.pdf": (
        "Synthetic Sierra Emergency Department Record",
        [
            "SYNTHETIC TEST DATA - NOT A REAL MEDICAL RECORD",
            "Patient: Jordan Rivera",
            "Date of service: 03/14/2026",
            "Chief complaints: neck pain, thoracic pain, and low-back pain.",
            "Reported neck pain severity: 8 out of 10.",
            "Reported low-back pain severity: 7 out of 10.",
            "Pain began immediately after the rear-end motor vehicle collision.",
            "Exam showed cervical tenderness and lumbar muscle spasm.",
            "Exam showed reduced cervical rotation because of pain.",
            "Exam showed reduced lumbar flexion because of pain.",
            "Neurologic screening showed no acute motor deficit.",
            "Diagnosis: acute cervical strain.",
            "Diagnosis: thoracic strain.",
            "Diagnosis: lumbar strain.",
            "Treatment: examination, cervical and lumbar radiographs, medication.",
            "Radiographs showed no acute fracture or dislocation.",
            "Medication: naproxen for pain and inflammation.",
            "Medication: cyclobenzaprine for muscle spasm.",
            "Work instruction: avoid lifting more than 15 pounds for one week.",
            "Discharge plan: follow up for persistent pain and limited motion.",
        ],
    ),
    "04-chiropractic-treatment-record.pdf": (
        "Synthetic Pacific Chiropractic Treatment Summary",
        [
            "SYNTHETIC TEST DATA - NOT A REAL MEDICAL RECORD",
            "Patient: Jordan Rivera",
            "Initial visit: 03/18/2026",
            "Final documented visit: 06/20/2026",
            "Jordan Rivera completed 20 chiropractic treatment visits.",
            "Initial findings included restricted cervical and lumbar motion.",
            "Initial findings included cervical and lumbar muscle spasm.",
            "Initial findings included tenderness from C3 through C7.",
            "Initial findings included tenderness from L3 through S1.",
            "Cervical compression testing reproduced neck pain.",
            "Right straight-leg raise reproduced low-back and leg pain.",
            "Symptoms included headaches, neck pain, and low-back pain.",
            "Low-back pain intermittently radiated into the right leg.",
            "Prolonged sitting, bending, lifting, and driving aggravated symptoms.",
            "Sleep was interrupted by neck and back pain.",
            "Care included manipulation, therapeutic exercise, and heat therapy.",
            "Care also included soft-tissue therapy and home stretching instruction.",
            "Visit frequency decreased as objective range of motion improved.",
            "Headache frequency improved during the course of care.",
            "Rivera improved but continued to report activity-related pain.",
            "Final exam still showed lumbar tenderness and limited flexion.",
        ],
    ),
    "05-pain-management-and-mri.pdf": (
        "Synthetic Coastal Pain and Imaging Report",
        [
            "SYNTHETIC TEST DATA - NOT A REAL MEDICAL RECORD",
            "Patient: Jordan Rivera",
            "Pain management consultation date: 05/02/2026",
            "Reported neck pain: 7 out of 10 with rotation and extension.",
            "Reported low-back pain: 8 out of 10 with intermittent right-leg pain.",
            "Pain increased with sitting, driving, bending, and lifting.",
            "Exam: cervical facet tenderness and positive right Spurling test.",
            "Exam: lumbar facet tenderness and positive right straight-leg raise.",
            "Exam: reduced cervical rotation and reduced lumbar flexion.",
            "Assessment: cervical myofascial pain and facet-mediated pain.",
            "Assessment: lumbar myofascial pain with right lumbar radicular symptoms.",
            "Thoracic MRI date: 05/08/2026",
            "Thoracic MRI: T6-7 1.5 mm posterior disc protrusion.",
            "Thoracic MRI: T7-8 2 mm posterior disc protrusion.",
            "Thoracic MRI: the protrusion mildly indents the ventral thecal sac.",
            "Thoracic MRI: T8-9 1 mm posterior disc protrusion.",
            "Thoracic MRI: no acute compression fracture.",
            "Lumbar MRI date: 05/08/2026",
            "Lumbar MRI: L3-4 2 mm posterior disc protrusion.",
            "Lumbar MRI: L4-5 3 mm posterior disc protrusion.",
            "Lumbar MRI: the protrusion causes mild bilateral foraminal narrowing.",
            "Lumbar MRI: L5-S1 2 mm posterior disc protrusion.",
            "Lumbar MRI: no acute osseous injury.",
            "Follow-up date: 05/15/2026",
            "Assessment: cervical, thoracic, and lumbar pain after the collision.",
            "Rivera continued to report low-back pain despite conservative care.",
            "The physician reviewed the MRI findings with Jordan Rivera.",
            "Recommendation: lumbar epidural steroid injection at L4-5.",
            "The recommendation was made because pain persisted after therapy.",
        ],
    ),
    "06-medical-billing-summary.pdf": (
        "Synthetic Medical Billing Summary",
        [
            "SYNTHETIC TEST DATA - NOT A REAL BILL",
            "Patient: Jordan Rivera",
            "Sierra Emergency Department charges: $4,825.00",
            "Vista Radiology charges: $1,275.00",
            "Pacific Chiropractic charges: $8,400.00",
            "Coastal Pain Specialists charges: $2,950.00",
            "MAX MRI charges: $3,200.00",
            "Total past medical expenses: $20,650.00",
            "All listed charges arise from care after the March 14, 2026 collision.",
        ],
    ),
    "07-future-care-estimate.pdf": (
        "Synthetic Future Care Estimate",
        [
            "SYNTHETIC TEST DATA - NOT A REAL MEDICAL ESTIMATE",
            "Patient: Jordan Rivera",
            "Recommended procedure: lumbar epidural steroid injection at L4-5.",
            "Purpose: reduce inflammation and right-sided radicular pain.",
            "Procedure includes fluoroscopic guidance and contrast confirmation.",
            "Estimated injection facility and physician charge: $7,500.00",
            "Estimated follow-up and rehabilitation charge: $1,000.00",
            "Total estimated future medical expenses: $8,500.00",
            "The estimate includes one post-procedure reassessment.",
            "Further treatment depends on Rivera's response to the injection.",
            "The estimate is related to symptoms from the March 14, 2026 collision.",
        ],
    ),
    "08-employment-and-wage-statement.pdf": (
        "Synthetic Employment and Wage Statement",
        [
            "SYNTHETIC TEST DATA - NOT A REAL EMPLOYMENT RECORD",
            "Employee: Jordan Rivera",
            "Employer: Gold Standard Testing Company",
            "Occupation: warehouse supervisor",
            "Dates missed: 03/16/2026 through 03/31/2026",
            "Hours missed: 96",
            "Hourly rate: $40.00",
            "Total lost wages: $3,840.00",
            "The absences followed the March 14, 2026 motor vehicle collision.",
        ],
    ),
    "09-client-impact-and-demand-instructions.pdf": (
        "Synthetic Client Declaration and Attorney Instructions",
        [
            "SYNTHETIC TEST DATA - NOT A REAL DECLARATION OR DEMAND",
            "Client: Jordan Rivera",
            "Rivera had no neck or back pain immediately before this collision.",
            "For twelve weeks, pain interrupted Rivera's sleep every night.",
            "Rivera often woke two or three times nightly because of back pain.",
            "Rivera could not lift his toddler or complete normal household chores.",
            "Rivera relied on family for laundry, groceries, and yard work.",
            "Rivera stopped recreational cycling because riding increased back pain.",
            "Before the collision, Rivera cycled three times each week.",
            "Rivera missed family outings that required prolonged walking or sitting.",
            "Long drives and sitting through a work shift continued to cause pain.",
            "Rivera changed position frequently and used breaks to stretch at work.",
            "Rivera experienced headaches several times each week early in recovery.",
            "Rivera describes anxiety when traffic approaches from behind.",
            "Rivera now checks mirrors repeatedly when stopped in traffic.",
            "The injuries caused frustration and reduced Rivera's independence.",
            "General damages valuation: $175,000.00",
            "Past medical expenses: $20,650.00",
            "Future medical expenses: $8,500.00",
            "Lost wages: $3,840.00",
            "Authorized settlement demand: $250,000.00 policy limits",
            "Demand expiration: October 15, 2026 at 5:00 p.m. Pacific Time",
            "Delivery instruction: send response by email to counsel.",
        ],
    ),
}

CONFLICT_SOURCE = (
    "Synthetic Conflicting Unsigned Intake Sheet",
    [
        "SYNTHETIC ADVERSARIAL TEST DATA - INTENTIONALLY CONFLICTING",
        "Document status: unsigned and unverified intake sheet",
        "Claimant: Jordan A. Rivera",
        "Claim Number: GLD-2026-31451",
        "Date of Loss: 03/15/2026",
        "Bodily injury policy limit: $100,000.00 per person",
        "These values intentionally conflict with the verified claim file.",
    ],
)


def copy_sources(source_dir: Path, destination: Path, names: list[str]) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in names:
        shutil.copy2(source_dir / name, destination / name)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--vehicle-image", type=Path, required=True)
    args = parser.parse_args()
    output_dir = args.output_dir.resolve()
    canonical_dir = output_dir / "canonical-sources"
    canonical_dir.mkdir(parents=True, exist_ok=True)

    for filename, (title, lines) in SOURCES.items():
        write_text_pdf(canonical_dir / filename, title, lines)
    image_name = "10-fictional-vehicle-damage.png"
    shutil.copy2(args.vehicle_image.resolve(), canonical_dir / image_name)
    conflict_name = "10-conflicting-unsigned-intake.pdf"
    write_text_pdf(canonical_dir / conflict_name, *CONFLICT_SOURCE)

    complete_names = [*SOURCES, image_name]
    copy_sources(canonical_dir, output_dir / "complete" / "sources", complete_names)
    copy_sources(
        canonical_dir,
        output_dir / "missing-critical" / "sources",
        ["01-claim-coverage-and-recipient.pdf", "02-collision-and-liability-report.pdf", image_name],
    )
    copy_sources(canonical_dir, output_dir / "conflicting" / "sources", [*SOURCES, conflict_name])
    incremental_initial_names = [name for name in complete_names if name != "08-employment-and-wage-statement.pdf"]
    copy_sources(canonical_dir, output_dir / "incremental" / "initial-sources", incremental_initial_names)
    supplemental_dir = output_dir / "incremental" / "supplemental"
    copy_sources(canonical_dir, supplemental_dir, ["08-employment-and-wage-statement.pdf"])

    manifest = {
        "fictional": True,
        "caseName": "Jordan Rivera synthetic gold case",
        "completeSources": complete_names,
        "missingCriticalSources": [
            "01-claim-coverage-and-recipient.pdf",
            "02-collision-and-liability-report.pdf",
            image_name,
        ],
        "conflictingSources": [*SOURCES, conflict_name],
        "incrementalInitialSources": incremental_initial_names,
        "incrementalSupplementalSource": "08-employment-and-wage-statement.pdf",
        "expected": {
            "claimant": "Jordan Rivera",
            "claimNumber": "GLD-2026-31415",
            "insured": "Casey Bennett",
            "dateOfLoss": "March 14, 2026",
            "policyLimit": "$250,000.00",
            "pastMedicalExpenses": "$20,650.00",
            "futureMedicalExpenses": "$8,500.00",
            "lostWages": "$3,840.00",
            "demand": "$250,000.00",
            "deadlineDate": "October 15, 2026",
            "deadlineTime": "5:00 p.m. Pacific Time",
        },
        "mustNotAppearInCompleteExport": [
            "Pat Donahue",
            "Patrick Donahue",
            "017204635",
            "collins.elaine@ace.aaa.com",
            "[ATTORNEY REVIEW REQUIRED",
        ],
        "acceptanceIntent": {
            "complete": "All case-specific regions should be grounded and exportable.",
            "missingCritical": "Missing medical and damages evidence must lock export.",
            "conflicting": "Conflicting claim, loss-date, and limit values must be surfaced and lock export.",
            "incremental": "The initial missing-wage packet must remain blocked; adding the wage statement and regenerating the same draft should make the next version exportable.",
        },
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output_dir),
        "complete": len(complete_names),
        "missingCritical": 3,
        "conflicting": len(SOURCES) + 1,
        "incrementalInitial": len(incremental_initial_names),
        "incrementalSupplemental": 1,
    }))


if __name__ == "__main__":
    main()
