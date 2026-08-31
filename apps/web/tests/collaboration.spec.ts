import { expect, test } from "@playwright/test";

test("two signed users converge, reconnect, persist, and preserve agent proposals", async ({ browser }) => {
  test.setTimeout(90_000);
  const fabyContext = await browser.newContext();
  const alexContext = await browser.newContext();
  const faby = await fabyContext.newPage();
  const alex = await alexContext.newPage();

  await faby.goto("/");
  await faby.getByRole("button", { name: "Use the supplied Steno sample packet" }).click();
  await expect(faby.getByRole("heading", { name: "Generate the first draft" })).toBeVisible({ timeout: 30_000 });
  await faby.getByRole("button", { name: "Generate evidence-grounded draft" }).click();
  await expect(faby.getByText("Canonical collaborative draft")).toBeVisible({ timeout: 30_000 });
  await expect(faby.getByText("Connected & synced")).toBeVisible({ timeout: 15_000 });

  const sharedUrl = new URL(faby.url());
  sharedUrl.searchParams.set("identity", "alex");
  sharedUrl.searchParams.set("collab", "1");
  await alex.goto(sharedUrl.toString());
  await expect(alex.getByLabel("Demo identity")).toHaveValue("alex");
  await expect(alex.getByText("Connected & synced")).toBeVisible({ timeout: 15_000 });
  await expect(faby.getByTestId("presence-user").filter({ hasText: "Alex Chen" })).toBeVisible();
  await expect(alex.getByTestId("presence-user").filter({ hasText: "Faby Rivera" })).toBeVisible();

  const collaborativeText = "Shared settlement position very clearly reflects the cited materials.";
  const fabyEditor = faby.getByLabel("Collaborative draft editor");
  await fabyEditor.click();
  await faby.keyboard.press("Meta+A");
  await faby.keyboard.type(collaborativeText);
  await expect(alex.getByLabel("Collaborative draft editor")).toContainText(collaborativeText, { timeout: 10_000 });

  const draftId = new URL(faby.url()).searchParams.get("draftId");
  expect(draftId).toBeTruthy();
  await expect.poll(async () => {
    const response = await faby.request.get(`/api/collaboration/drafts/${draftId}/status`);
    return (await response.json() as { version: number }).version;
  }, { timeout: 10_000 }).toBeGreaterThan(0);

  await alex.reload();
  await expect(alex.getByText("Connected & synced")).toBeVisible({ timeout: 15_000 });
  await expect(alex.getByLabel("Collaborative draft editor")).toContainText(collaborativeText);

  await faby.getByPlaceholder("e.g. Make this more concise without changing facts").fill("Make this more concise without changing facts");
  await faby.locator(".refine-bar > button").click();
  await expect(faby.getByText("AI edit proposal")).toBeVisible();
  await faby.getByRole("button", { name: "Accept into shared draft" }).click();
  const acceptedText = "Shared settlement position clearly reflects the cited materials.";
  await expect(alex.getByLabel("Collaborative draft editor")).toContainText(acceptedText, { timeout: 10_000 });

  await faby.getByLabel("Collaborative draft editor").click();
  await faby.keyboard.press("End");
  await faby.keyboard.type(" Unsupported demand $99,999.00.");
  await expect(faby.getByLabel("Live evidence validation")).toContainText(/\d+ blocked/, { timeout: 15_000 });
  await faby.getByRole("button", { name: "Export Word" }).click();
  await expect(faby.getByText("Resolve the blocked evidence checks before export.")).toBeVisible();

  await faby.reload();
  await faby.getByRole("button", { name: "Activity" }).first().click();
  await expect(faby.getByText("Faby Rivera edited the collaborative draft").first()).toBeVisible();
  await expect(faby.getByText("Faby Rivera Agent proposed an edit for Faby Rivera")).toBeVisible();
  await expect(faby.getByText("Faby Rivera Agent", { exact: true })).toBeVisible();
  await expect(faby.getByText("Accepted an AI edit into the collaborative draft")).toBeVisible();

  await fabyContext.close();
  await alexContext.close();
});
