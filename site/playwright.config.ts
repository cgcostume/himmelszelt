import { defineConfig } from "@playwright/test";

// The site in a real browser, on the real GPU: Chromium with WebGPU through Vulkan. Not part of `pnpm test`, as CI has no
// GPU; run with `pnpm --filter @himmelszelt/sternwarte test:browser`, next to or without a running `pnpm dev`.
export default defineConfig({
    testDir: "./tests",
    reporter: "list",
    timeout: 60_000,
    use: {
        baseURL: "http://localhost:4321/",
        viewport: { width: 1280, height: 900 },
        launchOptions: {
            // WebGPU only in a secure context, which localhost is. Without the Vulkan flags Chromium falls back to
            // SwiftShader, on the CPU.
            args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan", "--ozone-platform=x11"],
        },
        channel: "chromium",
    },
    webServer: { command: "pnpm dev", url: "http://localhost:4321/", reuseExistingServer: true },
});
