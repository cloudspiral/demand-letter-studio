import type { ExportReadiness, GeneratedDraft } from "@steno/contracts";
export interface DraftReadinessContext {
  draftSourceFingerprint?: string | null;
  currentSourceFingerprint?: string | null;
}

export function draftExportIssues(
  content: GeneratedDraft,
  context: DraftReadinessContext = {},
): ExportReadiness {
  const allBlocks = content.sections.flatMap((section) => section.blocks);
  const templateBlocks = allBlocks.filter((block) => block.templateBlockId || block.templateParagraphIndex !== null);
  const mappingOwners = new Map<string, { owners: Set<string>; paragraphIndex: number }>();
  for (const block of templateBlocks) {
    const index = block.templateParagraphIndex ?? 0;
    const key = block.templateBlockId ?? `legacy-body:${index}`;
    const owner = block.targetId ?? block.id;
    const current = mappingOwners.get(key) ?? { owners: new Set<string>(), paragraphIndex: index };
    current.owners.add(owner);
    mappingOwners.set(key, current);
  }

  const fieldKeys = Object.entries(content.fields).filter(([, field]) => field.value === null).map(([key]) => key);
  const confirmed = new Set(content.confirmedOmissionTargetIds);
  const omittedTargetIds = content.outcomes
    .filter((outcome) => outcome.status === "omitted" && !confirmed.has(outcome.targetId))
    .map((outcome) => outcome.targetId);
  const duplicateParagraphIndexes = [...new Set([...mappingOwners.values()]
      .filter(({ owners }) => owners.size > 1)
      .map(({ paragraphIndex }) => paragraphIndex))];
  const imageIssue = null;
  const staleEvidence = context.currentSourceFingerprint !== undefined
    && context.currentSourceFingerprint !== null
    && context.draftSourceFingerprint !== context.currentSourceFingerprint;
  return {
    ready: !fieldKeys.length && !omittedTargetIds.length && !duplicateParagraphIndexes.length && !staleEvidence,
    fieldKeys,
    omittedTargetIds,
    duplicateParagraphIndexes,
    imageIssue,
    staleEvidence,
  };
}

export function isDraftExportReady(issues: ExportReadiness): boolean {
  return issues.ready;
}
