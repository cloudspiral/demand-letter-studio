import type { GeneratedDraft } from "@steno/contracts";

const isExportableField = (field: GeneratedDraft["fields"][string]): boolean => (
  field.userConfirmed || (field.verified && (field.confidence ?? 1) >= 0.8)
) && field.value !== "[ATTORNEY REVIEW REQUIRED]";

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
    .filter(([, field]) => isExportableField(field))
    .map(([key, field]) => [field.templateValue ?? key, field.value]));
}

export function exportableFieldKeys(fields: GeneratedDraft["fields"]): string[] {
  return Object.entries(fields)
    .filter(([, field]) => isExportableField(field))
    .map(([key]) => key);
}
