import { expect, test } from "@playwright/test";

test("complete reviewed-template workflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Start with your firm’s Word document" })).toBeVisible();

  await page.getByRole("button", { name: "Use the supplied Steno sample packet" }).click();
  await expect(page.getByRole("heading", { name: "Generate the first draft" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".source-item")).toHaveCount(5);

  await page.getByRole("button", { name: /MAX_MRI_Radiology_Invoice/ }).click();
  await expect(page.getByText("PAGE 1")).toBeVisible();
  await expect(page.locator(".extracted-text")).toContainText("Patrick Donahue");
  await page.getByRole("button", { name: "All sources" }).click();

  await page.getByRole("button", { name: "Generate evidence-grounded draft" }).click();
  await expect(page.getByText("Canonical collaborative draft")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Connected & synced")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Live evidence validation")).toContainText(/review warnings|Evidence checks ready/, { timeout: 15_000 });

  const paragraph = page.locator('.collaborative-editor p[data-block-id]').first();
  await paragraph.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" The records were very carefully reviewed.");
  await expect(page.getByLabel("Live evidence validation")).toContainText("review warnings", { timeout: 15_000 });

  await page.getByPlaceholder("e.g. Make this more concise without changing facts").fill("Make this more concise without changing facts");
  await page.locator(".refine-bar > button").click();
  await expect(page.getByText("AI edit proposal")).toBeVisible();
  await expect(page.getByText("NOT APPLIED")).toBeVisible();
  await page.getByRole("button", { name: "Accept into shared draft" }).click();
  await expect(page.getByText("Accepted into the shared draft")).toBeVisible();
  await expect(paragraph).not.toContainText("very carefully");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Word" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.docx$/);

  await page.getByRole("button", { name: "Activity" }).first().click();
  await expect(page.getByText("Accepted an AI edit into the collaborative draft")).toBeVisible();
  await expect(page.getByText("Published a validated collaborative snapshot")).toBeVisible();
  await expect(page.locator(".activity-drawer").getByText("Faby Rivera", { exact: true }).first()).toBeVisible();
});
