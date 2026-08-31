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
  await expect(page.getByText("Draft editor")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/case-specific template regions were cleared/)).toBeVisible();
  await expect(page.locator(".citation-pill").first()).toBeVisible();

  const editor = page.locator(".block-editor").first();
  await editor.fill("The enclosed records very clearly document the charges reflected in the source materials.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Version 2/)).toBeVisible();

  await page.getByPlaceholder("e.g. Make this more concise without changing facts").fill("Make this more concise without changing facts");
  await page.locator(".refine-bar > button").click();
  await expect(page.getByText("AI edit proposal")).toBeVisible();
  await expect(page.getByText("NOT APPLIED")).toBeVisible();
  await page.getByRole("button", { name: "Accept as new version" }).click();
  await expect(page.getByText(/Version 3/)).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).first().click();
  await expect(page.getByText("Accepted an AI edit proposal")).toBeVisible();
  await expect(page.getByText("Faby Rivera").first()).toBeVisible();
  await page.locator(".activity-drawer .icon-button").click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Export Word" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.docx$/);
});
