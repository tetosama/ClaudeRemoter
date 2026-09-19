import { expect, test } from "@playwright/test";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Access password").fill("playwright-test-password");
  await page.getByRole("button", { name: "Enter workspace" }).click();
  if ((page.viewportSize()?.width ?? 1024) < 760) {
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  } else {
    await expect(page.getByText("REMOTER", { exact: true })).toBeVisible();
  }
}

test("authenticates, adds a project, and creates a session", async ({ page }) => {
  await login(page);
  if ((page.viewportSize()?.width ?? 1024) < 760) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("button", { name: "Add project" }).click();
  const directoryDialog = page.getByRole("dialog", { name: "Select project directory" });
  await expect(directoryDialog).toBeVisible();
  await expect(directoryDialog.locator(".path-input input")).not.toHaveValue("");
  await page.getByRole("button", { name: "Use this directory" }).click();
  await expect(page.locator(".sidebar").getByRole("button", { name: /tmp/ })).toBeVisible();
  const createResponse = page.waitForResponse((response) => response.url().endsWith("/api/sessions") && response.request().method() === "POST");
  await page.locator(".sidebar .new-session").click();
  const createdSession = await (await createResponse).json() as { id: string };
  await expect(page.locator(`.chat-layout[data-session-id="${createdSession.id}"]`)).toBeVisible();
  await expect(page.getByLabel("Message to Claude")).toBeVisible();
  await expect(page.locator(".chat-header select")).toHaveCount(0);
  await expect(page.locator(".composer-session-controls").getByLabel("Model")).toBeVisible();
  await expect(page.locator(".composer-session-controls").getByLabel("Mode")).toBeVisible();
  await expect(page.locator(".composer-session-controls").getByLabel("Effort")).toBeVisible();
  await expect(page.locator(".connection.open")).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByLabel("Mode").selectOption("bypassPermissions");
  await expect(page.getByLabel("Mode")).toHaveValue("bypassPermissions");
  await page.getByLabel("Effort").selectOption("medium");
  await expect(page.getByLabel("Effort")).toHaveValue("medium");
  await page.locator(".attach-button input").setInputFiles([
    {
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") },
  ]);
  await expect(page.getByText("pixel.png")).toBeVisible();
  await expect(page.getByText("notes.txt")).toBeVisible();
  if ((page.viewportSize()?.width ?? 1024) >= 760) {
    await expect(page.getByText("Runs locally")).toBeVisible();
  }
});

test("mobile navigation opens as a drawer", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await login(page);
  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.className = "markdown mobile-overflow-fixture";
    fixture.innerHTML = `<p><strong><code>${"very-long-unbroken-inline-code-".repeat(14)}</code></strong></p>`;
    document.querySelector(".transcript")?.append(fixture);
  });
  for (const width of [320, 375, 430]) {
    await page.setViewportSize({ width, height: 780 });
    await expect.poll(() => page.evaluate(() => {
      const composer = document.querySelector(".composer")?.getBoundingClientRect();
      const viewportBottom = window.visualViewport?.height || window.innerHeight;
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        composerVisible: Boolean(composer && composer.top >= 0 && composer.bottom <= viewportBottom + 1),
      };
    })).toEqual({ clientWidth: width, scrollWidth: width, composerVisible: true });
  }
  await page.setViewportSize({ width: 430, height: 560 });
  await expect.poll(() => page.evaluate(() => {
    const composer = document.querySelector(".composer")?.getBoundingClientRect();
    const viewportBottom = window.visualViewport?.height || window.innerHeight;
    return Boolean(composer && composer.top >= 0 && composer.bottom <= viewportBottom + 1);
  })).toBe(true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.locator(".sidebar").getByRole("button", { name: "Close navigation" })).toBeVisible();
});

test("mobile composer follows the visual viewport when the keyboard pans it", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "mobile-only assertion");
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    const geometry = { height: 664, offsetTop: 0, pageTop: 0, scale: 1, width: 390, offsetLeft: 0, pageLeft: 0 };
    for (const key of Object.keys(geometry) as Array<keyof typeof geometry>) {
      Object.defineProperty(viewport, key, { configurable: true, get: () => geometry[key] });
    }
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    (window as unknown as { setKeyboardViewport: (height: number, top: number, pageTop?: number) => void }).setKeyboardViewport = (height, top, pageTop = top) => {
      geometry.height = height;
      geometry.offsetTop = top;
      geometry.pageTop = pageTop;
      viewport.dispatchEvent(new Event("resize"));
      viewport.dispatchEvent(new Event("scroll"));
    };
  });
  await login(page);
  const composer = page.locator(".composer");
  await expect(composer).toBeVisible();
  await page.getByLabel("Message to Claude").focus();
  await page.evaluate(() => {
    (window as unknown as { setKeyboardViewport: (height: number, top: number, pageTop?: number) => void }).setKeyboardViewport(348, 32, 180);
  });
  await expect.poll(() => page.evaluate(() => {
    const value = document.querySelector(".composer")?.getBoundingClientRect();
    const viewport = window.visualViewport!;
    return Boolean(value && value.top >= viewport.pageTop - 1 && value.bottom <= viewport.pageTop + viewport.height + 1);
  })).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--app-top"))).toBe("180px");
});
