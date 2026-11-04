import { expect, test } from "./fixtures.js";

const status = (page: import("@playwright/test").Page) => page.locator('#stars [data-field="status"]');

test("the stars figure renders without WebGPU errors and counts the stars above the horizon", async ({
    page,
    problems,
}) => {
    // A moonless August night over Berlin: the Milky Way across the south.
    await page.goto("sternenheer/?date=2026-08-12T22:00Z&lat=52.52&lon=13.405&h=1");
    await page.locator("#stars").scrollIntoViewIfNeeded();
    await expect(status(page)).toContainText("stars above the horizon", { timeout: 15_000 });
    await expect(status(page)).toContainText("Moon below the horizon");
    for (const name of ["twinkle", "glare", "eye", "air"]) await page.locator(`#stars [data-field="${name}"]`).click();
    await page.waitForTimeout(1500);
    expect(problems).toEqual([]);
});

test("the meter exposes a moonless night for the Milky Way and a day for the sky", async ({ page, problems }) => {
    const ev = async () => Number(await page.locator('#stars [data-field="ev"]').textContent());
    await page.goto("sternenheer/?date=2026-08-12T22:00Z&lat=52.52&lon=13.405&h=1");
    await page.locator("#stars").scrollIntoViewIfNeeded();
    await expect.poll(ev, { timeout: 15_000 }).toBeLessThan(-8);
    await page.goto("sternenheer/?date=2026-08-12T12:00Z&lat=52.52&lon=13.405&h=1");
    await page.locator("#stars").scrollIntoViewIfNeeded();
    await expect.poll(ev, { timeout: 15_000 }).toBeGreaterThan(13);
    expect(problems).toEqual([]);
});
