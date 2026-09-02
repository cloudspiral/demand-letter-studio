import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";
import { z } from "zod";
import {
  GeneratedDraftSchema,
  ReviewFlagSchema,
  RefinementProposalSchema,
  type GeneratedDraft,
  type ReviewFlag,
  type RefinementAnnotation,
  type RefinementProposal,
  type TemplateAnalysis,
} from "@steno/contracts";
import { config } from "./config";

export interface EvidencePage {
  sourceId: string;
  sourceName: string;
  page: number;
  text: string;
}

export interface GenerateInput {
  matterName: string;
  template: TemplateAnalysis;
  evidence: EvidencePage[];
}

export interface RefineInput {
  instruction: string;
  annotations: RefinementAnnotation[];
  evidence: EvidencePage[];
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  review(input: GenerateInput): Promise<ReviewFlag[]>;
  generate(input: GenerateInput): Promise<GeneratedDraft>;
  refine(input: RefineInput): Promise<RefinementProposal>;
}

function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _metaSchema, ...jsonSchema } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return jsonSchema;
}

const reviewFlagJsonSchema = strictJsonSchema(ReviewFlagSchema);

const generatedDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "matterName", "sections", "warnings", "reviewFlags", "replacements"],
  properties: {
    title: { type: "string" },
    matterName: { type: "string" },
    replacements: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["oldValue", "newValue", "sourceId", "page"],
        properties: {
          oldValue: { type: "string", minLength: 1 }, newValue: { type: "string", minLength: 1 },
          sourceId: { type: "string" }, page: { type: "integer" },
        },
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "heading", "blocks"],
        properties: {
          id: { type: "string" }, heading: { type: ["string", "null"] },
          blocks: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "kind", "text", "templateParagraphIndex", "citations", "verified"],
              properties: {
                id: { type: "string" },
                kind: { enum: ["heading", "paragraph", "list-item", "table-row", "warning"] },
                text: { type: "string" },
                templateParagraphIndex: { type: ["integer", "null"] },
                verified: { type: "boolean" },
                citations: {
                  type: "array",
                  items: {
                    type: "object", additionalProperties: false,
                    required: ["sourceId", "sourceName", "page", "quote"],
                    properties: { sourceId: { type: "string" }, sourceName: { type: "string" }, page: { type: ["integer", "null"] }, quote: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    reviewFlags: {
      type: "array",
      maxItems: 100,
      items: reviewFlagJsonSchema,
    },
  },
} as const;

export const evidenceReviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviewFlags"],
  properties: {
    reviewFlags: {
      type: "array",
      maxItems: 100,
      items: reviewFlagJsonSchema,
    },
  },
} as const;

const refinementJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["edits", "summary", "citedSourceIds"],
  properties: {
    edits: {
      type: "array", minItems: 1, maxItems: 5,
      items: {
        type: "object", additionalProperties: false,
        required: ["blockId", "targetText", "replacementText", "start", "end"],
        properties: {
          blockId: { type: "string" }, targetText: { type: "string" }, replacementText: { type: "string" },
          start: { type: "integer", minimum: 0 }, end: { type: "integer", minimum: 1 },
        },
      },
    },
    summary: { type: "string" },
    citedSourceIds: { type: "array", items: { type: "string" } },
  },
} as const;

function promptForGeneration(input: GenerateInput): string {
  const editable = input.template.regions.filter((region) => region.role === "editable").map((region) => ({
    paragraphIndex: region.paragraphIndex,
    text: region.text.slice(0, 800),
    targetCharacters: region.text.length,
  }));
  return `Create an attorney-review draft demand letter for ${input.matterName}.
Accuracy rules:
- Use only facts explicitly present in EVIDENCE.
- Every factual paragraph must cite at least one evidence page and set verified=true.
- Citation quotes must be short, exact, contiguous excerpts copied verbatim from the cited page.
- If a template section cannot be supported, create a warning block stating what source is missing; never copy case facts from TEMPLATE REGIONS.
- If sources conflict about a name, claim number, date, amount, coverage, liability, treatment, or deadline, create a warning block describing the conflict, do not choose a value, and do not replace affected fields or regions.
- Return generic reviewFlags for potential missing or conflicting support. Each flag must briefly explain the concern, cite exact source text when describing a source conflict, and point to affected template paragraph indexes or replacement-candidate field keys when possible. Do not classify documents, assign severity, assess authenticity, or decide legal validity.
- Evidence pages beginning with "[Image evidence:" are visual-review markers, not factual text; never cite those markers. When textual evidence describes the depicted damage, ground the photograph caption in that textual source. The system replaces the uploaded template image deterministically.
- The presence of an uploaded image is not by itself a missing fact or conflict. Put any reminder to visually review the image in top-level warnings only; do not create a warning block when the caption is grounded in textual evidence and the image slot has an uploaded replacement.
- Preserve the template's section order and legal boilerplate. Return concise text, not HTML or OOXML.
- Return exactly one template-backed block for every TEMPLATE REGION paragraphIndex. Never merge multiple template regions into one block and never use the same paragraphIndex twice.
- templateParagraphIndex must refer to the editable template paragraph being replaced. A general conflict warning may use null.
- Match the purpose and approximate length of each original template region so the reviewed Word layout remains stable.
- For regions whose targetCharacters is at least 200, write grounded text between 70 and 105 percent of targetCharacters. Use distinct supported details, not repetition or invented filler. For shorter regions, stay concise and never exceed 150 percent of targetCharacters.
- For each TEMPLATE REPLACEMENT CANDIDATE supported by evidence, return its exact oldValue and grounded newValue with sourceId/page. Omit unsupported candidates.
- A replacement candidate is patched independently from editable paragraph text. If a deadline is split across consecutive template paragraphs, keep the editable region ending at its original date/comma boundary and put the grounded time only in the replacement candidate; never duplicate that time in the editable block.

TEMPLATE REGIONS:
${JSON.stringify(editable)}

TEMPLATE REPLACEMENT CANDIDATES:
${JSON.stringify(input.template.replacementCandidates)}

TEMPLATE IMAGE CANDIDATES:
${JSON.stringify(input.template.imageCandidates)}

EVIDENCE:
${JSON.stringify(input.evidence)}`;
}

function promptForEvidenceReview(input: GenerateInput): string {
  const editable = input.template.regions.filter((region) => region.role === "editable").map((region) => ({
    paragraphIndex: region.paragraphIndex,
    text: region.text.slice(0, 800),
  }));
  return `Review the uploaded evidence before drafting an attorney-review demand letter for ${input.matterName}.
Return only high-signal, generic review flags that could materially affect the case-specific template content.
- Do not classify documents or assign types, severities, or validity labels.
- Do not decide authenticity, evidentiary admissibility, legal sufficiency, or legal validity.
- When sources appear inconsistent, cite short exact contiguous quotes from every relevant source page.
- When supporting evidence cannot be located, use no citations and identify only the affected template paragraph indexes or field keys.
- A review flag is advisory and non-exhaustive. Do not claim the packet is complete.
- Use only paragraph indexes and field keys supplied below. Use empty target arrays only for a genuinely packet-wide advisory concern.

TEMPLATE REGIONS:
${JSON.stringify(editable)}

TEMPLATE REPLACEMENT CANDIDATES:
${JSON.stringify(input.template.replacementCandidates)}

EVIDENCE:
${JSON.stringify(input.evidence)}`;
}

const ReviewFlagsOutputSchema = z.object({
  reviewFlags: z.array(ReviewFlagSchema).max(100),
});

const normalizeEvidenceText = (value: string): string => value
  .normalize("NFKC")
  .replace(/\s+/g, " ")
  .trim()
  .toLocaleLowerCase();

function stableFlagId(flag: Omit<ReviewFlag, "id">): string {
  return `source-review-${createHash("sha256").update(JSON.stringify({
    summary: normalizeEvidenceText(flag.summary),
    paragraphs: flag.affectedTemplateParagraphIndexes,
    fields: flag.affectedFieldKeys,
    citations: flag.citations.map((citation) => [citation.sourceId, citation.page, normalizeEvidenceText(citation.quote)]),
  })).digest("hex").slice(0, 16)}`;
}

export function validateReviewFlags(
  rawFlags: unknown,
  evidence: EvidencePage[],
  template: TemplateAnalysis,
): ReviewFlag[] {
  const parsed = z.array(ReviewFlagSchema).max(100).parse(rawFlags);
  const pages = new Map(evidence.map((page) => [`${page.sourceId}:${page.page}`, page]));
  const paragraphIndexes = new Set(template.regions.filter((region) => region.role === "editable").map((region) => region.paragraphIndex));
  const fieldKeys = new Set(template.replacementCandidates.map((candidate) => candidate.value));
  const flags: ReviewFlag[] = [];
  const seen = new Set<string>();

  for (const flag of parsed) {
    const citations = flag.citations.flatMap((citation) => {
      if (citation.page === null || !citation.quote.trim()) return [];
      const page = pages.get(`${citation.sourceId}:${citation.page}`);
      if (!page || !normalizeEvidenceText(page.text).includes(normalizeEvidenceText(citation.quote))) return [];
      return [{ ...citation, sourceName: page.sourceName }];
    });
    if (flag.citations.length > 0 && citations.length === 0) continue;

    const affectedTemplateParagraphIndexes = [...new Set(flag.affectedTemplateParagraphIndexes.filter((index) => paragraphIndexes.has(index)))];
    const affectedFieldKeys = [...new Set(flag.affectedFieldKeys.filter((key) => fieldKeys.has(key)))];
    const uncitedTarget = affectedFieldKeys.length
      ? `the affected template ${affectedFieldKeys.length === 1 ? "field" : "fields"}`
      : affectedTemplateParagraphIndexes.length
        ? `the affected template ${affectedTemplateParagraphIndexes.length === 1 ? "region" : "regions"}`
        : "the case-specific draft";
    const normalized: Omit<ReviewFlag, "id"> = citations.length
      ? {
          summary: flag.summary,
          explanation: flag.explanation,
          citations,
          affectedTemplateParagraphIndexes,
          affectedFieldKeys,
        }
      : {
          summary: "Supporting evidence not located",
          explanation: `The uploaded sources did not provide support for ${uncitedTarget}. Review the source materials before relying on this point.`,
          citations: [],
          affectedTemplateParagraphIndexes,
          affectedFieldKeys,
        };
    const id = stableFlagId(normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    flags.push({ id, ...normalized });
  }
  return flags;
}

export function parseEvidenceReview(raw: unknown, evidence: EvidencePage[], template: TemplateAnalysis): ReviewFlag[] {
  const parsed = ReviewFlagsOutputSchema.parse(raw);
  return validateReviewFlags(parsed.reviewFlags, evidence, template);
}

const ModelOutputSchema = GeneratedDraftSchema.omit({ fields: true }).extend({
  replacements: z.array(z.object({
    oldValue: z.string().min(1), newValue: z.string().min(1), sourceId: z.string().uuid(), page: z.number().int().positive(),
  })),
});

export function parseModelDraft(raw: unknown, evidence: EvidencePage[], template: TemplateAnalysis): GeneratedDraft {
  const parsed = ModelOutputSchema.parse(raw);
  const pages = new Map(evidence.map((page) => [`${page.sourceId}:${page.page}`, page]));
  const allowedOldValues = new Set(template.replacementCandidates.map((candidate) => candidate.value));
  const fields: GeneratedDraft["fields"] = {};
  const groundedReplacements: Array<{ oldValue: string; newValue: string }> = [];
  for (const replacement of parsed.replacements) {
    const source = pages.get(`${replacement.sourceId}:${replacement.page}`);
    const normalizedEvidence = source?.text.toLocaleLowerCase().replace(/\s+/g, " ") ?? "";
    const normalizedReplacement = replacement.newValue.toLocaleLowerCase().replace(/\s+/g, " ");
    if (source && allowedOldValues.has(replacement.oldValue) && normalizedEvidence.includes(normalizedReplacement)) {
      fields[replacement.oldValue] = {
        value: replacement.newValue,
        verified: true,
        confidence: 1,
        userConfirmed: false,
        sourceId: source.sourceId,
        page: source.page,
        sourceLabel: `${source.sourceName} p. ${source.page}`,
      };
      groundedReplacements.push({ oldValue: replacement.oldValue, newValue: replacement.newValue });
    }
  }
  const { replacements: _replacements, ...draft } = parsed;
  for (const replacement of groundedReplacements) {
    const candidate = template.replacementCandidates.find((item) => (
      item.value === replacement.oldValue && item.location === "word/document.xml"
    ));
    const continuation = candidate && template.regions.find((region) => (
      region.text.includes(candidate.value)
    ));
    const preceding = continuation && template.regions.find((region) => (
      region.paragraphIndex === continuation.paragraphIndex - 1 && region.role === "editable"
    ));
    if (!preceding) continue;
    const escapedValue = replacement.newValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const duplicatedSuffix = new RegExp(`\\s+at\\s+${escapedValue}\\.?\\s*$`, "iu");
    const originalBoundary = preceding.text.match(/[,;:]\s*$/u)?.[0] ?? ", ";
    for (const section of draft.sections) {
      for (const block of section.blocks) {
        if (block.templateParagraphIndex === preceding.paragraphIndex && duplicatedSuffix.test(block.text)) {
          block.text = block.text.replace(duplicatedSuffix, originalBoundary).trimEnd();
        }
      }
    }
  }
  return GeneratedDraftSchema.parse({
    ...draft,
    fields,
    reviewFlags: validateReviewFlags(draft.reviewFlags, evidence, template),
  });
}

function promptForRefinement(input: RefineInput): string {
  return `Propose bounded revisions to one or more selected passages in a demand letter.
Instruction: ${input.instruction}
Selections: ${JSON.stringify(input.annotations)}
Evidence: ${JSON.stringify(input.evidence)}
Return one edit per changed selection. Copy blockId, targetText, start, and end exactly from each supplied selection. Do not introduce facts unsupported by the evidence. If the instruction requires unsupported facts, keep the relevant text unchanged and explain why in summary.`;
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model = config.openaiModel;
  private readonly client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  async review(input: GenerateInput): Promise<ReviewFlag[]> {
    const response = await this.client.responses.create({
      model: this.model,
      input: promptForEvidenceReview(input),
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "high" },
      store: false,
      text: { format: { type: "json_schema", name: "evidence_review", strict: true, schema: evidenceReviewJsonSchema } },
    });
    return parseEvidenceReview(JSON.parse(response.output_text), input.evidence, input.template);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    const response = await this.client.responses.create({
      model: this.model,
      input: promptForGeneration(input),
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "high" },
      store: false,
      text: { format: { type: "json_schema", name: "generated_draft", strict: true, schema: generatedDraftJsonSchema } },
    });
    return parseModelDraft(JSON.parse(response.output_text), input.evidence, input.template);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    const response = await this.client.responses.create({
      model: this.model,
      input: promptForRefinement(input),
      reasoning: { effort: "high" },
      store: false,
      text: { format: { type: "json_schema", name: "refinement", strict: true, schema: refinementJsonSchema } },
    });
    return RefinementProposalSchema.parse(JSON.parse(response.output_text));
  }
}

class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly model = config.anthropicModel;
  private readonly client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    ...(process.env.ANTHROPIC_WORKSPACE_ID
      ? { defaultHeaders: { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } }
      : {}),
  });

  private async json(prompt: string, schema: unknown): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16_000,
      system: "You draft evidence-grounded legal documents. Never invent facts. Return only JSON matching the requested schema.",
      messages: [{ role: "user", content: `${prompt}\nJSON SCHEMA:\n${JSON.stringify(schema)}` }],
    });
    const block = response.content.find((item) => item.type === "text");
    if (!block || block.type !== "text") throw new Error("Anthropic returned no text output");
    const cleaned = block.text.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(cleaned);
  }

  async review(input: GenerateInput): Promise<ReviewFlag[]> {
    return parseEvidenceReview(await this.json(promptForEvidenceReview(input), evidenceReviewJsonSchema), input.evidence, input.template);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    return parseModelDraft(await this.json(promptForGeneration(input), generatedDraftJsonSchema), input.evidence, input.template);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    return RefinementProposalSchema.parse(await this.json(promptForRefinement(input), refinementJsonSchema));
  }
}

class BedrockProvider implements AiProvider {
  readonly name = "bedrock";
  readonly model = config.bedrockModel;
  private readonly client = new BedrockRuntimeClient({
    region: config.awsRegion,
    maxAttempts: 5,
    retryMode: "adaptive",
  });

  private async json(prompt: string, schema: unknown, maxTokens: number): Promise<unknown> {
    const response = await this.client.send(new ConverseCommand({
      modelId: this.model,
      system: [{ text: "You draft evidence-grounded legal documents. Never invent facts. Return only JSON matching the requested schema." }],
      messages: [{ role: "user", content: [{ text: `${prompt}\nJSON SCHEMA:\n${JSON.stringify(schema)}` }] }],
      inferenceConfig: { maxTokens, temperature: 0 },
      requestMetadata: { application: "steno-demand-letter-studio" },
    }));
    const text = response.output?.message?.content
      ?.map((block) => block.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("Bedrock returned no text output");
    const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(cleaned);
  }

  async review(input: GenerateInput): Promise<ReviewFlag[]> {
    return parseEvidenceReview(await this.json(promptForEvidenceReview(input), evidenceReviewJsonSchema, 8_000), input.evidence, input.template);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    return parseModelDraft(await this.json(promptForGeneration(input), generatedDraftJsonSchema, 16_000), input.evidence, input.template);
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    return RefinementProposalSchema.parse(await this.json(promptForRefinement(input), refinementJsonSchema, 4_000));
  }
}

class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "deterministic-fixture";

  private async modelDelay(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async review(input: GenerateInput): Promise<ReviewFlag[]> {
    await this.modelDelay();
    const textualEvidence = input.evidence.filter((page) => page.text.trim() && !page.text.startsWith("[Image evidence:"));
    const affectedTemplateParagraphIndexes = input.template.regions
      .filter((region) => region.role === "editable")
      .slice(textualEvidence.length ? 1 : 0, textualEvidence.length ? 3 : 2)
      .map((region) => region.paragraphIndex);
    const affectedFieldKeys = input.template.replacementCandidates
      .filter((candidate) => !textualEvidence.some((page) => page.text.includes(candidate.value)))
      .slice(0, 3)
      .map((candidate) => candidate.value);
    if (!affectedTemplateParagraphIndexes.length && !affectedFieldKeys.length) return [];
    return validateReviewFlags([{
      id: "mock-review",
      summary: "Supporting evidence not located",
      explanation: "The deterministic review did not locate support for every case-specific template target.",
      citations: [],
      affectedTemplateParagraphIndexes,
      affectedFieldKeys,
    }], input.evidence, input.template);
  }

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    await this.modelDelay();
    const evidence = input.evidence.filter((page) => page.text.trim() && !page.text.startsWith("[Image evidence:"));
    const citations = evidence.slice(0, 4).map((page) => ({
      sourceId: page.sourceId, sourceName: page.sourceName, page: page.page, quote: page.text.slice(0, 180),
    }));
    const editable = input.template.regions.filter((region) => region.role === "editable").slice(0, 6);
    return GeneratedDraftSchema.parse({
      title: "Time-Limited Policy Limits Demand",
      matterName: input.matterName,
      fields: {},
      sections: [{
        id: "supported-evidence", heading: "SUPPORTED CASE EVIDENCE",
        blocks: editable.map((region, index) => ({
          id: `block-${index + 1}`, kind: citations.length ? "paragraph" : "warning",
          text: citations.length ? `The enclosed records document the charges and services reflected in the source materials. Attorney review is required before adding any unsupported narrative from the prior completed letter.` : "Attorney review required: no extractable evidence was supplied.",
          templateParagraphIndex: region.paragraphIndex,
          citations: citations.slice(index % Math.max(1, citations.length), (index % Math.max(1, citations.length)) + 1),
          verified: citations.length > 0,
        })),
      }],
      warnings: ["The provided packet contains billing documents and an image, not the complete underlying case record."],
      reviewFlags: await this.review(input),
    });
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    await this.modelDelay();
    const edits = input.annotations.map((annotation) => ({
      blockId: annotation.blockId,
      targetText: annotation.quote,
      replacementText: annotation.quote.replace(/\bvery\b/gi, "").replace(/\s{2,}/g, " ").trim(),
      start: annotation.start,
      end: annotation.end,
    }));
    return RefinementProposalSchema.parse({
      edits,
      summary: `Tightened ${edits.length === 1 ? "the selected passage" : `${edits.length} selected passages`} without adding facts.`,
      citedSourceIds: [],
    });
  }
}

export function createAiProvider(name = config.aiProvider): AiProvider {
  if (name === "openai") return new OpenAiProvider();
  if (name === "anthropic") return new AnthropicProvider();
  if (name === "bedrock") return new BedrockProvider();
  if (name === "mock") return new MockProvider();
  throw new Error(`Unsupported AI provider: ${name}`);
}
