// Measures the reference of the stars chapter's budget figure: every row of budget-rows.ts through the figure's own
// benchmark, budget-bench.ts, in Chromium with WebGPU on this machine's GPU, on the running dev server, as WebGPU needs a
// secure context. Prints each row's milliseconds a frame, its spread over the rounds and its passes, the GPU memory its
// pass holds and the files' sizes; --write puts them into budget-reference.json, which the figure draws.
//
//   pnpm dev                                   (in another terminal)
//   node scripts/stars-budget.mjs [--write] [--rounds 41] [--frames 64] [--warmup 8] [--rounded]
//                                 [--url http://localhost:4321/sternenheer/]
//
// The Chromium flags give a real GPU on Linux with Vulkan and timestamps as the GPU's clock has them; --rounded leaves
// them rounded, to 0.066 ms, as a reader's browser has them, to see what the figure's own button then reports. Measure on
// a quiet machine: the rows are taken in turn, round after round, and the medians hold under some load, the spread
// tells how much there was.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const REFERENCE = join(here, "../src/components/sternenheer/budget-reference.json");
const { values: args } = parseArgs({
    options: {
        write: { type: "boolean", default: false },
        rounded: { type: "boolean", default: false },
        rounds: { type: "string", default: "41" },
        frames: { type: "string", default: "64" },
        warmup: { type: "string", default: "8" },
        url: { type: "string", default: "http://localhost:4321/sternenheer/" },
    },
});

const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: [
        ...(args.rounded
            ? ["--enable-features=Vulkan,WebGPU"]
            : ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--disable-dawn-features=timestamp_quantization"]),
        "--use-angle=vulkan",
    ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (error) => console.error("page:", error.message));
page.on("console", (message) => {
    if (message.type() === "error" || /WebGPU|Invalid|GPUValidationError/.test(message.text()))
        console.error("page:", message.text());
});
// The dev server's socket left unanswered: a file changed meanwhile would otherwise reload the page mid-measure.
await page.routeWebSocket(/.*/, () => {});
await page.goto(args.url, { waitUntil: "load" });
const measure = await page.evaluate(
    async ({ rounds, frames, warmup }) => {
        const { gpu, gpuDevice } = await import("/src/components/dunstkreis/atmosphere.ts");
        const { BUDGET_ROWS } = await import("/src/components/sternenheer/budget-rows.ts");
        const { measureBudget } = await import("/src/components/sternenheer/budget-bench.ts");
        const options = { rounds, frames, warmup, account: true };
        return measureBudget(gpuDevice(), BUDGET_ROWS, gpu.adapterName, options);
    },
    { rounds: Number(args.rounds), frames: Number(args.frames), warmup: Number(args.warmup) },
);
measure.browser = `Chromium ${browser.version().split(".")[0]}`;
measure.date = new Date().toISOString().slice(0, 10);
await browser.close();

// Four digits after the point, a tenth of a microsecond: more than the clock gives.
const round = (ms) => Math.round(ms * 1e4) / 1e4;
for (const row of Object.values(measure.rows)) {
    row.frame = round(row.frame);
    row.spread = { p10: round(row.spread.p10), p90: round(row.spread.p90) };
    for (const name of Object.keys(row.passes)) row.passes[name] = round(row.passes[name]);
}

const MiB = 2 ** 20;
console.log(`${measure.gpu}, ${measure.browser}, ${measure.rounds} rounds of ${measure.frames} frames`);
const clock = measure.quantized ? `rounded to ${measure.quantum.toFixed(3)} ms` : "exact";
console.log(`timestamps ${measure.timestamps ? clock : "none"}\n`);
for (const [id, row] of Object.entries(measure.rows)) {
    const passes = Object.entries(row.passes).map(([name, ms]) => `${name} ${ms.toFixed(3)}`);
    const memory = Object.values(row.memory ?? {}).reduce((sum, bytes) => sum + bytes, 0) / MiB;
    const spread = `[${row.spread.p10.toFixed(3)} ${row.spread.p90.toFixed(3)}]`;
    console.log(`${id.padEnd(9)} ${row.frame.toFixed(3)} ms ${spread}  ${passes.join("  ")}  ${memory.toFixed(1)} MiB`);
}
console.log(
    `\nfiles: ${Object.entries(measure.files ?? {})
        .map(([name, bytes]) => `${name} ${bytes}`)
        .join(", ")}`,
);

if (args.write) {
    writeFileSync(REFERENCE, `${JSON.stringify(measure, null, 4)}\n`);
    execFileSync("npx", ["biome", "format", "--write", REFERENCE], { stdio: "ignore" });
    console.log(`\nwritten to ${REFERENCE}`);
}
