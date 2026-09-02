import type { GeneratedDraft, RefinementAnnotation, RefinementProposal } from "@steno/contracts";

export function applyDirectDraftEdits(current: GeneratedDraft, candidate: GeneratedDraft): GeneratedDraft {
  const candidateBlocks = new Map(candidate.sections.flatMap((section) => section.blocks).map((block) => [block.id, block]));
  const currentBlocks = current.sections.flatMap((section) => section.blocks);
  if (candidateBlocks.size !== currentBlocks.length || currentBlocks.some((block) => !candidateBlocks.has(block.id))) {
    throw new Error("Direct edits may change paragraph text but not the reviewed template structure.");
  }

  return {
    ...current,
    sections: current.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) => {
        const nextText = candidateBlocks.get(block.id)?.text ?? block.text;
        if (nextText === block.text) return block;
        return {
          ...block,
          text: nextText,
          verified: false,
          userConfirmed: false,
        };
      }),
    })),
  };
}

export function validateProposalTargets(proposal: RefinementProposal, annotations: RefinementAnnotation[]): void {
  const expected = new Map(annotations.map((annotation) => [
    `${annotation.blockId}:${annotation.start}:${annotation.end}`,
    annotation.quote,
  ]));
  const seen = new Set<string>();
  for (const edit of proposal.edits) {
    const key = `${edit.blockId}:${edit.start}:${edit.end}`;
    if (seen.has(key) || expected.get(key) !== edit.targetText) {
      throw new Error("The AI proposal did not preserve the selected draft ranges.");
    }
    seen.add(key);
  }
}

export function applyRefinementProposal(content: GeneratedDraft, proposal: RefinementProposal): GeneratedDraft {
  const blocks = content.sections.flatMap((section) => section.blocks);
  const normalized = proposal.edits.map((edit) => {
    if (edit.blockId !== "legacy") return edit;
    const block = blocks.find((candidate) => candidate.text === edit.targetText);
    if (!block) throw new Error("Legacy proposal target no longer exists in this draft.");
    return { ...edit, blockId: block.id, start: 0, end: block.text.length };
  });
  const grouped = new Map<string, typeof normalized>();
  for (const edit of normalized) grouped.set(edit.blockId, [...(grouped.get(edit.blockId) ?? []), edit]);

  let applied = 0;
  const updated: GeneratedDraft = {
    ...content,
    sections: content.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) => {
        const edits = grouped.get(block.id);
        if (!edits?.length) return block;
        const ordered = [...edits].sort((a, b) => a.start - b.start);
        for (let index = 0; index < ordered.length; index += 1) {
          const edit = ordered[index];
          const previous = ordered[index - 1];
          if (!edit || (previous && edit.start < previous.end) || block.text.slice(edit.start, edit.end) !== edit.targetText) {
            throw new Error("Proposal target no longer matches the current draft text.");
          }
        }
        let text = block.text;
        for (const edit of [...ordered].reverse()) {
          text = `${text.slice(0, edit.start)}${edit.replacementText}${text.slice(edit.end)}`;
          applied += 1;
        }
        return {
          ...block,
          text,
          verified: false,
          userConfirmed: false,
        };
      }),
    })),
  };
  if (applied !== normalized.length) throw new Error("One or more proposal targets no longer exist in this draft.");
  return updated;
}

export function confirmDraftBlock(
  content: GeneratedDraft,
  blockId: string,
  reviewedText: string,
): GeneratedDraft {
  let found = false;
  const updated = {
    ...content,
    sections: content.sections.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) => {
        if (block.id !== blockId) return block;
        found = true;
        return {
          ...block,
          kind: block.kind === "warning" ? "paragraph" as const : block.kind,
          text: reviewedText,
          verified: false,
          userConfirmed: true,
        };
      }),
    })),
  };
  if (!found) throw new Error("Draft block not found.");
  return updated;
}
