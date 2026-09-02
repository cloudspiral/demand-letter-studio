import type { ExportReadiness, GeneratedDraft } from "@steno/contracts";
import { exportableFieldReplacements } from "./draft-fields";

const reviewPlaceholder = /\[ATTORNEY REVIEW REQUIRED(?:\s|—|-|\])?/i;

export interface DraftReadinessContext {
  draftSourceFingerprint?: string | null;
  currentSourceFingerprint?: string | null;
  imageCandidates?: number;
  imageSources?: number;
}

export function draftExportIssues(
  content: GeneratedDraft,
  context: DraftReadinessContext = {},
): ExportReadiness {
  const allBlocks = content.sections.flatMap((section) => section.blocks);
  const templateBlocks = allBlocks.filter((block) => block.templateParagraphIndex !== null);
  const paragraphCounts = new Map<number, number>();
  for (const block of templateBlocks) {
    const index = block.templateParagraphIndex as number;
    paragraphCounts.set(index, (paragraphCounts.get(index) ?? 0) + 1);
  }

  const safeFieldKeys = new Set(Object.keys(exportableFieldReplacements(content.fields)));
  const blockIds = allBlocks
      .filter((block) => (
        block.kind === "warning"
        || reviewPlaceholder.test(block.text)
        || (!block.verified && !block.userConfirmed)
      ))
      .map((block) => block.id);
  const fieldKeys = Object.keys(content.fields).filter((key) => !safeFieldKeys.has(key));
  const duplicateParagraphIndexes = [...paragraphCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([index]) => index);
  const blockedParagraphIndexes = new Set(allBlocks
    .filter((block) => blockIds.includes(block.id) && block.templateParagraphIndex !== null)
    .map((block) => block.templateParagraphIndex as number));
  const imageCandidates = context.imageCandidates ?? 0;
  const imageSources = context.imageSources ?? 0;
  const imageIssue = imageCandidates > 0 && (imageCandidates !== 1 || imageSources !== 1)
    ? { templateCandidates: imageCandidates, sourceImages: imageSources }
    : null;
  const staleEvidence = context.currentSourceFingerprint !== undefined
    && context.currentSourceFingerprint !== null
    && context.draftSourceFingerprint !== context.currentSourceFingerprint;
  const blockingReviewFlagIds = content.reviewFlags
    .filter((flag) => (
      flag.affectedTemplateParagraphIndexes.some((index) => blockedParagraphIndexes.has(index))
      || flag.affectedFieldKeys.some((key) => fieldKeys.includes(key))
    ))
    .map((flag) => flag.id);
  return {
    ready: !blockIds.length && !fieldKeys.length && !duplicateParagraphIndexes.length && !imageIssue && !staleEvidence,
    blockIds,
    fieldKeys,
    duplicateParagraphIndexes,
    imageIssue,
    staleEvidence,
    blockingReviewFlagIds,
  };
}

export function isDraftExportReady(issues: ExportReadiness): boolean {
  return issues.ready;
}
