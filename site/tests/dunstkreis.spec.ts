import { choose, expect, test } from "./fixtures.js";

test.beforeEach(async ({ page }) => {
    await page.goto("dunstkreis/");
    // The lighting figure's readout shows sunlight once the environment is built from the sky at the chosen moment, which
    // happens only while the figure is on screen.
    await page.locator("#lighting").scrollIntoViewIfNeeded();
    await expect(page.locator('#lighting [data-field="info"]')).toContainText(/sunlight [1-9]/, { timeout: 30_000 });
});

test("the chapter's figures render without WebGPU errors", async ({ page, problems }) => {
    await page.waitForTimeout(1000);
    expect(problems).toEqual([]);
});

for (const background of ["atmosphere", "sky map"]) {
    for (const ground of ["floor", "backdrop"]) {
        test(`lighting: ${ground} ground, ${background}`, async ({ page, problems }, testInfo) => {
            const figure = page.locator("#lighting");
            await figure.scrollIntoViewIfNeeded();
            await choose(page, "lighting-background", background);
            await choose(page, "lighting-ground", ground);
            // The running sum of 64 frames.
            await page.waitForTimeout(1500);
            const path = testInfo.outputPath(`lighting-${ground}-${background.replace(" ", "-")}.png`);
            await figure.locator("canvas").screenshot({ path });
            await testInfo.attach("lighting", { path, contentType: "image/png" });
            expect(problems).toEqual([]);
        });
    }
}
