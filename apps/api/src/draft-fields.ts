import type { GeneratedDraft } from "@steno/contracts";

const isExportableField = (field: GeneratedDraft["fields"][string]): boolean => field.value !== null;

export function confirmDraftField(content: GeneratedDraft, key: string, value: string) {
  const field = content.fields[key];
  if (!field) throw new Error("Draft field not found.");
  const normalized = value.trim();
  if (!normalized) throw new Error("Draft field value cannot be blank.");
  return {
    corrected: field.value !== normalized,
    content: {
      ...content,
      fields: {
        ...content.fields,
        [key]: { ...field, value: normalized, note: null, attorneyEdited: true },
      },
    },
  } satisfies { corrected: boolean; content: GeneratedDraft };
}

export function exportableFieldReplacements(fields: GeneratedDraft["fields"]): Record<string, string> {
  return Object.fromEntries(Object.entries(fields)
    .filter(([, field]) => isExportableField(field))
    .map(([, field]) => [field.oldValue, field.value as string]));
}

export function exportableFieldKeys(fields: GeneratedDraft["fields"]): string[] {
  return Object.entries(fields)
    .filter(([, field]) => isExportableField(field))
    .map(([key]) => key);
}
