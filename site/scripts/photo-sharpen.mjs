// Fits for each photograph of nachtgestirn's photo figure the unsharp mask that gives nachtgestirn's Moon the
// photograph's sharpness: renders each in the running dev server, the Moon alone and the photograph alone, and over the
// disc's lit part, where both show it, compares how much of the contrast lies at each scale, finest first, each band
// against a coarse one, so the processing's tone curve does not count. Prints the radius, as a fraction of the disc's,
// and the amount; --write puts them into photo-options.ts.
//
//   pnpm dev                                   (in another terminal)
//   node scripts/photo-sharpen.mjs [--write] [--only 0,2] [--url http://localhost:4321/nachtgestirn/]
//
// A tool for the chapter while its content is worked on, not part of any package.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { PHOTOS } from "../src/components/nachtgestirn/photo-options.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OPTIONS = join(here, "../src/components/nachtgestirn/photo-options.ts");
const { values: args } = parseArgs({
    options: {
        write: { type: "boolean", default: false },
        only: { type: "string" },
        url: { type: "string", default: "http://localhost:4321/nachtgestirn/" },
    },
});
// The figure's disc radius as a share of its stage's shorter side, as photo.ts has it.
const DISC = 0.42;
const SIZE = 900;

function gray(png) {
    const raw = execFileSync("magick", ["png:-", "-colorspace", "Gray", "-depth", "8", "gray:-"], {
        input: png,
        maxBuffer: 1 << 28,
    });
    return Float32Array.from(raw);
}

function blur(img, n, sigma) {
    if (sigma <= 0) return img;
    const r = Math.ceil(3 * sigma);
    const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
    const sum = k.reduce((a, b) => a + b);
    const pass = (src, dx, dy) => {
        const out = new Float32Array(src.length);
        for (let y = 0; y < n; y++)
            for (let x = 0; x < n; x++) {
                let v = 0;
                for (let i = -r; i <= r; i++) {
                    const xx = Math.min(n - 1, Math.max(0, x + i * dx));
                    const yy = Math.min(n - 1, Math.max(0, y + i * dy));
                    v += src[yy * n + xx] * k[i + r];
                }
                out[y * n + x] = v / sum;
            }
        return out;
    };
    return pass(pass(img, 1, 0), 0, 1);
}

// How much of the contrast lies in each band, finest first, as a log against the coarse band's.
const SCALES = [0, 0.75, 1.5, 3];
function bands(img, n, mask) {
    const levels = [...SCALES, 12].map((s) => blur(img, n, s));
    const std = (a, b) => {
        let [s, s2, count] = [0, 0, 0];
        for (const i of mask) {
            const d = a[i] - b[i];
            s += d;
            s2 += d * d;
            count++;
        }
        return Math.sqrt(s2 / count - (s / count) ** 2);
    };
    const coarse = std(levels[SCALES.length - 1], levels[SCALES.length]);
    return SCALES.slice(0, -1).map((_, i) => Math.log(std(levels[i], levels[i + 1]) / coarse));
}

const unsharp = (img, n, sigma, amount) => {
    const b = blur(img, n, sigma);
    return img.map((v, i) => Math.max(0, Math.min(255, v + amount * (v - b[i]))));
};

async function settled(page, clip) {
    let last = null;
    for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(1000);
        const shot = await page.screenshot({ clip });
        if (last?.equals(shot)) return shot;
        last = shot;
    }
    throw new Error("the render never settled");
}

const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"],
});
const page = await (
    await browser.newContext({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 })
).newPage();
await page.goto(args.url);
// The square fixed over the page's top left, out of the figure's overflow, without the marks and the buttons.
await page.addStyleTag({
    content: `#photo .photo-compare { position: fixed !important; left: 0; top: 0; z-index: 1000; width: ${SIZE}px !important; }
    #photo .photo-marks, #photo .tiles-start, #photo .tiles-ends { visibility: hidden; }`,
});
await page.locator("#photo").scrollIntoViewIfNeeded();
// nachtgestirn's Moon as it renders, unsharpened.
await page.evaluate(() => {
    const sharpen = document.querySelector("#photo [data-field=sharpen]");
    if (sharpen.getAttribute("aria-pressed") === "true") sharpen.click();
});
const only = args.only?.split(",").map(Number);
const fitted = [];
for (const [index, photo] of PHOTOS.entries()) {
    if (only && !only.includes(index)) continue;
    await page.evaluate((i) => document.querySelector(`#photo [data-pick="${i}"]`).click(), index);
    await page.waitForLoadState("networkidle");
    const split = (value) =>
        page.evaluate((v) => {
            const s = document.querySelector("#photo [data-field=split]");
            s.value = String(v);
            s.dispatchEvent(new Event("input", { bubbles: true }));
        }, value);
    const clip = { x: 0, y: 0, width: SIZE, height: SIZE };
    await split(0);
    const render = gray(await settled(page, clip));
    await split(100);
    const shot = gray(await settled(page, clip));
    // The disc's lit part, where both show it, short of the limb.
    const r = DISC * SIZE;
    const mask = [];
    for (let y = 0; y < SIZE; y++)
        for (let x = 0; x < SIZE; x++) {
            const i = y * SIZE + x;
            if (Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2) < 0.9 * r && render[i] > 40 && shot[i] > 40)
                mask.push(i);
        }
    const target = bands(shot, SIZE, mask);
    const error = (b) => b.reduce((e, v, i) => e + (v - target[i]) ** 2, 0);
    let best = { sigma: 0, amount: 0, error: error(bands(render, SIZE, mask)) };
    const plain = best.error;
    for (const sigma of [0.5, 0.75, 1, 1.5, 2, 3])
        for (let amount = 0.25; amount <= 4; amount += 0.25) {
            const e = error(bands(unsharp(render, SIZE, sigma, amount), SIZE, mask));
            if (e < best.error) best = { sigma, amount, error: e };
        }
    const radius = Number((best.sigma / r).toFixed(5));
    fitted.push({ index, radius, amount: best.amount });
    console.log(
        `${index} ${photo.label}: radius ${radius} (${best.sigma} px of ${r.toFixed(0)}), amount ${best.amount}, ` +
            `error ${plain.toFixed(3)} to ${best.error.toFixed(3)}, ${mask.length} pixels; bands photo ` +
            `${target.map((v) => v.toFixed(2)).join(" ")}, render ${bands(render, SIZE, mask)
                .map((v) => v.toFixed(2))
                .join(" ")}`,
    );
}
await browser.close();

if (args.write) {
    let source = readFileSync(OPTIONS, "utf8");
    for (const { index, radius, amount } of fitted) {
        let at = source.indexOf("export const PHOTOS");
        for (let i = 0; i <= index; i++) at = source.indexOf("sharpen: {", at + 1);
        const end = source.indexOf("}", at);
        source = `${source.slice(0, at)}sharpen: { radius: ${radius}, amount: ${amount} ${source.slice(end)}`;
    }
    writeFileSync(OPTIONS, source);
}
