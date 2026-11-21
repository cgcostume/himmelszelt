// Measures a chapter's costs: imports the chapter's `src/components/<chapter>/bench.ts` into its page on the running dev
// server, as WebGPU needs a secure context, and calls its `bench(options)` in Chromium with WebGPU on this machine's GPU.
// Prints the result; --write puts it into `src/components/<chapter>/bench.json`, which the chapter's figures import.
//
//   pnpm dev                                    (in another terminal)
//   pnpm bench <chapter> [--write] [--rounds 9] [--frames 1000] [--warmup 400] [--cases cases.json]
//                        [--url http://localhost:4321]
//
// A chapter's bench.ts takes the cases in turn, round after round (`interleaved` in src/components/bench.ts), so what
// else loads the GPU falls on all of them alike; --cases measures cases of one's own instead of the chapter's figures',
// as its bench.ts reads them, and never writes. Measure on a quiet machine: the runner prints the GPU's load before the
// run and the other Chromium GPU processes, and keeps both in the result, to tell a contaminated run.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        write: { type: "boolean", default: false },
        rounds: { type: "string", default: "9" },
        frames: { type: "string", default: "1000" },
        warmup: { type: "string", default: "400" },
        cases: { type: "string" },
        url: { type: "string", default: "http://localhost:4321" },
    },
});
const [chapter] = positionals;
const module = chapter && join(here, `../src/components/${chapter}/bench.ts`);
if (!module || !existsSync(module)) {
    console.error("usage: pnpm bench <chapter> [--write] [--rounds n] [--frames n] [--warmup n] [--cases file.json]");
    process.exit(1);
}
const cases = args.cases ? JSON.parse(readFileSync(args.cases, "utf8")) : undefined;

// The GPU's load in percent, where the kernel tells it (amdgpu), sampled for two seconds, and the other Chromium GPU
// processes running: what would share the GPU with the measure.
const busyFile = readdirSync("/sys/class/drm", { withFileTypes: true })
    .map((entry) => `/sys/class/drm/${entry.name}/device/gpu_busy_percent`)
    .find((file) => existsSync(file));
const busy = () => (busyFile ? Number(readFileSync(busyFile, "utf8")) : Number.NaN);
const busyBefore = [];
for (let i = 0; i < 10; i++) {
    busyBefore.push(busy());
    await new Promise((resolve) => setTimeout(resolve, 200));
}
// Playwright's own Chromiums, other agents' or tests', apart from a desktop browser, which idles on a page unseen.
const count = (pattern) => {
    try {
        return Number(execFileSync("pgrep", ["-fc", "--", pattern], { encoding: "utf8" }).trim());
    } catch {
        return 0;
    }
};
const otherBrowsers = count("ms-playwright.*--type=gpu-process");
const desktop = count("--type=gpu-process") - otherBrowsers;
console.log(
    `GPU busy before: ${busyBefore.join(" ")} %; headless Chromiums: ${otherBrowsers}, desktop browsers: ${desktop}`,
);

const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: [
        "--enable-unsafe-webgpu",
        "--enable-features=Vulkan",
        "--use-angle=vulkan",
        "--disable-dawn-features=timestamp_quantization",
    ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (error) => console.error("page:", error.message));
page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("bench:")) process.stderr.write(`${text}\n`);
    else if (message.type() === "error" || /WebGPU|GPUValidationError/.test(text)) console.error("page:", text);
});
// The dev server's socket left unanswered: a file changed meanwhile would otherwise reload the page mid-measure.
await page.routeWebSocket(/.*/, () => {});
await page.goto(`${args.url.replace(/\/$/, "")}/${chapter}/`, { waitUntil: "load" });
const result = await page.evaluate(
    async ({ chapter, options }) => {
        const { bench } = await import(`/src/components/${chapter}/bench.ts`);
        return bench({ ...options, progress: (message) => console.log(`bench: ${message}`) });
    },
    {
        chapter,
        options: {
            rounds: Number(args.rounds),
            frames: Number(args.frames),
            warmup: Number(args.warmup),
            ...(cases ? { cases } : {}),
        },
    },
);
const busyAfter = busy();
await browser.close();

const measure = {
    ...result,
    browser: `Chromium ${browser.version().split(".")[0]}`,
    date: new Date().toISOString().slice(0, 10),
    machine: { busyBefore, otherBrowsers, desktop },
};
console.log(JSON.stringify(measure, null, 2));
console.log(`GPU busy right after: ${busyAfter} %`);
if (otherBrowsers > 0 || Math.max(...busyBefore) > 5)
    console.warn("The GPU was not idle before the run: other work may have shared it, rerun on a quiet machine.");
if (args.write && !cases) {
    const file = join(here, `../src/components/${chapter}/bench.json`);
    writeFileSync(file, `${JSON.stringify(measure, null, 4)}\n`);
    // In the repository's own format, so the check stays clean.
    try {
        execFileSync("pnpm", ["exec", "biome", "format", "--write", file], { stdio: "ignore" });
    } catch {}
    console.log(`wrote ${file}`);
}
