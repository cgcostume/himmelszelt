import { expect, test } from "./fixtures.js";

test("WebGPU runs on the GPU, not on SwiftShader", async ({ page }) => {
    await page.goto("");
    const adapter = await page.evaluate(async () => {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
        return adapter && { vendor: adapter.info.vendor, architecture: adapter.info.architecture };
    });
    expect(adapter, "no WebGPU adapter").toBeTruthy();
    test.info().annotations.push({ type: "adapter", description: `${adapter?.vendor} ${adapter?.architecture}` });
    expect(adapter?.architecture).not.toBe("swiftshader");
});
