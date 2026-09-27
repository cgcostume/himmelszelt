import { test as base, expect, type Page } from "@playwright/test";

/** Berlin, 21 June 2026 at 10 UT: the Sun some 55 degrees up, so every figure has daylight and shadows. */
export const MOMENT_AND_PLACE = {
    jd: Date.UTC(2026, 5, 21, 10) / 86_400_000 + 2_440_587.5,
    latitude: 52.52,
    longitude: 13.405,
    heightM: 1,
    live: false,
};

/**
 * A page with a fixed moment and place, and what went wrong on it: uncaught exceptions, console errors, and WebGPU's
 * validation messages, which Chrome logs as warnings.
 */
export const test = base.extend<{ problems: string[] }>({
    problems: [
        async ({ page }, use) => {
            const problems: string[] = [];
            page.on("pageerror", (error) => problems.push(`exception: ${error.message}`));
            page.on("response", (response) => {
                if (response.status() >= 400) problems.push(`${response.status()}: ${response.url()}`);
            });
            page.on("console", (message) => {
                const text = message.text();
                // Failed loads come with their address from the response handler.
                if (text.startsWith("Failed to load resource")) return;
                if (message.type() === "error" || /WebGPU|Invalid|GPUValidationError/.test(text)) {
                    problems.push(`${message.type()}: ${text}`);
                }
            });
            await page.addInitScript((state) => {
                localStorage.setItem("sternwarte:momentAndPlace", JSON.stringify(state));
            }, MOMENT_AND_PLACE);
            await use(problems);
        },
        // Every test gets the fixed moment and place, whether it asks for the problems or not.
        { auto: true },
    ],
});

/** Clicks the button of a radio group whose input is hidden behind its label. */
export async function choose(page: Page, name: string, value: string) {
    await page.locator(`label:has(input[name="${name}"][value="${value}"])`).click();
}

export { expect };
