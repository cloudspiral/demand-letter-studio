const CONTENT_ADDRESS_PREFIX = /^(?:[0-9a-f]{64}-)+/i;

function baseName(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

export function templateDisplayName(filename: string): string {
  const withoutPath = baseName(filename).trim();
  const withoutAddress = withoutPath.replace(CONTENT_ADDRESS_PREFIX, "");
  const withoutExtension = withoutAddress.replace(/\.docx$/i, "");
  const punctuationToken = "\u0000";
  const humanized = (/\s/.test(withoutExtension)
    ? withoutExtension.replace(/_+/g, " ")
    : withoutExtension
      .replace(/-{3,}/g, punctuationToken)
      .replace(/[-_]+/g, " ")
      .replaceAll(punctuationToken, " - "))
    .replace(/\s+/g, " ")
    .trim();
  return humanized || "Untitled template";
}

export function templateAnalysisFilename(displayName: string): string {
  return `${displayName}.docx`;
}

export function isLegacySyntheticTemplate(filename: string): boolean {
  return baseName(filename).toLowerCase() === "synthetic-demand-template.docx";
}

export function testTemplateFromHeader(value: string | string[] | undefined): boolean {
  return typeof value === "string" && value.toLowerCase() === "true";
}

export function mergedTemplateProvenance(
  current: { name: string; displayName: string; isTest: boolean },
  upload: { name: string; displayName: string; isTest: boolean },
): { name: string; displayName: string; isTest: boolean } {
  if (!current.isTest || upload.isTest) return current;
  return { ...upload, isTest: false };
}
