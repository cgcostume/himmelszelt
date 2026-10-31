import { expect, test } from "./fixtures.js";

test("the chapter's figures render without WebGPU errors", async ({ page, problems }) => {
    await page.goto("dunstkreis/");
    await page.locator("#generator").scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    expect(problems).toEqual([]);
});
