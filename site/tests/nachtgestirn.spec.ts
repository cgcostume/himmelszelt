import { expect, test } from "./fixtures.js";

const ev = async (page: import("@playwright/test").Page) =>
    Number(await page.locator('#moon [data-field="ev"]').textContent());

test("the Moon figure renders without WebGPU errors and reports the Moon", async ({ page, problems }) => {
    await page.goto("nachtgestirn/");
    await page.locator("#moon").scrollIntoViewIfNeeded();
    await page.waitForTimeout(4000);
    await expect(page.locator('#moon [data-field="moon"]')).toContainText("% lit");
    expect(problems).toEqual([]);
});

test("the meter exposes a full Moon by looney 11 and a day Moon for the sky", async ({ page, problems }) => {
    // Full Moon over Berlin, 60° up at night: its lit surface a stop over mid gray, through 83 % air.
    await page.goto("nachtgestirn/?date=2026-11-24T22:00Z&lat=52.52&lon=13.405&h=1");
    await page.locator("#moon").scrollIntoViewIfNeeded();
    await expect.poll(() => ev(page), { timeout: 10_000 }).toBeGreaterThan(13.3);
    expect(await ev(page)).toBeLessThan(14.3);
    // A crescent at noon, 23 % lit: the blue sky around it is brighter and sets the exposure.
    await page.goto("nachtgestirn/?date=2026-11-04T11:00Z&lat=52.52&lon=13.405&h=1");
    await page.locator("#moon").scrollIntoViewIfNeeded();
    await expect.poll(() => ev(page), { timeout: 10_000 }).toBeGreaterThan(14);
    expect(problems).toEqual([]);
});

test("the maps follow the disc's size, and the switch picks one", async ({ page, problems }) => {
    const maps: string[] = [];
    page.on("request", (request) => {
        const name = /moon-(color|normals)-[^/?]+/.exec(request.url())?.[0];
        if (name) maps.push(name);
    });
    await page.goto("nachtgestirn/");
    const canvas = page.locator('#moon [data-field="canvas"]');
    await canvas.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    expect(maps.some((name) => name.includes("4k"))).toBe(false);
    await canvas.hover();
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -400);
    await expect.poll(() => maps.includes("moon-color-4k.webp"), { timeout: 10_000 }).toBe(true);
    await page.locator('label:has(input[name="moon-maps"][value="small"])').click();
    await expect.poll(() => maps.includes("moon-color-512.webp"), { timeout: 10_000 }).toBe(true);
    expect(problems).toEqual([]);
});

test("the textured Moon view draws behind sternzeit's overlay, from the place and locked", async ({
    page,
    problems,
}) => {
    await page.goto("nachtgestirn/?date=2026-11-12T16:00Z&lat=52.52&lon=13.405&h=1");
    const figure = page.locator("#moon-face");
    await figure.scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    await expect(figure.locator(".moon-panel > svg .moon-grid").first()).toBeAttached();
    // The overlay leaves the disc to the canvas.
    await expect(figure.locator(".moon-panel > svg .moon-day")).toHaveCount(0);
    await figure.locator('[data-field="lockMoon"]').click();
    await page.waitForTimeout(1500);
    expect(problems).toEqual([]);
});
