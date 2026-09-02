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
