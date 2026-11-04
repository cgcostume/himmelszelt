import { expect, test } from "./fixtures.js";

test("the Moon figure renders without WebGPU errors and reports the Moon", async ({ page, problems }) => {
    await page.goto("nachtgestirn/");
    await page.locator("#moon").scrollIntoViewIfNeeded();
    await page.waitForTimeout(4000);
    await expect(page.locator('#moon [data-field="moon"]')).toContainText("% lit");
    expect(problems).toEqual([]);
});
