import { readdirSync } from "node:fs";
import { expect, test } from "./fixtures.js";

const chapters = readdirSync(new URL("../src/content/chapters/", import.meta.url)).map((file) =>
    file.replace(/\.mdx$/, ""),
);

for (const path of ["", ...chapters.map((chapter) => `${chapter}/`)]) {
    test(`/${path} loads without errors`, async ({ page, problems }) => {
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await page.waitForLoadState("networkidle");
        expect(problems).toEqual([]);
    });
}
