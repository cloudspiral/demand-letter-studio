import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";

async function expectTitleContained(card: Locator) {
  const title = card.locator(":scope > strong");
  const [cardBox, titleBox] = await Promise.all([card.boundingBox(), title.boundingBox()]);
  expect(cardBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect((titleBox?.x ?? 0) + (titleBox?.width ?? 0)).toBeLessThanOrEqual((cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 1);
  const metrics = await card.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  const lineMetrics = await title.evaluate((element) => {
    const style = getComputedStyle(element);
    return { height: element.getBoundingClientRect().height, lineHeight: Number.parseFloat(style.lineHeight) };
  });
  expect(lineMetrics.height).toBeLessThanOrEqual(lineMetrics.lineHeight * 3 + 1);
}

test("template picker presents clean provenance and contains long names", async ({ page }) => {
  const longName = "x".repeat(180);
  await page.route("**/api/templates", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([{
        id: "10000000-0000-4000-8000-000000000001",
        name: `${"a".repeat(64)}-${longName}.docx`,
        displayName: longName,
        isTest: true,
        status: "confirmed",
        analysis: { paragraphCount: 13, regions: [] },
        createdAt: "2026-09-01T07:43:03.519Z",
      }, {
        id: "10000000-0000-4000-8000-000000000002",
        name: `${"b".repeat(64)}-AAA-Insurance---Time-Limited-Policy-Limits-Demand---Pat-Donahue.docx`,
        displayName: "AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue",
        isTest: false,
        status: "confirmed",
        analysis: { paragraphCount: 152, regions: [] },
        createdAt: "2026-09-01T07:28:28.328Z",
      }]),
    });
  });

  await page.goto("/");
  const longTitle = page.getByTitle(longName);
  const testCard = longTitle.locator("..");
  await expect(testCard).toContainText("Test template");
  await expect(testCard).toContainText("Test run");
  await expectTitleContained(testCard);

  const firmTitle = page.getByTitle("AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue");
  await expect(firmTitle.locator("..")).toContainText("Firm template");
  await page.getByPlaceholder("Search templates…").fill("AAA Insurance");
  await expect(firmTitle).toBeVisible();
  await expect(longTitle).toBeHidden();

  await page.getByPlaceholder("Search templates…").fill("");
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(longTitle).toBeVisible();
  await expectTitleContained(testCard);
});

test("map v2 keeps the full letter visible while its queue filters and synchronizes", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const templateId = "10000000-0000-4000-8000-000000000010";
  const makeBlock = (paragraphIndex: number, text: string, overrides: Record<string, unknown> = {}) => ({
    id: `word/document.xml:p:${paragraphIndex}`,
    paragraphIndex,
    text,
    role: "preserve",
    semanticKind: "prose",
    section: "Damages",
    aiRecommendation: "keep",
    confidence: 0.96,
    style: "BodyText",
    explanation: "Fixture recommendation.",
    needsAttention: false,
    anchor: { partName: "word/document.xml", kind: "paragraph", paragraphIndex, path: `/word/document.xml/paragraph[${paragraphIndex}]` },
    structuredGroup: null,
    figure: null,
    inlineFields: [],
    ...overrides,
  });
  const blocks = [
    makeBlock(0, "DEMAND FOR JORDAN CANARY", {
      role: "heading", semanticKind: "heading", section: "DEMAND FOR JORDAN CANARY",
      inlineFields: [{ key: "heading_client", label: "Client name", start: 11, end: 24, originalText: "JORDAN CANARY", kind: "person", confidence: 1, explanation: "Old matter name.", source: "model", role: "replace" }],
    }),
    makeBlock(1, "Old narrative requiring review.", { role: "editable", aiRecommendation: "replace", confidence: 0.72, needsAttention: true }),
    makeBlock(2, "MEDICAL EXPENSES", { role: "editable", aiRecommendation: "replace", structuredGroup: { id: "expenses", representation: "paragraph-rows", rowRole: "header", tableIndex: null, rowIndex: null, cellIndex: null, columnCount: 2, columnWidths: [] } }),
    makeBlock(3, "Old Hospital:\t$9,000", { role: "editable", aiRecommendation: "replace", structuredGroup: { id: "expenses", representation: "paragraph-rows", rowRole: "body", tableIndex: null, rowIndex: 0, cellIndex: null, columnCount: 2, columnWidths: [] } }),
    makeBlock(4, "[figure]", { role: "editable", semanticKind: "figure", aiRecommendation: "replace", figure: { relationshipId: "rId9", partName: "word/media/image1.png", contentType: "image/png", captionBlockId: "word/document.xml:p:5" } }),
    makeBlock(5, "Photograph 1: old damage."),
    makeBlock(6, "Reusable settlement boilerplate."),
  ];
  const template = {
    id: templateId, name: "map-v2-fixture.docx", displayName: "Map v2 fixture", isTest: true, status: "analyzed",
    analysis: {
      analysisVersion: 5, filename: "map-v2-fixture.docx", paragraphCount: 7, sectionCount: 1,
      hasMacros: false, hasTrackedChanges: false, hasComplexObjects: false, warnings: [],
      regions: blocks, blocks, replacementCandidates: [], knownCaseSpecificValues: [],
      imageCandidates: [{ blockId: "word/document.xml:p:4", paragraphIndex: 4, relationshipId: "rId9", partName: "word/media/image1.png", contentType: "image/png", captionBlockId: "word/document.xml:p:5" }],
    },
  };
  let generationRequests = 0;
  await page.route("**/api/demo/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: false }) }));
  await page.route("**/api/templates", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify([template]) }));
  await page.route("**/api/intakes", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ caseWorkspace: { id: "20000000-0000-4000-8000-000000000020" }, template }) }));
  await page.route(`**/api/templates/${templateId}/confirm`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ...template, status: "confirmed" }) }));
  await page.route("**/api/matters/20000000-0000-4000-8000-000000000020/template-map", (route) => route.fulfill({ contentType: "application/json", body: "{}" }));
  await page.route("**/api/matters/20000000-0000-4000-8000-000000000020", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    id: "20000000-0000-4000-8000-000000000020", name: "New matter", templateId, templateMapVersion: 1,
    sources: [{ id: "40000000-0000-4000-8000-000000000040", matterId: "20000000-0000-4000-8000-000000000020", name: "case.pdf", mimeType: "application/pdf", pageCount: 1, status: "ready" }],
    sourceFingerprint: "a".repeat(64), activeDraft: null, generationTargets: [],
  }) }));
  await page.route("**/api/matters/20000000-0000-4000-8000-000000000020/generations", (route) => {
    generationRequests += 1;
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "new-template-generation", status: "queued" }) });
  });
  await page.route("**/api/matters/20000000-0000-4000-8000-000000000020/activity", (route) => route.fulfill({ contentType: "application/json", body: "[]" }));
  await page.route("**/api/jobs/new-template-generation/events", (route) => route.fulfill({ contentType: "text/event-stream", body: "event: progress\ndata: {\"progress\":30,\"step\":\"Grounding draft in source pages\"}\n\n" }));

  await page.goto("/");
  await page.getByTitle("Map v2 fixture").click();
  await page.locator(".source-drop-zone input").setInputFiles({ name: "case.pdf", mimeType: "application/pdf", buffer: Buffer.from("synthetic") });
  await page.getByRole("button", { name: "Continue to template map" }).click();
  await expect(page.getByRole("heading", { name: "Review template structure" })).toBeVisible();
  await expect(page.locator(".map-document-block")).toHaveCount(7);
  await expect(page.locator(".map-review-card")).toHaveCount(5);
  await expect(page.locator(".map-review-card").filter({ hasText: "Structured group" })).toHaveCount(1);
  await expect(page.locator(".map-review-card").filter({ hasText: "Evidence figure" })).toHaveCount(1);
  const headingCard = page.locator(".map-review-card").filter({ hasText: "Locked heading" });
  await expect(headingCard).toContainText("Client name");
  await expect(headingCard.locator(".map-role-toggle")).toHaveCount(0);
  await expect(page.getByText("All changes saved locally")).toBeVisible();
  await expect(page).toHaveScreenshot("map-v2-1280x720.png", { animations: "disabled" });

  await page.locator(".map-filters").getByRole("button", { name: "replace" }).click();
  await expect(page.locator(".map-review-card")).toHaveCount(3);
  await expect(page.locator(".map-document-block")).toHaveCount(7);
  const narrativeDocument = page.locator('[data-review-unit="block:word/document.xml:p:1"]');
  await narrativeDocument.click();
  await expect(page.locator('[data-review-card="block:word/document.xml:p:1"]')).toHaveClass(/selected/);
  await page.locator('[data-review-card="group:expenses"]').click();
  await expect(page.locator('[data-review-unit="group:expenses"]').first()).toHaveClass(/selected/);

  await page.locator(".map-filters").getByRole("button", { name: "keep" }).click();
  const reusable = page.locator('[data-review-unit="block:word/document.xml:p:6"] p');
  await reusable.evaluate((node) => {
    const text = node.firstChild;
    if (!text) throw new Error("No text node");
    const range = document.createRange();
    range.setStart(text, 0); range.setEnd(text, 8);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await expect(page.locator(".map-selection-card")).toContainText("Reusable");
  await page.getByRole("button", { name: "Add replacement field" }).click();
  await expect(page.locator('[data-review-card="block:word/document.xml:p:6"]')).toContainText("Reusable");
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect(page).toHaveScreenshot("map-v2-1100x720.png", { animations: "disabled" });

  await page.locator(".map-filters").getByRole("button", { name: "attention" }).click();
  await page.locator(".map-recommendation").getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Confirm map" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Drafting in progress", { exact: true })).toBeVisible();
  expect(generationRequests).toBe(1);
});

test("saved template auto-generates one review card per blocker and supports editing, undo, versions, and rename", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const matterId = "20000000-0000-4000-8000-000000000020";
  const draftId = "30000000-0000-4000-8000-000000000030";
  const outcomeId = "outcome:narrative-fixture";
  const fixedTimestamp = "2026-09-02T12:00:00.000Z";
  let matterName = "Naomi Carter - PPC-2026-0417";
  let generationComplete = false;
  let generationRequests = 0;
  let version = 1;
  let confirmedOmissions: string[] = [];
  let outcomeStatus: "omitted" | "attorney-supplied" = "omitted";
  let suppliedText: string | null = null;
  let fieldValue: string | null = null;
  let keepText = "Reusable verified letter language.";
  const snapshots = new Map<number, { confirmedOmissions: string[]; fieldValue: string | null; keepText: string }>();
  const saveSnapshot = () => snapshots.set(version, { confirmedOmissions: [...confirmedOmissions], fieldValue, keepText });
  saveSnapshot();
  const outcome = () => ({
    id: outcomeId, targetId: "narrative-fixture", targetKind: "narrative",
    citations: [], note: outcomeStatus === "omitted" ? "No treatment records support this section." : null,
    sourceId: null, page: null, sourceName: null, mediaType: null, caption: null, exemplarCount: 2, generatedCount: suppliedText ? 1 : 0,
    status: outcomeStatus,
  });
  const content = () => ({
    title: "Time-Limited Policy Limits Demand",
    confirmedOmissionTargetIds: confirmedOmissions,
    fields: {
      recipient_email: {
        fieldKey: "recipient_email", oldValue: "old@example.test", value: fieldValue, label: "Delivery recipient email",
        citations: [], note: fieldValue === null ? "No recipient email was found." : null, attorneyEdited: fieldValue !== null,
      },
    },
    outcomes: [outcome()],
    sections: [{ id: "letter", heading: null, blocks: [
      { id: "keep-1", kind: "paragraph", text: keepText, templateParagraphIndex: 0, templateBlockId: "word/document.xml:p:0", citations: [], attorneyEdited: keepText !== "Reusable verified letter language.", targetId: null, outcomeId: null },
      ...(suppliedText ? [{ id: "supplied-1", kind: "paragraph", text: suppliedText, templateParagraphIndex: 1, templateBlockId: "word/document.xml:p:1", citations: [], attorneyEdited: true, targetId: "narrative-fixture", outcomeId, sequence: 0 }] : []),
    ] }],
  });
  const readiness = () => ({
    ready: (confirmedOmissions.includes("narrative-fixture") || outcomeStatus === "attorney-supplied") && fieldValue !== null,
    fieldKeys: fieldValue === null ? ["recipient_email"] : [],
    omittedTargetIds: confirmedOmissions.includes("narrative-fixture") || outcomeStatus === "attorney-supplied" ? [] : ["narrative-fixture"],
    duplicateParagraphIndexes: [], imageIssue: null, staleEvidence: false,
  });
  const matter = () => ({
    id: matterId, name: matterName, templateId: "10000000-0000-4000-8000-000000000010", templateMapVersion: 1,
    sources: [{ id: "40000000-0000-4000-8000-000000000040", matterId, name: "synthetic.pdf", mimeType: "application/pdf", pageCount: 1, status: "ready" }],
    sourceFingerprint: "a".repeat(64), activeDraft: generationComplete ? { id: draftId, version } : null,
    generationTargets: [{ id: "narrative-fixture", kind: "narrative", section: "Treatment history", blockIds: ["word/document.xml:p:1", "word/document.xml:p:2"], partName: "word/document.xml", exemplarCount: 2, minItems: 1, maxItems: 12, structuredGroupId: null, figure: null }],
  });
  const draftResponse = () => ({
    id: draftId, matterId, version, content: content(), readiness: readiness(),
    targets: [{ ...matter().generationTargets[0], label: "Treatment history", exemplarExcerpt: "Prior treatment narrative." }],
    sourceFingerprint: "a".repeat(64), createdAt: fixedTimestamp, updatedAt: fixedTimestamp,
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    if (url.pathname.endsWith("/web-apps/apps/api/documents/api.js")) return route.fulfill({ contentType: "text/javascript", body: `window.DocsAPI={DocEditor:function(id,config){document.getElementById(id).innerHTML='<div class="onlyoffice-test-document">Original formatted DOCX</div>';setTimeout(()=>config.events.onDocumentReady(),0);this.destroyEditor=()=>{};}};` });
    if (url.pathname === "/api/templates") return route.fulfill({ contentType: "application/json", body: "[]" });
    if (url.pathname === "/api/demo/status") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ available: true }) });
    if (url.pathname === "/api/demo/bootstrap") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ matterId }) });
    if (url.pathname === `/api/matters/${matterId}` && method === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify(matter()) });
    if (url.pathname === `/api/matters/${matterId}/activity`) return route.fulfill({ contentType: "application/json", body: "[]" });
    if (url.pathname === `/api/matters/${matterId}/generations` && method === "POST") {
      generationRequests += 1;
      return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "generation-job", status: "queued" }) });
    }
    if (url.pathname === "/api/jobs/generation-job/events") {
      generationComplete = true;
      return route.fulfill({ contentType: "text/event-stream", body: `event: completed\ndata: {\"progress\":100,\"step\":\"Draft ready\",\"draftId\":\"${draftId}\"}\n\n` });
    }
    if (url.pathname === `/api/drafts/${draftId}` && method === "GET") return route.fulfill({ contentType: "application/json", body: JSON.stringify(draftResponse()) });
    if (url.pathname === `/api/drafts/${draftId}/editor-config`) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ documentServerUrl: "http://onlyoffice.test", config: {} }) });
    if (url.pathname === `/api/drafts/${draftId}/versions`) return route.fulfill({ contentType: "application/json", body: JSON.stringify([...snapshots.keys()].sort((a, b) => b - a).map((item) => ({ version: item, actor: "Faby Rivera", timestamp: fixedTimestamp, changeSummary: item === 1 ? "Generated initial grounded draft" : "Attorney update", current: item === version }))) });
    if (url.pathname === `/api/drafts/${draftId}/outcomes/${encodeURIComponent(outcomeId)}/confirm` && method === "POST") {
      confirmedOmissions = ["narrative-fixture"]; version += 1; saveSnapshot();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(draftResponse()) });
    }
    if (url.pathname === `/api/drafts/${draftId}/outcomes/${encodeURIComponent(outcomeId)}/supply` && method === "POST") {
      suppliedText = (route.request().postDataJSON() as { values: string[] }).values[0] ?? null;
      outcomeStatus = "attorney-supplied"; version += 1; saveSnapshot();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(draftResponse()) });
    }
    if (url.pathname === `/api/drafts/${draftId}/fields/confirm` && method === "POST") {
      fieldValue = (route.request().postDataJSON() as { value: string }).value; version += 1; saveSnapshot();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(draftResponse()) });
    }
    if (url.pathname === `/api/drafts/${draftId}` && method === "PUT") {
      keepText = (route.request().postDataJSON() as { content: ReturnType<typeof content> }).content.sections[0]!.blocks[0]!.text;
      version += 1; saveSnapshot();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(draftResponse()) });
    }
    if (url.pathname === `/api/drafts/${draftId}/restore` && method === "POST") {
      const restored = snapshots.get((route.request().postDataJSON() as { restoreVersion: number }).restoreVersion)!;
      confirmedOmissions = [...restored.confirmedOmissions]; fieldValue = restored.fieldValue; keepText = restored.keepText;
      version += 1; saveSnapshot();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(draftResponse()) });
    }
    if (url.pathname === `/api/matters/${matterId}` && method === "PATCH") {
      matterName = (route.request().postDataJSON() as { name: string }).name;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: matterId, name: matterName }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: `Unhandled ${method} ${url.pathname}` }) });
  });

  await page.goto("/");
  await page.getByRole("button", { name: /Use the supplied Steno sample packet/ }).click();
  await expect(page.locator(".word-editor-shell")).toBeVisible();
  await expect(page.getByText("Original formatted DOCX")).toBeVisible();
  expect(generationRequests).toBe(1);
  await expect(page.locator(".panel-tabs button.active")).toHaveText("Review");
  await expect(page.getByRole("button", { name: "2 blocking · Review" })).toBeVisible();
  await expect(page.locator("[data-review-item]")).toHaveCount(2);
  await expect(page).toHaveScreenshot("generated-review-1280x720.png", { animations: "disabled" });
  const omissionCard = page.locator(`[data-review-item="${outcomeId}"]`);
  await omissionCard.locator(".review-field-input input").fill("May 29, 2026");
  await omissionCard.getByRole("button", { name: "Save value" }).click();
  await expect(page.locator(".matter-breadcrumb")).toContainText("Draft v2");
  await page.locator(".review-field-input input").fill("dana.kim@example.test");
  await page.getByRole("button", { name: "Save value" }).click();
  await expect(page.locator(".matter-breadcrumb")).toContainText("Draft v3");
  await expect(page.getByRole("link", { name: "Export to Word" })).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".matter-breadcrumb")).toContainText("Draft v4");
  await page.locator(".review-field-input input").fill("dana.kim@example.test");
  await page.getByRole("button", { name: "Save value" }).click();
  await expect(page.locator(".matter-breadcrumb")).toContainText("Draft v5");
  await page.getByTitle("Rename matter").click();
  await page.locator(".matter-breadcrumb input").fill("Carter demand");
  await page.locator(".matter-breadcrumb input").press("Enter");
  await expect(page.getByTitle("Rename matter")).toHaveText("Carter demand");
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByText("Draft versions")).toBeVisible();
  await expect(page.getByText("v5 · Current")).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 720 });
  await expect(page).toHaveScreenshot("generated-review-1100x720.png", { animations: "disabled" });
});

test("complete high-fidelity evidence-grounded schema-v2 workflow", async ({ page }) => {
  const generationTimeout = Number(process.env.E2E_GENERATION_TIMEOUT_MS ?? 180_000);
  let sourcePaths: string[] = [];
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create an evidence-grounded demand letter" })).toBeVisible();
  if (!process.env.E2E_SOURCE_DIR) await expect(page.getByText(/fictional case files/i)).toBeVisible();
  const generationResponsePromise = page.waitForResponse((response) => response.url().endsWith("/generations") && response.request().method() === "POST");

  const templatePath = process.env.E2E_TEMPLATE_PATH
    ? path.resolve(process.env.E2E_TEMPLATE_PATH)
    : path.resolve(process.cwd(), "../../AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue.docx");

  if (process.env.E2E_SOURCE_DIR) {
    sourcePaths = fs.readdirSync(process.env.E2E_SOURCE_DIR)
      .filter((name) => /\.(pdf|png|jpe?g|webp)$/i.test(name))
      .sort()
      .map((name) => path.join(process.env.E2E_SOURCE_DIR as string, name));
    expect(sourcePaths).toHaveLength(7);
    await page.locator(".upload-template-card input").setInputFiles(templatePath);
    await page.locator(".source-drop-zone input").setInputFiles(sourcePaths);
    await expect(page.getByText(`${sourcePaths.length} selected`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Continue to template map" }).click();
    const mapHeading = page.getByRole("heading", { name: "Review template structure" });
    const draftingHeading = page.getByText("Drafting in progress", { exact: true });
    await expect(mapHeading.or(draftingHeading)).toBeVisible({ timeout: generationTimeout });
    if (await mapHeading.isVisible()) {
      await expect(page.getByText(/complete original letter stays visible/i)).toBeVisible();
      await expect(page.locator(".map-document-block").first()).toBeVisible();
      while (await page.locator(".map-review-card.attention .map-recommendation button").count()) {
        await page.locator(".map-review-card.attention .map-recommendation button").first().click();
      }
      await page.getByRole("button", { name: "Confirm map" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
    }
  } else {
    await page.getByRole("button", { name: /Use the supplied Steno sample packet/ }).click();
  }
  const generationResponse = await generationResponsePromise;
  const generationJobId = ((await generationResponse.json()) as { jobId?: string }).jobId;
  if (!generationJobId) throw new Error("Generation response did not contain a job id");
  const duplicateGeneration = await page.request.post(generationResponse.url(), { data: {} });
  expect(duplicateGeneration.status()).toBe(409);
  await expect(page.getByText("Drafting in progress")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Refine with AI")).toBeVisible();
  await expect(page.locator(".word-editor-shell")).toBeVisible({ timeout: generationTimeout });
  await expect(page.locator(".word-editor-shell iframe")).toBeVisible({ timeout: generationTimeout });
  const generatedJobResponse = await page.request.get(`/api/jobs/${generationJobId}`);
  const draftId = ((await generatedJobResponse.json()) as { draftId?: string }).draftId;
  if (!draftId) throw new Error("Generated export link did not contain a draft id");

  let currentVersion = 1;
  await page.locator(".source-strip > button").last().click();
  await expect(page.locator(".drawer-source")).toHaveCount(sourcePaths.length || 5);

  const supplementalPdf = sourcePaths.find((sourcePath) => /\.pdf$/i.test(sourcePath));
  if (supplementalPdf) {
    const regenerationResponsePromise = page.waitForResponse((response) => response.url().endsWith("/generations") && response.request().method() === "POST");
    await page.locator(".drawer-evidence-actions input").setInputFiles(supplementalPdf);
    const regenerationResponse = await regenerationResponsePromise;
    expect(regenerationResponse.status()).toBe(202);
    const staleDraftResponse = await page.request.get(`/api/drafts/${draftId}`);
    const staleExportResponse = await page.request.get(`/api/drafts/${draftId}/export.docx`);
    expect(staleDraftResponse.ok()).toBe(true);
    if ((await staleDraftResponse.json()).readiness.staleEvidence) expect(staleExportResponse.status()).toBe(409);
    await expect(page.locator(".drawer-source")).toHaveCount((sourcePaths.length || 5) + 1);
    await page.locator(".source-drawer .icon-button").click();
    currentVersion = 2;
    await expect(page.locator(".matter-breadcrumb").getByText("Draft v2", { exact: true })).toBeVisible({ timeout: generationTimeout });
    await page.locator(".source-strip > button").last().click();
  }

  await page.locator(".source-drawer .icon-button").click();
  await expect(page.locator(".word-editor-state.error")).toBeHidden({ timeout: generationTimeout });

  let fieldKey: string | null = null;
  let confirmedFieldCount = 0;
  await page.getByRole("button", { name: "Review", exact: true }).click();
  while (await page.locator('[data-review-item^="field:"] .review-field-input').count() > 0) {
    const field = page.locator('[data-review-item^="field:"] .review-field-input').first();
    fieldKey ??= (await field.locator("xpath=ancestor::article[1]").locator("h3").textContent())?.replaceAll(" ", "_") ?? null;
    confirmedFieldCount += 1;
    await field.locator("input").fill(process.env.E2E_CONFIRMED_FIELD_VALUE ?? `REVIEWED-TEST-${String(confirmedFieldCount).padStart(3, "0")}`);
    await field.locator("xpath=ancestor::article[1]").getByRole("button", { name: "Save value" }).click();
    currentVersion += 1;
    await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  }

  while (await page.locator('[data-review-item]:not([data-review-item^="field:"])').count() > 0) {
    await expect(page.getByRole("button", { name: /blocking · Review/ })).toBeVisible();
    const card = page.locator('[data-review-item]:not([data-review-item^="field:"])').first();
    if (await card.locator(".review-field-input input").count()) {
      await card.locator(".review-field-input input").fill(process.env.E2E_CONFIRMED_FIELD_VALUE ?? "ATTORNEY-SUPPLIED-TEST");
      await card.getByRole("button", { name: "Save value" }).click();
    } else {
      await card.getByRole("button", { name: "Leave blank" }).click();
    }
    currentVersion += 1;
    await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  }

  const exportHref = await page.getByRole("link", { name: "Export to Word" }).getAttribute("href");
  expect(exportHref).toContain(draftId);
  const staleConfirmation = await page.request.post(`/api/drafts/${draftId}/fields/confirm`, {
    data: { version: currentVersion - 1, key: fieldKey ?? "missing-field", value: "STALE-WRITE" },
  });
  expect(staleConfirmation.status()).toBe(409);

  await page.getByRole("button", { name: "Refine with AI" }).click();
  await expect(page.locator(".refine-target select")).toBeVisible();
  await page.locator(".composer textarea").fill("Make these passages more concise without changing any facts");
  await page.getByRole("button", { name: "Send refinement" }).click();
  await expect(page.locator(".proposal-card")).toContainText("Proposed edit", { timeout: 90_000 });
  const proposedEdits = await page.locator(".proposal-preview > div").count();
  expect(proposedEdits).toBeGreaterThanOrEqual(1);
  expect(proposedEdits).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Accept" }).click();
  currentVersion += 1;
  await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByText("Accepted an AI edit proposal")).toBeVisible();
  await expect(page.getByText("Faby Rivera").first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export to Word" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  if (process.env.E2E_DOWNLOAD_PATH) await download.saveAs(process.env.E2E_DOWNLOAD_PATH);
});
