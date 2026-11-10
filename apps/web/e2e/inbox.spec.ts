import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

type State = { tenantId: string; userId: string; adminId: string; cards: string[] };
const state = (): State => JSON.parse(readFileSync(new URL("./.state.json", import.meta.url), "utf8"));

async function signIn(page: Page, userId = state().userId) {
  const s = state();
  await page.goto("/inbox");
  await expect(page).toHaveURL(/\/login\?next=%2Finbox/);
  await page.getByLabel("Tenant ID").fill(s.tenantId);
  await page.getByLabel("User ID").fill(userId);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/inbox$/);
}

test("a rep signs in, approves one card from the keyboard and bulk-approves the rest", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("link", { name: "alpha-leads.com" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(3);

  // Card view: evidence quote, AI-written span and keyboard approve (A) moves on to the next card.
  await page.getByRole("link", { name: "alpha-leads.com" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("alpha-leads.com");
  await page.getByRole("button", { name: /Buys leads/ }).click();
  await expect(page.locator("mark.quote")).toHaveText("“We buy ACA leads from publishers.”");
  await expect(page.locator("span.ai").first()).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.getByRole("heading", { level: 1 })).not.toContainText("alpha-leads.com");

  // Undo within 5 seconds brings the card back undecided; approving again sends it when the window ends.
  await expect(page.locator(".toast")).toContainText("Approved alpha-leads.com");
  await page.keyboard.press("u");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("alpha-leads.com");
  await expect(page.getByRole("button", { name: /Approve & queue/ })).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.locator(".toast")).toBeHidden({ timeout: 10_000 });

  // Table: the approved card is gone; approve the remaining group in one go.
  await page.goto("/inbox");
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await page.getByLabel("Select group").check();
  await page.getByRole("button", { name: "Approve selected" }).click();
  await expect(page.getByRole("status")).toContainText("2 approved");
  await expect(page.getByText("No cards waiting.")).toBeVisible();
});

test("the BFF refuses mutations without the CSRF header and unauthenticated calls", async ({ page, request }) => {
  const anon = await request.get("/api/v1/me");
  expect(anon.status()).toBe(401);
  await signIn(page);
  const noCsrf = await page.request.post(`/api/v1/cards/${state().cards[0]}/snooze`, { data: { until: new Date(Date.now() + 86_400_000).toISOString() } });
  expect(noCsrf.status()).toBe(403);
});

test("an admin invites a teammate and imports accounts from a CSV", async ({ page }) => {
  await signIn(page, state().adminId);

  await page.getByRole("link", { name: "Team" }).click();
  await page.getByLabel("Email").fill("new.rep@agency.vn");
  await page.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByRole("status").filter({ hasText: "new.rep@agency.vn added" })).toBeVisible();
  const row = page.getByRole("row", { name: /new\.rep@agency\.vn/ });
  await expect(row).toContainText("invited");
  page.once("dialog", (d) => d.accept());
  await row.getByRole("button", { name: "Revoke invite" }).click();
  await expect(row).toContainText("disabled");

  await page.getByRole("link", { name: "Import" }).click();
  await page.getByLabel(/File/).setInputFiles({ name: "buyers.csv", mimeType: "text/csv",
    buffer: Buffer.from("Company,Website,State\nDelta Leads,deltaleads.com,TX\nEcho Media,echomedia.com,FL\nNo Domain Co,,CA\n") });
  await page.getByRole("button", { name: "Upload and map columns" }).click();
  await expect(page).toHaveURL(/\/imports\/[0-9a-f-]+$/);
  await expect(page.getByLabel("Field for Website")).toHaveValue("company_domain");
  await page.getByRole("button", { name: /run the dry-run/ }).click();
  await expect(page.getByText("2 ready")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Import 2 rows" }).click();
  await expect(page.getByText("2 created, 0 matched existing records")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Roll back" }).click();
  await expect(page.getByText(/Rolled back: 2 records removed/)).toBeVisible();
});
