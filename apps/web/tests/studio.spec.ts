import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function selectText(page: Page, editor: Locator, start: number, end: number) {
  await editor.evaluate((node, range) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!textNode) throw new Error("Editor contains no selectable text");
    const selection = window.getSelection();
    const selectionRange = document.createRange();
    selectionRange.setStart(textNode, Math.min(range.start, textNode.textContent?.length ?? 0));
    selectionRange.setEnd(textNode, Math.min(range.end, textNode.textContent?.length ?? 0));
    selection?.removeAllRanges();
    selection?.addRange(selectionRange);
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, { start, end });
  await page.getByRole("button", { name: "Add to chat ↗" }).click();
}

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

test("complete high-fidelity evidence-grounded v1 workflow", async ({ page }) => {
  const generationTimeout = Number(process.env.E2E_GENERATION_TIMEOUT_MS ?? 180_000);
  let sourcePaths: string[] = [];
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Create an evidence-grounded demand letter" })).toBeVisible();
  if (!process.env.E2E_SOURCE_DIR) await expect(page.getByText(/real case files/i)).toBeVisible();

  const templatePath = process.env.E2E_TEMPLATE_PATH
    ? path.resolve(process.env.E2E_TEMPLATE_PATH)
    : path.resolve(process.cwd(), "../../AAA Insurance - Time Limited Policy Limits Demand - Pat Donahue.docx");
  await page.locator(".upload-template-card input").setInputFiles(templatePath);
  await expect(page.getByRole("heading", { name: "Confirm what AI may replace" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".region-review-row").first()).toBeVisible();
  await page.getByRole("button", { name: "Confirm regions" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  if (process.env.E2E_SOURCE_DIR) {
    sourcePaths = fs.readdirSync(process.env.E2E_SOURCE_DIR)
      .filter((name) => /\.(pdf|png|jpe?g|webp)$/i.test(name))
      .sort()
      .map((name) => path.join(process.env.E2E_SOURCE_DIR as string, name));
    expect(sourcePaths).toHaveLength(5);
    await page.locator(".source-drop-zone input").setInputFiles(sourcePaths);
    await expect(page.getByText("5 selected", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review evidence" }).click();
  } else {
    await page.getByRole("button", { name: /Use the supplied Steno sample packet/ }).click();
  }
  await expect(page.getByRole("heading", { name: /Reviewing source coverage|Review the source packet before drafting/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Generate attorney-review draft" })).toBeVisible({ timeout: generationTimeout });
  await expect(page.getByText(/does not determine completeness, authenticity, admissibility, or legal validity/i)).toBeVisible();
  const generationResponsePromise = page.waitForResponse((response) => response.url().endsWith("/generations") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Generate attorney-review draft" }).click();
  const generationResponse = await generationResponsePromise;
  const generationJobId = ((await generationResponse.json()) as { jobId?: string }).jobId;
  if (!generationJobId) throw new Error("Generation response did not contain a job id");
  const duplicateGeneration = await page.request.post(generationResponse.url(), { data: {} });
  expect(duplicateGeneration.status()).toBe(409);
  await expect(page.getByText("Drafting in progress")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Refine with AI")).toBeVisible();
  await expect(page.locator(".letter-paper")).toBeVisible({ timeout: generationTimeout });
  await expect(page.locator(".draft-section").first()).toBeVisible();
  await expect(page.locator(".citation-pill").first()).toBeVisible();
  const generatedJobResponse = await page.request.get(`/api/jobs/${generationJobId}`);
  const draftId = ((await generatedJobResponse.json()) as { draftId?: string }).draftId;
  if (!draftId) throw new Error("Generated export link did not contain a draft id");

  let currentVersion = 1;
  await page.locator(".source-strip > button").last().click();
  await expect(page.locator(".drawer-source")).toHaveCount(5);

  const supplementalPdf = sourcePaths.find((sourcePath) => /\.pdf$/i.test(sourcePath));
  if (supplementalPdf) {
    await page.locator(".drawer-evidence-actions input").setInputFiles(supplementalPdf);
    await expect(page.getByText(/predates the current source set/i)).toBeVisible({ timeout: 30_000 });
    const staleDraftResponse = await page.request.get(`/api/drafts/${draftId}`);
    const staleExportResponse = await page.request.get(`/api/drafts/${draftId}/export.docx`);
    expect(staleDraftResponse.ok()).toBe(true);
    expect(staleExportResponse.status()).toBe(409);
    expect((await staleExportResponse.json()).issues).toEqual((await staleDraftResponse.json()).readiness);
    await expect(page.getByRole("button", { name: /Regenerate v2/ })).toBeVisible({ timeout: generationTimeout });
    await page.getByRole("button", { name: /Regenerate v2/ }).click();
    currentVersion = 2;
    await expect(page.locator(".matter-breadcrumb").getByText("Draft v2", { exact: true })).toBeVisible({ timeout: generationTimeout });
    await expect(page.locator(".drawer-source")).toHaveCount(6);
    const staleRegeneration = await page.request.post(generationResponse.url(), {
      data: { draftId, baseVersion: 1 },
    });
    expect(staleRegeneration.status()).toBe(409);
  }

  await page.locator(".source-drawer .icon-button").click();
  await expect(page.locator(".section-drafting")).toBeHidden({ timeout: generationTimeout });
  await page.locator(".citation-pill").first().click();
  await expect(page.locator(".source-detail")).toContainText("Reference 1");
  await expect(page.locator(".source-detail a")).toHaveAttribute("href", /\/api\/sources\/.+\/file#page=\d+/);
  const sourceHref = await page.locator(".source-detail a").getAttribute("href");
  const sourceResponse = await page.request.get(sourceHref?.split("#")[0] ?? "");
  expect(sourceResponse.ok()).toBe(true);
  expect(sourceResponse.headers()["content-type"]).toMatch(/application\/pdf/);
  await page.locator(".source-drawer .icon-button").click();

  let fieldKey: string | null = null;
  let confirmedFieldCount = 0;
  while (await page.locator(".merge-field.low-confidence").count() > 0) {
    const field = page.locator(".merge-field.low-confidence").first();
    fieldKey ??= await field.locator("label span").textContent();
    confirmedFieldCount += 1;
    await field.locator("input").fill(process.env.E2E_CONFIRMED_FIELD_VALUE ?? `REVIEWED-TEST-${String(confirmedFieldCount).padStart(3, "0")}`);
    await field.getByRole("button", { name: "Confirm" }).click();
    currentVersion += 1;
    await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  }

  let unresolvedIndex = 0;
  while (await page.locator(".draft-block.unsupported").count() > 0) {
    await expect(page.getByRole("button", { name: "Export to Word" })).toBeDisabled();
    const unsupportedEditor = page.locator(".draft-block.unsupported .block-editor").first();
    await unsupportedEditor.fill(`Attorney-reviewed synthetic replacement ${unresolvedIndex + 1}. This text is for automated verification only.`);
    await page.locator(".letterhead").click();
    unresolvedIndex += 1;
    currentVersion += 1;
    await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
    await page.locator(".draft-block.unsupported").first().getByRole("button", { name: "Confirm reviewed text" }).click();
    await page.locator(".confirmation-note textarea").fill("Reviewed against the uploaded test packet for automated acceptance.");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm reviewed text" }).click();
    currentVersion += 1;
    await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  }

  const firstEditor = page.locator(".block-editor").first();
  await firstEditor.fill("The enclosed records very clearly document the charges reflected in the source materials.");
  await page.locator(".letterhead").click();
  currentVersion += 1;
  await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  await page.locator(".draft-block").first().getByRole("button", { name: "Confirm reviewed text" }).click();
  await page.locator(".confirmation-note textarea").fill("Reviewed the direct edit against the cited source material.");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm reviewed text" }).click();
  currentVersion += 1;
  await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  const exportHref = await page.getByRole("link", { name: "Export to Word" }).getAttribute("href");
  expect(exportHref).toContain(draftId);
  const staleConfirmation = await page.request.post(`/api/drafts/${draftId}/fields/confirm`, {
    data: { version: currentVersion - 1, key: fieldKey ?? "missing-field", value: "STALE-WRITE" },
  });
  expect(staleConfirmation.status()).toBe(409);

  await selectText(page, firstEditor, 4, 29);
  const secondEditor = page.locator(".block-editor").nth(1);
  await selectText(page, secondEditor, 0, 24);
  await expect(page.locator(".annotation-chip")).toHaveCount(2);

  await page.locator(".composer textarea").fill("Make these passages more concise without changing any facts");
  await page.getByRole("button", { name: "Send refinement" }).click();
  await expect(page.locator(".proposal-card")).toContainText("Proposed edit", { timeout: 90_000 });
  const proposedEdits = await page.locator(".proposal-render").count();
  expect(proposedEdits).toBeGreaterThanOrEqual(1);
  expect(proposedEdits).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "Accept" }).click();
  currentVersion += 1;
  await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  while (await page.getByRole("button", { name: "Confirm reviewed text" }).count() > 0) {
    await page.getByRole("button", { name: "Confirm reviewed text" }).first().click();
    await page.locator(".confirmation-note textarea").fill("Reviewed the accepted AI revision against the cited source material.");
    await page.getByRole("dialog").getByRole("button", { name: "Confirm reviewed text" }).click();
    currentVersion += 1;
    await expect(page.locator(".matter-breadcrumb").getByText(`Draft v${currentVersion}`, { exact: true })).toBeVisible();
  }

  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByText("Accepted an AI edit proposal")).toBeVisible();
  await expect(page.getByText("Faby Rivera").first()).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export to Word" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
  if (process.env.E2E_DOWNLOAD_PATH) await download.saveAs(process.env.E2E_DOWNLOAD_PATH);
});
