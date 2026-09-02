#!/usr/bin/env python3
"""Build polished, internally consistent fictional case packets for demos.

Every identity, organization, address, claim number, event, diagnosis, and
amount in these fixtures is synthetic. The generated PDFs and images are test
inputs for Demand Letter Studio and must not be represented as real records.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from dataclasses import dataclass
from decimal import Decimal
from html import escape
from pathlib import Path
from typing import Iterable

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from PIL import Image
from pypdf import PdfReader


DISCLAIMER = "SYNTHETIC TEST DATA - NOT A REAL CLAIM, MEDICAL RECORD, BILL, OR DECLARATION"
TEMPLATE_MARKERS = [
    "Pat Donahue",
    "Patrick Donahue",
    "017204635",
    "collins.elaine@ace.aaa.com",
    "[ATTORNEY REVIEW REQUIRED",
]


@dataclass(frozen=True)
class DocumentSpec:
    filename: str
    title: str
    record_type: str
    sections: tuple[tuple[str, tuple[str, ...]], ...]
    page_break_before: tuple[str, ...] = ()


@dataclass(frozen=True)
class CaseSpec:
    slug: str
    case_id: str
    claimant: str
    summary: str
    image_source: str
    image_description: str
    documents: tuple[DocumentSpec, ...]
    expected: dict[str, str]
    scenario_facts: dict[str, object]
    forbidden_names: tuple[str, ...]


def money(value: Decimal | str | int) -> str:
    return f"${Decimal(value):,.2f}"


def total(items: Iterable[tuple[str, Decimal]]) -> Decimal:
    return sum((amount for _, amount in items), start=Decimal("0"))


def doc(
    filename: str,
    title: str,
    record_type: str,
    *sections: tuple[str, tuple[str, ...]],
    page_break_before: tuple[str, ...] = (),
) -> DocumentSpec:
    return DocumentSpec(filename, title, record_type, tuple(sections), page_break_before)


def lines(*values: str) -> tuple[str, ...]:
    return tuple(values)


def build_cases() -> tuple[CaseSpec, ...]:
    naomi_past = (
        ("Fictional Community Emergency Department", Decimal("3480")),
        ("Fictional Capital Radiology", Decimal("940")),
        ("Fictional Midtown Primary Care", Decimal("425")),
        ("Fictional Riverbend Physical Therapy", Decimal("5760")),
        ("Fictional Valley Orthopedics", Decimal("1275")),
        ("Prescription medication", Decimal("185")),
    )
    naomi_future: tuple[tuple[str, Decimal], ...] = ()
    naomi_wages = Decimal("48") * Decimal("34")

    marcus_past = (
        ("Fictional East Bay Trauma Center", Decimal("12850")),
        ("Fictional Bay Imaging", Decimal("4925")),
        ("Fictional Summit Orthopedics", Decimal("5750")),
        ("Shoulder and lumbar MRI studies", Decimal("4600")),
        ("Preoperative physical therapy", Decimal("7200")),
        ("Arthroscopic shoulder repair", Decimal("38500")),
        ("Anesthesia services", Decimal("8750")),
        ("Postoperative physical therapy", Decimal("11520")),
    )
    marcus_future = (
        ("Twelve additional postoperative therapy visits", Decimal("6000")),
        ("Two orthopedic follow-ups", Decimal("2400")),
        ("One lumbar epidural steroid injection", Decimal("10000")),
    )
    marcus_wages = Decimal("360") * Decimal("52")

    elena_past = (
        ("Fictional Peninsula Emergency Department", Decimal("7850")),
        ("Fictional Sequoia Radiology", Decimal("3275")),
        ("Fictional Clearview Neurology", Decimal("4200")),
        ("Vestibular rehabilitation", Decimal("6720")),
        ("Fictional Mission Orthopedics", Decimal("2450")),
        ("Cervical and wrist physical therapy", Decimal("5040")),
        ("Brain and cervical MRI studies", Decimal("3600")),
    )
    elena_future = (
        ("Additional vestibular and cognitive rehabilitation", Decimal("8400")),
        ("Cervical epidural steroid injection", Decimal("9200")),
    )
    elena_wages = Decimal("126") * Decimal("45")

    cases = (
        CaseSpec(
            slug="naomi-carter-conservative-care",
            case_id="DEMO-NC-2026-0417",
            claimant="Naomi Carter",
            summary="Moderate rear-end collision with conservative treatment and no current future-care recommendation.",
            image_source="naomi-carter-rear-damage.png",
            image_description="White midsize sedan with moderate rear bumper, trunk, and left tail-lamp damage.",
            documents=(
                doc(
                    "01-claim-coverage-and-recipient.pdf",
                    "Synthetic Claim File - Coverage and Recipient",
                    "Claim and coverage record",
                    (
                        "Claim identity",
                        lines(
                            "Claimant: Naomi Carter",
                            "Claimant title and pronouns: Ms. Carter; she and her",
                            "Claim number: PPC-2026-0417",
                            "Named insured and driver: Elliot Reed",
                            "Insurer: Pioneer Peak Casualty Company",
                            "Bodily injury policy limit: $100,000.00 per person",
                            "Policy status on April 17, 2026: Active",
                        ),
                    ),
                    (
                        "Demand recipient",
                        lines(
                            "Adjuster: Dana Kim",
                            "Adjuster email: dana.kim@example.test",
                            "Delivery method: email and certified mail",
                            "Mailing address: 810 Fiction Plaza, Suite 400",
                            "City, state, ZIP: Sacramento, CA 95814",
                        ),
                    ),
                    (
                        "Liability position",
                        lines(
                            "Pioneer Peak accepted 100 percent liability in writing on May 6, 2026.",
                            "No reservation or comparative-negligence position remains open.",
                        ),
                    ),
                ),
                doc(
                    "02-collision-and-liability-report.pdf",
                    "Synthetic Collision and Liability Report",
                    "Collision investigation summary",
                    (
                        "Collision facts",
                        lines(
                            "Date of loss: April 17, 2026",
                            "Time: 7:35 a.m.",
                            "Location: eastbound US 50 near the Watt Avenue exit, Sacramento, California",
                            "Naomi Carter was wearing her seat belt and driving a white midsize sedan.",
                            "Traffic stopped normally for morning congestion.",
                            "Carter stopped with traffic and remained within her lane for several seconds.",
                            "Elliot Reed failed to stop and struck the rear of Carter's vehicle.",
                            "The impact pushed Carter's vehicle forward approximately one car length.",
                            "Carter did not make an unsafe lane change or sudden maneuver.",
                            "Reed told the responding officer that he looked at navigation immediately before impact.",
                        ),
                    ),
                    (
                        "Damage and symptoms",
                        lines(
                            "The rear bumper was dented, the trunk lid buckled, and the left tail lamp cracked.",
                            "The accompanying synthetic photo depicts that rear-area damage.",
                            "Carter reported immediate neck stiffness, upper-back pain, and headache.",
                            "Police conclusion: Reed caused the rear-end collision by failing to stop.",
                            "No evidence indicates comparative negligence by Naomi Carter.",
                        ),
                    ),
                ),
                doc(
                    "03-medical-treatment-record.pdf",
                    "Synthetic Medical Treatment Record",
                    "Combined emergency, therapy, and orthopedic summary",
                    (
                        "Emergency care - April 17, 2026",
                        lines(
                            "Patient: Naomi Carter",
                            "Chief complaints: neck pain, upper-back pain, and headache after a rear-end collision.",
                            "Reported neck pain: 6 out of 10.",
                            "Exam: cervical and thoracic tenderness with reduced cervical rotation.",
                            "Neurologic screening: no acute motor or sensory deficit.",
                            "Cervical and thoracic radiographs: no acute fracture or dislocation.",
                            "Diagnoses: acute cervical strain, thoracic strain, and post-traumatic headache.",
                            "Treatment: examination, radiographs, ibuprofen, and home-care instructions.",
                        ),
                    ),
                    (
                        "Primary care and physical therapy",
                        lines(
                            "Primary-care follow-up date: April 20, 2026.",
                            "Physical therapy dates: April 21, 2026 through June 17, 2026.",
                            "Carter completed 16 physical therapy visits.",
                            "Care included therapeutic exercise, manual therapy, posture training, and a home program.",
                            "Driving, computer work, lifting groceries, and gardening initially aggravated symptoms.",
                            "Headaches resolved by May 29, 2026.",
                            "Neck range of motion and lifting tolerance improved throughout therapy.",
                        ),
                    ),
                    (
                        "Orthopedic closing evaluation - June 24, 2026",
                        lines(
                            "Carter reported approximately 80 percent overall improvement.",
                            "Exam showed mild residual trapezius tenderness without neurologic deficit.",
                            "No injection, surgery, or additional imaging was recommended.",
                            "No future medical care is currently recommended.",
                            "Carter was released to continue an independent home exercise program.",
                        ),
                    ),
                ),
                doc(
                    "04-medical-billing-and-future-care.pdf",
                    "Synthetic Medical Billing and Future Care Summary",
                    "Billing ledger and current care recommendation",
                    (
                        "Past medical charges",
                        tuple(
                            [f"{provider}: {money(amount)}" for provider, amount in naomi_past]
                            + [f"Total past medical expenses: {money(total(naomi_past))}"]
                        ),
                    ),
                    (
                        "Future care",
                        lines(
                            "Current future-care recommendation: none.",
                            "Estimated future medical expenses: $0.00",
                            "Any later care would require a new clinical evaluation and is not included in this demand.",
                        ),
                    ),
                ),
                doc(
                    "05-employment-and-wage-statement.pdf",
                    "Synthetic Employment and Wage Statement",
                    "Employer wage-loss verification",
                    (
                        "Employment record",
                        lines(
                            "Employee: Naomi Carter",
                            "Employer: Fictional Sacramento Public Library Foundation",
                            "Occupation: community programs coordinator",
                            "Dates missed: April 20, 2026 through April 27, 2026",
                            "Hours missed: 48",
                            "Hourly rate: $34.00",
                            f"Total lost wages: {money(naomi_wages)}",
                            "The missed time followed the April 17, 2026 collision and treatment restrictions.",
                        ),
                    ),
                ),
                doc(
                    "06-client-impact-and-demand-instructions.pdf",
                    "Synthetic Client Declaration and Demand Instructions",
                    "Client impact statement and attorney direction",
                    (
                        "Client impact",
                        lines(
                            "Client: Naomi Carter",
                            "Carter had no active neck or upper-back symptoms immediately before the collision.",
                            "Pain interrupted sleep for approximately five weeks.",
                            "Carter needed help carrying groceries and doing laundry for three weeks.",
                            "She stopped gardening and recreational running for approximately eight weeks.",
                            "Turning her head while driving was difficult during the first month.",
                            "Symptoms improved with conservative treatment but disrupted daily life during recovery.",
                        ),
                    ),
                    (
                        "Damages and authority",
                        lines(
                            "Past medical expenses: $12,065.00",
                            "Future medical expenses: $0.00",
                            "Lost wages: $1,632.00",
                            "General damages valuation: $42,000.00",
                            "Authorized settlement demand: $60,000.00",
                            "Demand expiration: November 20, 2026 at 5:00 p.m. Pacific Time",
                            "Delivery instruction: send the response by email and certified mail to counsel.",
                        ),
                    ),
                ),
            ),
            expected={
                "claimant": "Naomi Carter",
                "claimNumber": "PPC-2026-0417",
                "insured": "Elliot Reed",
                "dateOfLoss": "April 17, 2026",
                "policyLimit": "$100,000.00",
                "pastMedicalExpenses": "$12,065.00",
                "futureMedicalExpenses": "$0.00",
                "lostWages": "$1,632.00",
                "demand": "$60,000.00",
                "deadlineDate": "November 20, 2026",
                "deadlineTime": "5:00 p.m. Pacific Time",
            },
            scenario_facts={
                "collisionType": "rear-end",
                "careLevel": "conservative",
                "pastMedicalExpenses": money(total(naomi_past)),
                "futureMedicalExpenses": money(total(naomi_future)),
                "lostWages": money(naomi_wages),
            },
            forbidden_names=("Marcus Lee", "Elena Morales", "Jordan Rivera"),
        ),
        CaseSpec(
            slug="marcus-lee-surgical-care",
            case_id="DEMO-ML-2026-0222",
            claimant="Marcus Lee",
            summary="High-value side-impact collision with arthroscopic shoulder repair and documented future care.",
            image_source="marcus-lee-side-damage.png",
            image_description="Dark blue compact SUV with substantial driver-side door intrusion and side-curtain deployment.",
            documents=(
                doc(
                    "01-claim-coverage-and-recipient.pdf",
                    "Synthetic Claim File - Coverage and Recipient",
                    "Claim and coverage record",
                    (
                        "Claim identity",
                        lines(
                            "Claimant: Marcus Lee",
                            "Claimant title and pronouns: Mr. Lee; he and him",
                            "Claim number: RCX-2026-22091",
                            "Named insured and driver: Olivia Hart",
                            "Insurer: Redwood Crest Exchange",
                            "Bodily injury policy limit: $250,000.00 per person",
                            "Policy status on February 22, 2026: Active",
                        ),
                    ),
                    (
                        "Demand recipient",
                        lines(
                            "Adjuster: Samuel Ortiz",
                            "Adjuster email: samuel.ortiz@example.test",
                            "Delivery method: email and overnight delivery",
                            "Mailing address: 2250 Hypothetical Street, Floor 8",
                            "City, state, ZIP: Oakland, CA 94612",
                        ),
                    ),
                    (
                        "Liability position",
                        lines(
                            "Redwood Crest accepted 100 percent liability in writing on March 18, 2026.",
                            "The insurer confirmed that no comparative-negligence allocation is asserted.",
                        ),
                    ),
                ),
                doc(
                    "02-collision-and-liability-report.pdf",
                    "Synthetic Collision and Liability Report",
                    "Collision investigation summary",
                    (
                        "Collision facts",
                        lines(
                            "Date of loss: February 22, 2026",
                            "Time: 1:10 p.m.",
                            "Location: Broadway at 14th Street, Oakland, California",
                            "Marcus Lee was wearing his seat belt and driving a dark blue compact SUV.",
                            "Lee entered the intersection on a green signal at approximately 24 miles per hour.",
                            "Olivia Hart entered against a red signal and struck the driver's side of Lee's SUV.",
                            "Two independent witnesses reported that Lee had the green signal.",
                            "Intersection video reviewed by police was consistent with the witness accounts.",
                            "Lee had no reasonable opportunity to avoid the impact.",
                        ),
                    ),
                    (
                        "Damage and symptoms",
                        lines(
                            "Both driver-side doors sustained substantial intrusion and side-curtain airbags deployed.",
                            "The accompanying synthetic photo depicts the driver-side damage.",
                            "Lee reported immediate left-shoulder pain, low-back pain, and left-rib pain.",
                            "Police conclusion: Hart caused the collision by entering against a red signal.",
                            "No evidence indicates comparative negligence by Marcus Lee.",
                        ),
                    ),
                ),
                doc(
                    "03-medical-treatment-record.pdf",
                    "Synthetic Medical Treatment and Surgical Record",
                    "Emergency, orthopedic, imaging, surgical, and rehabilitation summary",
                    (
                        "Emergency care - February 22, 2026",
                        lines(
                            "Patient: Marcus Lee",
                            "Chief complaints: severe left-shoulder pain, low-back pain, and left-rib pain.",
                            "Reported shoulder pain: 9 out of 10.",
                            "Exam: guarded left shoulder, lumbar tenderness, and left-rib tenderness.",
                            "Chest and rib imaging: no displaced fracture or pneumothorax.",
                            "Shoulder radiographs: no acute fracture; joint alignment maintained.",
                            "Diagnoses: left-shoulder sprain, lumbar strain, and left-rib contusion.",
                            "Treatment: analgesic medication, sling, activity restrictions, and orthopedic referral.",
                        ),
                    ),
                    (
                        "Orthopedic care and imaging",
                        lines(
                            "Initial orthopedic visit: February 26, 2026.",
                            "Exam showed painful shoulder clicking, weakness, and positive labral testing.",
                            "Left-shoulder MRI date: March 12, 2026.",
                            "MRI: anterior-inferior labral tear with paralabral cyst and rotator-cuff tendinosis.",
                            "Lumbar MRI date: March 12, 2026.",
                            "MRI: L4-5 4 mm posterior disc protrusion with moderate right foraminal narrowing.",
                            "Lee completed 18 preoperative physical therapy visits without durable shoulder relief.",
                        ),
                    ),
                    (
                        "Surgery and postoperative care",
                        lines(
                            "Procedure date: May 12, 2026.",
                            "Procedure: left-shoulder arthroscopy with labral repair, debridement, and capsular stabilization.",
                            "The surgeon documented the repair as related to the February 22, 2026 collision.",
                            "Lee completed 24 postoperative physical therapy visits through September 4, 2026.",
                            "Range of motion improved, but overhead endurance and lifting strength remained limited.",
                            "Low-back pain persisted with prolonged sitting and intermittent right-leg symptoms.",
                        ),
                    ),
                    (
                        "Current recommendations",
                        lines(
                            "Twelve additional postoperative therapy visits are recommended.",
                            "Two orthopedic follow-up visits are recommended.",
                            "One fluoroscopically guided lumbar epidural steroid injection at L4-5 is recommended.",
                            "Further shoulder intervention depends on progress after rehabilitation.",
                        ),
                    ),
                    page_break_before=("Surgery and postoperative care",),
                ),
                doc(
                    "04-medical-billing-and-future-care.pdf",
                    "Synthetic Medical Billing and Future Care Summary",
                    "Billing ledger and prospective-care estimate",
                    (
                        "Past medical charges",
                        tuple(
                            [f"{provider}: {money(amount)}" for provider, amount in marcus_past]
                            + [f"Total past medical expenses: {money(total(marcus_past))}"]
                        ),
                    ),
                    (
                        "Future medical estimate",
                        tuple(
                            [f"{service}: {money(amount)}" for service, amount in marcus_future]
                            + [f"Total estimated future medical expenses: {money(total(marcus_future))}"]
                            + ["The estimates correspond to the current recommendations in the treatment record."]
                        ),
                    ),
                ),
                doc(
                    "05-employment-and-wage-statement.pdf",
                    "Synthetic Employment and Wage Statement",
                    "Employer wage-loss verification",
                    (
                        "Employment record",
                        lines(
                            "Employee: Marcus Lee",
                            "Employer: Fictional Bay Logistics Cooperative",
                            "Occupation: warehouse operations manager",
                            "Dates missed: February 23, 2026 through May 6, 2026",
                            "Hours missed: 360",
                            "Hourly rate: $52.00",
                            f"Total lost wages: {money(marcus_wages)}",
                            "Lee returned to modified work before surgery and resumed full-time modified work afterward.",
                            "The missed time and restrictions followed the February 22, 2026 collision.",
                        ),
                    ),
                ),
                doc(
                    "06-client-impact-and-demand-instructions.pdf",
                    "Synthetic Client Declaration and Demand Instructions",
                    "Client impact statement and attorney direction",
                    (
                        "Client impact",
                        lines(
                            "Client: Marcus Lee",
                            "Lee had no left-shoulder limitation or radiating low-back symptoms immediately before the collision.",
                            "He could not drive for four weeks and required help dressing after surgery.",
                            "He slept in a recliner for approximately six weeks after surgery.",
                            "He could not lift his young child or perform home repairs for several months.",
                            "Lee stopped recreational basketball and weight training.",
                            "Ongoing low-back pain limits prolonged driving, sitting, and warehouse-floor inspections.",
                            "The surgical recovery and work restrictions substantially reduced his independence.",
                        ),
                    ),
                    (
                        "Damages and authority",
                        lines(
                            "Past medical expenses: $94,095.00",
                            "Future medical expenses: $18,400.00",
                            "Lost wages: $18,720.00",
                            "General damages valuation: $300,000.00",
                            "Authorized settlement demand: $250,000.00 policy limits",
                            "Demand expiration: December 1, 2026 at 5:00 p.m. Pacific Time",
                            "Delivery instruction: send the response by email and overnight delivery to counsel.",
                        ),
                    ),
                ),
            ),
            expected={
                "claimant": "Marcus Lee",
                "claimNumber": "RCX-2026-22091",
                "insured": "Olivia Hart",
                "dateOfLoss": "February 22, 2026",
                "policyLimit": "$250,000.00",
                "pastMedicalExpenses": "$94,095.00",
                "futureMedicalExpenses": "$18,400.00",
                "lostWages": "$18,720.00",
                "demand": "$250,000.00",
                "deadlineDate": "December 1, 2026",
                "deadlineTime": "5:00 p.m. Pacific Time",
            },
            scenario_facts={
                "collisionType": "side-impact",
                "careLevel": "surgical",
                "pastMedicalExpenses": money(total(marcus_past)),
                "futureMedicalExpenses": money(total(marcus_future)),
                "lostWages": money(marcus_wages),
            },
            forbidden_names=("Naomi Carter", "Elena Morales", "Jordan Rivera"),
        ),
        CaseSpec(
            slug="elena-morales-concussion-care",
            case_id="DEMO-EM-2026-0609",
            claimant="Elena Morales",
            summary="Mid-value offset frontal collision with concussion, vestibular rehabilitation, and cervical future care.",
            image_source="elena-morales-front-damage.png",
            image_description="Silver compact hatchback with moderate right-front fender, bumper, headlamp, and hood-edge damage.",
            documents=(
                doc(
                    "01-claim-coverage-and-recipient.pdf",
                    "Synthetic Claim File - Coverage and Recipient",
                    "Claim and coverage record",
                    (
                        "Claim identity",
                        lines(
                            "Claimant: Elena Morales",
                            "Claimant title and pronouns: Ms. Morales; she and her",
                            "Claim number: RHI-2026-0908",
                            "Named insured and driver: Nolan Pierce",
                            "Insurer: Rainier Harbor Indemnity",
                            "Bodily injury policy limit: $100,000.00 per person",
                            "Policy status on June 9, 2026: Active",
                        ),
                    ),
                    (
                        "Demand recipient",
                        lines(
                            "Adjuster: Aisha Grant",
                            "Adjuster email: aisha.grant@example.test",
                            "Delivery method: email only",
                            "Mailing address: 42 Example Quay, Suite 610",
                            "City, state, ZIP: San Francisco, CA 94105",
                        ),
                    ),
                    (
                        "Liability position",
                        lines(
                            "Rainier Harbor accepted 100 percent liability in writing on July 1, 2026.",
                            "The carrier stated that no comparative-negligence defense is asserted.",
                        ),
                    ),
                ),
                doc(
                    "02-collision-and-liability-report.pdf",
                    "Synthetic Collision and Liability Report",
                    "Collision investigation summary",
                    (
                        "Collision facts",
                        lines(
                            "Date of loss: June 9, 2026",
                            "Time: 6:45 p.m.",
                            "Location: Mission Street at 11th Street, San Francisco, California",
                            "Elena Morales was wearing her seat belt and driving a silver compact hatchback.",
                            "Morales traveled straight through the intersection on a green signal.",
                            "Nolan Pierce turned left across Morales's lane and failed to yield.",
                            "Morales braked and steered right but could not avoid the collision.",
                            "The right-front corner of Morales's hatchback struck the passenger side of Pierce's vehicle.",
                            "A neutral witness confirmed that Morales had the right of way.",
                        ),
                    ),
                    (
                        "Damage and symptoms",
                        lines(
                            "The right-front fender crumpled, the bumper cracked, and the right headlamp displaced.",
                            "The accompanying synthetic photo depicts the right-front damage.",
                            "Morales's head struck the head restraint; she did not lose consciousness.",
                            "She reported headache, dizziness, neck pain, right-wrist pain, and right-knee pain.",
                            "Police conclusion: Pierce caused the collision by failing to yield while turning left.",
                            "No evidence indicates comparative negligence by Elena Morales.",
                        ),
                    ),
                ),
                doc(
                    "03-medical-treatment-record.pdf",
                    "Synthetic Medical Treatment and Diagnostic Record",
                    "Emergency, neurology, rehabilitation, orthopedic, and imaging summary",
                    (
                        "Emergency care - June 9, 2026",
                        lines(
                            "Patient: Elena Morales",
                            "Chief complaints: headache, dizziness, neck pain, right-wrist pain, and right-knee pain.",
                            "Glasgow Coma Scale: 15; no reported loss of consciousness.",
                            "Exam: cervical tenderness, right-wrist swelling, and right-knee bruising.",
                            "Head CT: no acute intracranial hemorrhage.",
                            "Wrist and knee radiographs: no acute fracture.",
                            "Diagnoses: mild concussion, cervical strain, right-wrist sprain, and right-knee contusion.",
                            "Treatment: wrist brace, medication, concussion precautions, and follow-up referrals.",
                        ),
                    ),
                    (
                        "Neurology and vestibular rehabilitation",
                        lines(
                            "Neurology consultation date: June 16, 2026.",
                            "Symptoms included daily headache, visual sensitivity, dizziness, and slowed concentration.",
                            "Exam showed symptom provocation with smooth pursuit and head movement.",
                            "Brain MRI date: June 22, 2026; no acute structural injury identified.",
                            "Morales completed 18 vestibular rehabilitation visits through September 8, 2026.",
                            "Headache frequency and balance improved, but busy visual environments still provoked symptoms.",
                        ),
                    ),
                    (
                        "Orthopedic and cervical care",
                        lines(
                            "Orthopedic consultation date: June 18, 2026.",
                            "Wrist and knee symptoms improved with bracing and therapeutic exercise.",
                            "Cervical MRI date: July 2, 2026.",
                            "MRI: C5-6 3 mm posterior disc protrusion with mild central-canal narrowing.",
                            "Morales completed 14 cervical and wrist physical therapy visits.",
                            "Persistent neck pain increased with computer work and rotation.",
                        ),
                    ),
                    (
                        "Current recommendations",
                        lines(
                            "Eight additional vestibular and cognitive rehabilitation visits are recommended.",
                            "A cervical epidural steroid injection at C5-6 is recommended if pain persists.",
                            "Further concussion treatment depends on symptom response and neurologic reassessment.",
                        ),
                    ),
                ),
                doc(
                    "04-medical-billing-and-future-care.pdf",
                    "Synthetic Medical Billing and Future Care Summary",
                    "Billing ledger and prospective-care estimate",
                    (
                        "Past medical charges",
                        tuple(
                            [f"{provider}: {money(amount)}" for provider, amount in elena_past]
                            + [f"Total past medical expenses: {money(total(elena_past))}"]
                        ),
                    ),
                    (
                        "Future medical estimate",
                        tuple(
                            [f"{service}: {money(amount)}" for service, amount in elena_future]
                            + [f"Total estimated future medical expenses: {money(total(elena_future))}"]
                            + ["The estimates correspond to the current recommendations in the treatment record."]
                        ),
                    ),
                ),
                doc(
                    "05-employment-and-wage-statement.pdf",
                    "Synthetic Employment and Wage Statement",
                    "Employer wage-loss verification",
                    (
                        "Employment record",
                        lines(
                            "Employee: Elena Morales",
                            "Employer: Fictional Northstar Design Studio",
                            "Occupation: digital product designer",
                            "Dates missed: June 10, 2026 through July 1, 2026",
                            "Hours missed: 126",
                            "Hourly rate: $45.00",
                            f"Total lost wages: {money(elena_wages)}",
                            "Morales returned on a reduced-screen-time schedule before resuming full-time work.",
                            "The missed time and restrictions followed the June 9, 2026 collision.",
                        ),
                    ),
                ),
                doc(
                    "06-client-impact-and-demand-instructions.pdf",
                    "Synthetic Client Declaration and Demand Instructions",
                    "Client impact statement and attorney direction",
                    (
                        "Client impact",
                        lines(
                            "Client: Elena Morales",
                            "Morales had no active headaches, dizziness, or neck limitation immediately before the collision.",
                            "For six weeks, screens and grocery-store lighting provoked headaches and nausea.",
                            "She relied on family for transportation during the first three weeks.",
                            "She stopped recreational dance classes and avoided crowded events.",
                            "Concentration limits affected detailed design work and video meetings.",
                            "Neck pain continues with prolonged computer use and checking blind spots while driving.",
                            "The symptoms caused anxiety about driving through intersections.",
                        ),
                    ),
                    (
                        "Damages and authority",
                        lines(
                            "Past medical expenses: $33,135.00",
                            "Future medical expenses: $17,600.00",
                            "Lost wages: $5,670.00",
                            "General damages valuation: $110,000.00",
                            "Authorized settlement demand: $100,000.00 policy limits",
                            "Demand expiration: December 18, 2026 at 5:00 p.m. Pacific Time",
                            "Delivery instruction: send the response by email to counsel.",
                        ),
                    ),
                ),
            ),
            expected={
                "claimant": "Elena Morales",
                "claimNumber": "RHI-2026-0908",
                "insured": "Nolan Pierce",
                "dateOfLoss": "June 9, 2026",
                "policyLimit": "$100,000.00",
                "pastMedicalExpenses": "$33,135.00",
                "futureMedicalExpenses": "$17,600.00",
                "lostWages": "$5,670.00",
                "demand": "$100,000.00",
                "deadlineDate": "December 18, 2026",
                "deadlineTime": "5:00 p.m. Pacific Time",
            },
            scenario_facts={
                "collisionType": "left-turn offset frontal",
                "careLevel": "concussion and orthopedic",
                "pastMedicalExpenses": money(total(elena_past)),
                "futureMedicalExpenses": money(total(elena_future)),
                "lostWages": money(elena_wages),
            },
            forbidden_names=("Naomi Carter", "Marcus Lee", "Jordan Rivera"),
        ),
    )

    for case in cases:
        assert len(case.documents) + 1 <= 10, f"{case.slug} exceeds the source upload limit"
        assert case.expected["pastMedicalExpenses"] == case.scenario_facts["pastMedicalExpenses"]
        assert case.expected["futureMedicalExpenses"] == case.scenario_facts["futureMedicalExpenses"]
        assert case.expected["lostWages"] == case.scenario_facts["lostWages"]
    return cases


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "FixtureTitle",
            parent=base["Title"],
            fontName="Helvetica-Bold",
            fontSize=17,
            leading=21,
            textColor=colors.HexColor("#172B4D"),
            spaceAfter=10,
        ),
        "banner": ParagraphStyle(
            "FixtureBanner",
            parent=base["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=9,
            leading=12,
            alignment=TA_CENTER,
            textColor=colors.HexColor("#8A1C1C"),
        ),
        "metadata": ParagraphStyle(
            "FixtureMetadata",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.8,
            leading=12,
            textColor=colors.HexColor("#3D4B5C"),
        ),
        "heading": ParagraphStyle(
            "FixtureHeading",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=10.5,
            leading=13,
            textColor=colors.HexColor("#0A5F78"),
            spaceBefore=10,
            spaceAfter=5,
            keepWithNext=True,
        ),
        "fact": ParagraphStyle(
            "FixtureFact",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=9.3,
            leading=12.4,
            textColor=colors.HexColor("#1F2933"),
            leftIndent=10,
            firstLineIndent=-8,
            spaceAfter=2.5,
        ),
    }


def page_decorations(canvas, document, *, case: CaseSpec, record_type: str) -> None:
    canvas.saveState()
    width, height = letter
    canvas.setFillColor(colors.HexColor("#64748B"))
    canvas.setFont("Helvetica-Bold", 7.5)
    canvas.drawString(0.62 * inch, height - 0.36 * inch, "STENO DEMO FIXTURE | SYNTHETIC")
    canvas.setFont("Helvetica", 7.2)
    canvas.drawRightString(width - 0.62 * inch, height - 0.36 * inch, record_type.upper())
    canvas.setStrokeColor(colors.HexColor("#CBD5E1"))
    canvas.line(0.62 * inch, height - 0.42 * inch, width - 0.62 * inch, height - 0.42 * inch)

    canvas.setFillColor(colors.HexColor("#E8EEF3"))
    canvas.setFont("Helvetica-Bold", 38)
    canvas.translate(width / 2, height / 2)
    canvas.rotate(34)
    canvas.drawCentredString(0, 0, "SYNTHETIC TEST DATA")
    canvas.rotate(-34)
    canvas.translate(-width / 2, -height / 2)

    canvas.setStrokeColor(colors.HexColor("#CBD5E1"))
    canvas.line(0.62 * inch, 0.48 * inch, width - 0.62 * inch, 0.48 * inch)
    canvas.setFillColor(colors.HexColor("#64748B"))
    canvas.setFont("Helvetica", 7.2)
    canvas.drawString(0.62 * inch, 0.28 * inch, f"{case.case_id} | NOT FOR LEGAL OR CLINICAL USE")
    canvas.drawRightString(
        width - 0.62 * inch,
        0.28 * inch,
        f"Page {document.page}",
    )
    canvas.restoreState()


def write_document_pdf(path: Path, case: CaseSpec, spec: DocumentSpec) -> None:
    style = styles()
    document = SimpleDocTemplate(
        str(path),
        pagesize=letter,
        rightMargin=0.65 * inch,
        leftMargin=0.65 * inch,
        topMargin=0.68 * inch,
        bottomMargin=0.65 * inch,
        title=spec.title,
        author="Steno Demand Letter Studio synthetic fixture generator",
        subject=DISCLAIMER,
    )
    story = [Paragraph(escape(spec.title), style["title"])]
    banner = Table(
        [[Paragraph(DISCLAIMER, style["banner"])]],
        colWidths=[7.1 * inch],
        hAlign="LEFT",
    )
    banner.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FFF1F1")),
                ("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#D45B5B")),
                ("LEFTPADDING", (0, 0), (-1, -1), 9),
                ("RIGHTPADDING", (0, 0), (-1, -1), 9),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
            ]
        )
    )
    story.extend([banner, Spacer(1, 10)])

    metadata = Table(
        [
            [Paragraph("Case ID", style["metadata"]), Paragraph(escape(case.case_id), style["metadata"])],
            [Paragraph("Claimant", style["metadata"]), Paragraph(escape(case.claimant), style["metadata"])],
            [Paragraph("Record type", style["metadata"]), Paragraph(escape(spec.record_type), style["metadata"])],
        ],
        colWidths=[1.05 * inch, 6.05 * inch],
        hAlign="LEFT",
    )
    metadata.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#E7F3F6")),
                ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#B7CBD2")),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    story.extend([metadata, Spacer(1, 4)])

    for heading, facts in spec.sections:
        if heading in spec.page_break_before:
            story.append(PageBreak())
        story.append(Paragraph(escape(heading).upper(), style["heading"]))
        for fact in facts:
            story.append(Paragraph(f"- {escape(fact)}", style["fact"]))

    callback = lambda canvas, doc: page_decorations(
        canvas,
        doc,
        case=case,
        record_type=spec.record_type,
    )
    document.build(story, onFirstPage=callback, onLaterPages=callback)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalized(value: str) -> str:
    return " ".join(value.casefold().split())


def validate_generated_sources(
    case: CaseSpec,
    source_dir: Path,
    source_names: list[str],
) -> dict[str, object]:
    pdf_names = [name for name in source_names if name.endswith(".pdf")]
    extracted_pages: list[str] = []
    page_count = 0
    for name in pdf_names:
        reader = PdfReader(source_dir / name)
        if not reader.pages:
            raise ValueError(f"{name} contains no pages")
        for page in reader.pages:
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            if abs(width - 612) > 0.1 or abs(height - 792) > 0.1:
                raise ValueError(f"{name} is not US Letter: {width} x {height}")
            text = page.extract_text() or ""
            if not text.strip():
                raise ValueError(f"{name} page {page_count + 1} has no extractable text")
            extracted_pages.append(text)
            page_count += 1

    combined = normalized("\n".join(extracted_pages))
    missing_expected = [
        value
        for value in case.expected.values()
        if normalized(value) not in combined
    ]
    if missing_expected:
        raise ValueError(f"{case.slug} is missing expected facts: {missing_expected}")
    forbidden_present = [
        marker
        for marker in [*TEMPLATE_MARKERS, *case.forbidden_names]
        if normalized(marker) in combined
    ]
    if forbidden_present:
        raise ValueError(f"{case.slug} contains forbidden markers: {forbidden_present}")
    if normalized(DISCLAIMER) not in combined:
        raise ValueError(f"{case.slug} is missing the synthetic-data disclaimer")

    image_path = source_dir / "07-vehicle-damage-photo.png"
    with Image.open(image_path) as image:
        image.verify()
    with Image.open(image_path) as image:
        image_width, image_height = image.size
        image_format = image.format
    if image_format != "PNG" or image_width < 1200 or image_height < 800:
        raise ValueError(
            f"{case.slug} vehicle image is not a sufficiently large PNG: "
            f"{image_format} {image_width} x {image_height}"
        )

    return {
        "passed": True,
        "sourceCount": len(source_names),
        "pdfCount": len(pdf_names),
        "pdfPageCount": page_count,
        "allPdfPagesUsLetter": True,
        "allExpectedFactsPresentInPdfText": True,
        "forbiddenTemplateAndCrossCaseMarkersAbsent": True,
        "vehicleImage": {
            "format": image_format,
            "width": image_width,
            "height": image_height,
        },
    }


def write_case(case: CaseSpec, output_root: Path, image_root: Path) -> dict[str, object]:
    case_dir = output_root / case.slug
    source_dir = case_dir / "sources"
    if case_dir.exists():
        shutil.rmtree(case_dir)
    source_dir.mkdir(parents=True)

    for spec in case.documents:
        write_document_pdf(source_dir / spec.filename, case, spec)

    input_image = image_root / case.image_source
    if not input_image.is_file():
        raise FileNotFoundError(f"Missing generated demo image: {input_image}")
    photo_name = "07-vehicle-damage-photo.png"
    shutil.copy2(input_image, source_dir / photo_name)

    source_names = sorted(path.name for path in source_dir.iterdir() if path.is_file())
    validation = validate_generated_sources(case, source_dir, source_names)
    manifest = {
        "schemaVersion": 1,
        "fictional": True,
        "caseName": f"{case.claimant} synthetic demo case",
        "caseId": case.case_id,
        "summary": case.summary,
        "templateInstruction": (
            "Use the supplied Pat Donahue DOCX only as the reviewed firm template. "
            "Upload only the files in this case's sources directory as evidence."
        ),
        "sourceCount": len(source_names),
        "sources": source_names,
        "vehicleImageDescription": case.image_description,
        "expected": case.expected,
        "scenarioFacts": case.scenario_facts,
        "mustNotAppearInCompleteExport": [*TEMPLATE_MARKERS, *case.forbidden_names],
        "sourceSha256": {
            name: sha256(source_dir / name)
            for name in source_names
        },
        "validation": validation,
        "safety": {
            "realPersonData": False,
            "realMedicalData": False,
            "realClaimData": False,
            "authorizedUse": "software demonstration and testing only",
            "notForTransmission": True,
        },
    }
    (case_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (case_dir / "UPLOAD-INSTRUCTIONS.txt").write_text(
        "STENO DEMAND LETTER STUDIO - SYNTHETIC DEMO CASE\n\n"
        f"Matter name: {case.claimant} synthetic demo case\n"
        "Template: upload/select the supplied Pat Donahue DOCX as the firm template.\n"
        "Evidence: select all seven files inside this case's sources directory at once.\n"
        "Do not upload manifest.json or this instruction file as case evidence.\n"
        "Every person, organization, event, diagnosis, amount, and image is fictional.\n"
        "The generated demand must be reviewed and must never be sent.\n",
        encoding="utf-8",
    )
    return manifest


def write_index(output_root: Path, manifests: list[dict[str, object]]) -> None:
    rows = []
    for manifest in manifests:
        expected = manifest["expected"]
        rows.append(
            "| {name} | {summary} | {past} | {future} | {wages} | {demand} |".format(
                name=manifest["caseName"],
                summary=manifest["summary"],
                past=expected["pastMedicalExpenses"],
                future=expected["futureMedicalExpenses"],
                wages=expected["lostWages"],
                demand=expected["demand"],
            )
        )
    (output_root / "README.md").write_text(
        "# Synthetic demo case packets\n\n"
        "These packets contain fictional test data only. For each demo, select the supplied Pat "
        "Donahue DOCX as the reviewed firm template, create a new matter, and upload only the seven "
        "files from one case's `sources/` directory. Do not mix files between cases.\n\n"
        "| Case | Scenario | Past medical | Future medical | Lost wages | Demand |\n"
        "| --- | --- | ---: | ---: | ---: | ---: |\n"
        + "\n".join(rows)
        + "\n\nEach case includes `manifest.json` with expected facts, forbidden template markers, and SHA-256 hashes.\n",
        encoding="utf-8",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output_dir",
        nargs="?",
        type=Path,
        default=Path("output/pdf/demo-cases"),
        help="Destination root (default: output/pdf/demo-cases)",
    )
    parser.add_argument(
        "--image-dir",
        type=Path,
        default=Path("tests/fixtures/demo-case-images"),
        help="Directory containing the three generated vehicle images",
    )
    parser.add_argument(
        "--case",
        action="append",
        choices=[case.slug for case in build_cases()],
        help="Generate only a named case; repeat for multiple cases",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_root = args.output_dir.resolve()
    image_root = args.image_dir.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    selected = [case for case in build_cases() if not args.case or case.slug in args.case]
    manifests = [write_case(case, output_root, image_root) for case in selected]
    write_index(output_root, manifests)
    print(
        json.dumps(
            {
                "output": str(output_root),
                "caseCount": len(manifests),
                "pdfCount": sum(len(case.documents) for case in selected),
                "imageCount": len(selected),
                "sourceCount": sum(manifest["sourceCount"] for manifest in manifests),
            }
        )
    )


if __name__ == "__main__":
    main()
