import type { GeneratedDraft } from "@steno/contracts";

export function confirmDraftField(content: GeneratedDraft, key: string, value: string) {
  const field = content.fields[key];
  if (!field) throw new Error("Draft field not found.");
  return {
    corrected: field.value !== value,
    content: {
      ...content,
      fields: {
        ...content.fields,
        [key]: { ...field, value, userConfirmed: true },
      },
    },
  } satisfies { corrected: boolean; content: GeneratedDraft };
}

export function exportableFieldReplacements(fields: GeneratedDraft["fields"]): Record<string, string> {
  return Object.fromEntries(Object.entries(fields)
    .filter(([, field]) => (
      field.userConfirmed || (field.verified && (field.confidence ?? 1) >= 0.8)
    ) && field.value !== "[ATTORNEY REVIEW REQUIRED]")
    .map(([key, field]) => [key, field.value]));
}
