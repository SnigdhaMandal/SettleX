import { Keypair } from "@stellar/stellar-sdk";
import { expect, test } from "@playwright/test";

test("connects, signs in, creates an expense, and pays a share", async ({ page }) => {
  const wallet = Keypair.random();
  const friend = Keypair.random();

  // Install every route before navigation so auth and Horizon requests cannot
  // race ahead of their handlers. The server-issued auth challenge and the
  // payment XDR are both signed by a freshly generated real Stellar keypair.
  await page.addInitScript((secret) => {
    window.__SETTLEX_E2E_WALLET_SECRET = secret;
  }, wallet.secret());

  await page.route(/https:\/\/horizon-testnet\.stellar\.org\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === "/fee_stats") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fee_charged: { p70: "100" }, min_accepted_fee: "100" }),
      });
      return;
    }

    if (url.pathname === `/accounts/${wallet.publicKey()}`) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sequence: "100",
          balances: [{ asset_type: "native", balance: "1000.0000000" }],
        }),
      });
      return;
    }

    if (url.pathname === "/transactions" && request.method() === "POST") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ hash: "a".repeat(64), ledger: 123, successful: true }),
      });
      return;
    }

    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });

  await page.goto("/auth");
  await page.getByRole("button", { name: "Connect Freighter Wallet" }).click();
  await expect(page.getByLabel("Your Name")).toBeVisible();
  await page.getByLabel("Your Name").fill("E2E Wallet");
  await page.getByRole("button", { name: "Create Account" }).click();
  await page.waitForURL("**/dashboard");

  await page.goto("/expenses");
  await page.getByRole("button", { name: "New Expense" }).click();
  await page.getByLabel("Expense title").fill("Playwright payment expense");
  await page.getByLabel("Total amount").fill("10");

  const names = page.getByPlaceholder("Name *");
  const addresses = page.locator('input[placeholder^="Stellar address"]');
  await names.nth(0).fill("E2E Wallet");
  await names.nth(1).fill("E2E Friend");
  await addresses.nth(1).fill(friend.publicKey());
  await page.locator("select").selectOption({ label: "E2E Friend" });
  await page.getByRole("button", { name: "Create Expense" }).click();

  const expense = page.getByText("Playwright payment expense", { exact: true });
  await expect(expense).toBeVisible();
  await expense.click();

  const payButton = page.getByRole("button", { name: /Pay 5\.00 XLM/ });
  await expect(payButton).toBeEnabled();
  await payButton.click();
  await expect(page.getByText("Paid", { exact: false }).first()).toBeVisible({ timeout: 15_000 });
});
