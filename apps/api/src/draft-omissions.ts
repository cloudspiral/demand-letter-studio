import { GeneratedDraftSchema, type GeneratedDraft, type TemplateAnalysis } from "@steno/contracts";
import { deriveGenerationTargets, templateBlockId } from "./template-map";

export function confirmOmission(
  content: GeneratedDraft,
  targetId: string,
  template: TemplateAnalysis,
): { content: GeneratedDraft; headingCleared: boolean } {
  const outcome = content.outcomes.find((candidate) => candidate.targetId === targetId);
  if (!outcome || outcome.status !== "omitted") throw new Error("Only an omitted target can be confirmed.");
  if (content.confirmedOmissionTargetIds.includes(targetId)) throw new Error("This omission is already confirmed.");

  const confirmed = new Set([...content.confirmedOmissionTargetIds, targetId]);
  const targets = deriveGenerationTargets(template);
  const target = targets.find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("The omitted target is not present in the pinned template map.");
  const sectionTargets = targets.filter((candidate) => candidate.section === target.section);
  const allSectionTargetsOmitted = sectionTargets.length > 0 && sectionTargets.every((candidate) => {
    const candidateOutcome = content.outcomes.find((item) => item.targetId === candidate.id);
    return candidateOutcome?.status === "omitted" && confirmed.has(candidate.id);
  });
  const blocks = template.blocks?.length ? template.blocks : template.regions;
  const hasKeptBodyContent = blocks.some((block) => (
    block.section === target.section
    && block.semanticKind !== "heading"
    && block.semanticKind !== "figure"
    && block.role !== "editable"
    && block.text.trim().length > 0
  ));
  const headingIds = new Set(blocks.filter((block) => (
    block.semanticKind === "heading" && block.text === target.section
  )).map(templateBlockId));
  const headingCleared = Boolean(target.section && allSectionTargetsOmitted && !hasKeptBodyContent && headingIds.size);
  const updated = {
    ...content,
    confirmedOmissionTargetIds: [...confirmed],
    sections: headingCleared ? content.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) => block.templateBlockId && headingIds.has(block.templateBlockId)
        ? { ...block, text: "", attorneyEdited: true }
        : block),
    })) : content.sections,
  };
  return { content: GeneratedDraftSchema.parse(updated), headingCleared };
}

export function supplyOmission(
  content: GeneratedDraft,
  targetId: string,
  values: string[],
  template: TemplateAnalysis,
): GeneratedDraft {
  const outcome = content.outcomes.find((candidate) => candidate.targetId === targetId);
  if (!outcome || outcome.status !== "omitted") throw new Error("Only an omitted target can be supplied.");
  if (outcome.targetKind === "figure") throw new Error("Image omissions require evidence and regeneration.");
  if (content.confirmedOmissionTargetIds.includes(targetId)) throw new Error("This omission was already left blank.");

  const target = deriveGenerationTargets(template).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("The omitted target is not present in the pinned template map.");
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (!normalized.length) throw new Error("Enter at least one reviewed value.");

  const templateBlocks = template.blocks?.length ? template.blocks : template.regions;
  const byId = new Map(templateBlocks.map((block) => [templateBlockId(block), block]));
  if (normalized.length < target.minItems || normalized.length > target.maxItems) {
    throw new Error(`Enter between ${target.minItems} and ${target.maxItems} reviewed values for this target.`);
  }
  const suppliedBlocks: GeneratedDraft["sections"][number]["blocks"] = normalized.map((text, sequence) => {
    const blockId = target.blockIds[Math.min(sequence, target.blockIds.length - 1)]!;
    const region = byId.get(blockId);
    if (target.kind === "structured") {
      const expectedColumns = region?.structuredGroup?.columnCount ?? 1;
      const cells = text.split("|").map((cell) => cell.trim());
      if (cells.length !== expectedColumns || cells.some((cell) => !cell)) {
        throw new Error(`Each reviewed row must contain ${expectedColumns} non-empty ${expectedColumns === 1 ? "value" : "values separated by |"}.`);
      }
      return {
        id: `attorney-${outcome.id}-${sequence}`,
        kind: "table-row" as const,
        text: cells.join(" · "),
        templateParagraphIndex: region?.paragraphIndex ?? null,
        templateBlockId: blockId,
        citations: [],
        attorneyEdited: true,
        targetId,
        outcomeId: outcome.id,
        sequence,
        structuredCells: cells,
        structuredRowRole: region?.structuredGroup?.rowRole === "total" ? "total" as const : "body" as const,
      };
    }
    return {
      id: `attorney-${outcome.id}-${sequence}`,
      kind: "paragraph" as const,
      text,
      templateParagraphIndex: region?.paragraphIndex ?? null,
      templateBlockId: blockId,
      citations: [],
      attorneyEdited: true,
      targetId,
      outcomeId: outcome.id,
      sequence,
    };
  });

  return GeneratedDraftSchema.parse({
    ...content,
    outcomes: content.outcomes.map((candidate) => candidate.targetId === targetId ? {
      ...candidate,
      status: "attorney-supplied" as const,
      citations: [],
      note: null,
      generatedCount: suppliedBlocks.length,
    } : candidate),
    sections: content.sections.map((section, index) => index === 0 ? {
      ...section,
      blocks: [...section.blocks.filter((block) => block.targetId !== targetId), ...suppliedBlocks],
    } : section),
  });
}
