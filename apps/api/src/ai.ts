import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  GeneratedDraftSchema,
  RefinementProposalSchema,
  type GeneratedDraft,
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
  selectedText: string;
  evidence: EvidencePage[];
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  generate(input: GenerateInput): Promise<GeneratedDraft>;
  refine(input: RefineInput): Promise<RefinementProposal>;
}

const generatedDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "matterName", "fields", "sections", "warnings"],
  properties: {
    title: { type: "string" },
    matterName: { type: "string" },
    fields: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        required: ["value", "verified", "sourceLabel"],
        properties: { value: { type: "string" }, verified: { type: "boolean" }, sourceLabel: { type: ["string", "null"] } },
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
  },
} as const;

const refinementJsonSchema = {
  type: "object", additionalProperties: false,
  required: ["targetText", "replacementText", "summary", "citedSourceIds"],
  properties: {
    targetText: { type: "string" }, replacementText: { type: "string" }, summary: { type: "string" },
    citedSourceIds: { type: "array", items: { type: "string" } },
  },
} as const;

function promptForGeneration(input: GenerateInput): string {
  const editable = input.template.regions.filter((region) => region.role === "editable").map((region) => ({
    paragraphIndex: region.paragraphIndex,
    text: region.text.slice(0, 800),
  }));
  return `Create an attorney-review draft demand letter for ${input.matterName}.
Accuracy rules:
- Use only facts explicitly present in EVIDENCE.
- Every factual paragraph must cite at least one evidence page and set verified=true.
- If a template section cannot be supported, create a warning block stating what source is missing; never copy case facts from TEMPLATE REGIONS.
- Preserve the template's section order and legal boilerplate. Return concise text, not HTML or OOXML.
- templateParagraphIndex must refer to the editable template paragraph being replaced, or null for a warning.

TEMPLATE REGIONS:
${JSON.stringify(editable)}

EVIDENCE:
${JSON.stringify(input.evidence)}`;
}

function promptForRefinement(input: RefineInput): string {
  return `Propose a bounded revision to the selected demand-letter text.
Instruction: ${input.instruction}
Selected text: ${input.selectedText}
Evidence: ${JSON.stringify(input.evidence)}
Return targetText exactly as supplied. Do not introduce facts unsupported by the evidence. If the instruction requires unsupported facts, keep the text unchanged and explain why in summary.`;
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  readonly model = config.openaiModel;
  private readonly client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    const response = await this.client.responses.create({
      model: this.model,
      input: promptForGeneration(input),
      reasoning: { effort: (process.env.OPENAI_REASONING_EFFORT as "low" | "medium" | "high") ?? "high" },
      store: false,
      text: { format: { type: "json_schema", name: "generated_draft", strict: true, schema: generatedDraftJsonSchema } },
    });
    return GeneratedDraftSchema.parse(JSON.parse(response.output_text));
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
  private readonly client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    return GeneratedDraftSchema.parse(await this.json(promptForGeneration(input), generatedDraftJsonSchema));
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    return RefinementProposalSchema.parse(await this.json(promptForRefinement(input), refinementJsonSchema));
  }
}

class MockProvider implements AiProvider {
  readonly name = "mock";
  readonly model = "deterministic-fixture";

  async generate(input: GenerateInput): Promise<GeneratedDraft> {
    const evidence = input.evidence.filter((page) => page.text.trim());
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
    });
  }

  async refine(input: RefineInput): Promise<RefinementProposal> {
    return RefinementProposalSchema.parse({
      targetText: input.selectedText,
      replacementText: input.selectedText.replace(/\bvery\b/gi, "").replace(/\s{2,}/g, " ").trim(),
      summary: "Tightened the selected text without adding facts.",
      citedSourceIds: [],
    });
  }
}

export function createAiProvider(name = config.aiProvider): AiProvider {
  if (name === "openai") return new OpenAiProvider();
  if (name === "anthropic") return new AnthropicProvider();
  if (name === "mock") return new MockProvider();
  throw new Error(`Unsupported AI provider: ${name}`);
}
