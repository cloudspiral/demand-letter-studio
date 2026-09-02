import type { ExportReadiness, GeneratedDraft } from "@steno/contracts";
import { exportableFieldKeys } from "./draft-fields";

const reviewPlaceholder = /\[ATTORNEY REVIEW REQUIRED(?:\s|—|-|\])?/i;

export interface DraftReadinessContext {
  draftSourceFingerprint?: string | null;
  currentSourceFingerprint?: string | null;
  staleResolutionTargetIds?: string[];
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

  const safeFieldKeys = new Set(exportableFieldKeys(content.fields));
  const blockIds = allBlocks
      .filter((block) => (
        block.kind === "warning"
        || reviewPlaceholder.test(block.text)
        || (!block.verified && !block.userConfirmed)
      ))
      .map((block) => block.id);
  const fieldKeys = Object.keys(content.fields).filter((key) => !safeFieldKeys.has(key));
  const outcomeIds = content.outcomes
    .filter((outcome) => outcome.status === "omitted_no_evidence" && outcome.resolution === "unresolved")
    .map((outcome) => outcome.id);
  const unresolvedTargetIds = new Set(content.outcomes
    .filter((outcome) => outcome.status === "omitted_no_evidence" && outcome.resolution === "unresolved")
    .map((outcome) => outcome.targetId));
  const duplicateParagraphIndexes = [...new Set([...mappingOwners.values()]
      .filter(({ owners }) => owners.size > 1)
      .map(({ paragraphIndex }) => paragraphIndex))];
  const blockedParagraphIndexes = new Set(allBlocks
    .filter((block) => blockIds.includes(block.id) && block.templateParagraphIndex !== null)
    .map((block) => block.templateParagraphIndex as number));
  const imageIssue = null;
  const staleEvidence = context.currentSourceFingerprint !== undefined
    && context.currentSourceFingerprint !== null
    && context.draftSourceFingerprint !== context.currentSourceFingerprint;
  const blockingReviewFlagIds = content.reviewFlags
    .filter((flag) => (
      flag.severity === "blocking" && (
      flag.affectedTargetIds.some((targetId) => unresolvedTargetIds.has(targetId))
      || flag.affectedTemplateParagraphIndexes.some((index) => blockedParagraphIndexes.has(index))
      || flag.affectedFieldKeys.some((key) => fieldKeys.includes(key))
      )
    ))
    .map((flag) => flag.id);
  const staleResolutionTargetIds = context.staleResolutionTargetIds ?? [];
  return {
    ready: !blockIds.length && !fieldKeys.length && !outcomeIds.length && !duplicateParagraphIndexes.length && !staleEvidence && !staleResolutionTargetIds.length,
    blockIds,
    fieldKeys,
    outcomeIds,
    duplicateParagraphIndexes,
    imageIssue,
    staleEvidence,
    staleResolutionTargetIds,
    blockingReviewFlagIds,
  };
}

export function isDraftExportReady(issues: ExportReadiness): boolean {
  return issues.ready;
}
