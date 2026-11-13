// Measures the color of nachtgestirn's eclipsed Moon against Yapo's and Cutler's raw frames of February 21, 2008: renders
// the eclipse figure's tiles in the running dev server, lays each photograph onto its tile by the placement
// scripts/photo-fit.mjs fitted, and bins both, pixel by pixel, by how far the surface point under the pixel lies from
// the shadow's axis, in umbral radii. Per bin: the mean linear sRGB of render and photograph where neither is clipped
// nor black, their chromaticities and the render's brightness over the photograph's, as a table, a CSV and an SVG.
//
//   pnpm dev                                   (in another terminal)
//   node scripts/eclipse-color.mjs [--out dir] [--only 0,1] [--step 0.05] [--low 8] [--keep-sky] [--url http://localhost:4321/nachtgestirn/]
//
// A tool for the chapter and the paper while the content is worked on, not part of any package.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fromDate, julianDayUT } from "@himmelszelt/sternzeit";
import { chromium } from "@playwright/test";
import { CLIFTON_PARK, ECLIPSE_PHOTOS } from "../src/components/nachtgestirn/eclipse-photos.ts";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
    options: {
        out: { type: "string" },
        only: { type: "string" },
        step: { type: "string", default: "0.05" },
        // The darkest encoded value a channel may have in both images, above the black where noise rules.
        low: { type: "string", default: "8" },
        // Keep the sky the photographs' disc stands in, light pollution and glow, instead of taking it off.
        "keep-sky": { type: "boolean", default: false },
        url: { type: "string", default: "http://localhost:4321/nachtgestirn/" },
        size: { type: "string", default: "512" },
    },
});
// As eclipsephotos.ts has them: the disc's radius as a share of a tile; the photographs 1024 pixels square.
const DISC = 0.455;
const PHOTO_PX = 1024;
const MOON_RADIUS_KM = 1737.4;
const CSS = Number(args.size);
const DPR = 2;
const S = CSS * DPR;
const STEP = Number(args.step);
const BINS = Math.ceil(1.2 / STEP);
// Encoded 8-bit values a channel must lie within in both images: above `--low`, below the clip.
const [LOW, HIGH] = [Number(args.low), 245];
// Only so far out on the disc, clear of the limb, where a pixel straddles the sky.
const INSIDE = 0.97;
// The ring of the photographs' sky its level is read from, in disc radii, clear of the limb's glow and the corners.
const SKY = [1.15, 1.35];

const linear = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
function rgb(file, width, height) {
    const raw = execFileSync("magick", [file, "-depth", "8", "rgb:-"], { maxBuffer: 1 << 30 });
    if (raw.length !== width * height * 3) throw new Error(`${file}: ${raw.length} bytes, not ${width}x${height}x3`);
    return raw;
}

const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"],
});
const columns = ECLIPSE_PHOTOS.length;
const page = await browser.newPage({ viewport: { width: columns * CSS, height: CSS }, deviceScaleFactor: DPR });
await page.goto(args.url);
// The figure fixed over the page's top left, the row of the photographs' tiles alone, the photographs hidden.
await page.addStyleTag({
    content: `#photo-eclipse { position: fixed !important; left: 0; top: 0; margin: 0 !important; width: ${columns * CSS}px !important; max-width: none !important; z-index: 1000; }
    #photo-eclipse > :not(.eclipse-photos), #photo-eclipse .eclipse-photo, #photo-eclipse .tiles-ends { display: none !important; }`,
});
const canvas = page.locator("#photo-eclipse .eclipse-photos > canvas");
await canvas.scrollIntoViewIfNeeded();
const box = await canvas.boundingBox();
if (Math.abs(box.width - columns * CSS) > 0.5 || box.x !== 0 || box.y !== 0)
    throw new Error(`canvas at ${JSON.stringify(box)}`);
let shot = null;
for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(1000);
    const next = await page.screenshot({ clip: { x: 0, y: 0, width: columns * CSS, height: CSS } });
    if (shot?.equals(next)) break;
    shot = next;
    if (i === 59) throw new Error("the render never settled");
}
// The frame each tile is drawn in and Earth's shadow, from the page's own modules, so they are the figure's.
const moments = ECLIPSE_PHOTOS.map((p) => julianDayUT(fromDate(new Date(p.date))));
const geometry = await page.evaluate(
    async ({ moments, place }) => {
        const { tables } = await import("/src/components/dunstkreis/atmosphere.ts");
        const { moonAt } = await import("/src/components/nachtgestirn/renderer.ts");
        const { tileFrame } = await import("/src/components/nachtgestirn/tiles.ts");
        const model = tables()?.luts.model;
        if (!model) throw new Error("no atmosphere tables in the page");
        return moments.map((jd) => {
            const m = moonAt(jd, place, model);
            const { right, up, toward } = tileFrame(m);
            const e = m.earthShadow;
            return {
                right,
                up,
                toward,
                axis: e.axis,
                center: e.moonCenterKm,
                umbraKm: e.umbraKm,
                depth: m.shadow.umbralMagnitude,
            };
        });
    },
    { moments, place: CLIFTON_PARK },
);
await browser.close();

const rowFile = join(here, ".eclipse-color-render.png");
writeFileSync(rowFile, shot);
const row = rgb(rowFile, columns * S, S);
execFileSync("rm", [rowFile]);

const only = args.only?.split(",").map(Number);
const results = [];
for (const [index, photo] of ECLIPSE_PHOTOS.entries()) {
    if (only && !only.includes(index)) continue;
    const g = geometry[index];
    const img = rgb(join(here, "../public/eclipse-2008", photo.file), PHOTO_PX, PHOTO_PX);
    // The sky behind the Moon, light pollution and glow, which adds to every pixel of the disc too: its median per
    // channel, linear, taken off the photograph's pixels before they are compared.
    const sky = [0, 1, 2].map((ch) => {
        if (args["keep-sky"]) return 0;
        const values = [];
        for (let j = 0; j < PHOTO_PX; j += 2) {
            for (let i = 0; i < PHOTO_PX; i += 2) {
                const r = Math.hypot(i - photo.center[0], j - photo.center[1]) / photo.radius;
                if (r > SKY[0] && r < SKY[1]) values.push(linear(img[(j * PHOTO_PX + i) * 3 + ch]));
            }
        }
        return values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    });
    // The tile's pixel d from its center lands on the photograph's center + R(-turn) d / k, as the figure's CSS has it.
    const k = (DISC * S) / photo.radius;
    const [c, s] = [Math.cos((-photo.turn * Math.PI) / 180) / k, Math.sin((-photo.turn * Math.PI) / 180) / k];
    const R = DISC * S;
    const sums = Array.from({ length: BINS }, () => ({ n: 0, render: [0, 0, 0], photo: [0, 0, 0] }));
    for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
            const [dx, dy] = [x + 0.5 - S / 2, y + 0.5 - S / 2];
            const [u, v] = [dx / R, -dy / R];
            const r2 = u * u + v * v;
            if (r2 > INSIDE * INSIDE) continue;
            // The surface point under the pixel, in km from Earth's center, and its distance from the shadow's axis.
            const z = Math.sqrt(1 - r2);
            const q = [0, 1, 2].map(
                (i) => g.center[i] + MOON_RADIUS_KM * (u * g.right[i] + v * g.up[i] + z * g.toward[i]),
            );
            const along = q[0] * g.axis[0] + q[1] * g.axis[1] + q[2] * g.axis[2];
            const off = Math.hypot(q[0] - along * g.axis[0], q[1] - along * g.axis[1], q[2] - along * g.axis[2]);
            const bin = Math.floor(off / g.umbraKm / STEP);
            if (bin >= BINS) continue;
            const at = (y * columns * S + index * S + x) * 3;
            const ours = [row[at], row[at + 1], row[at + 2]];
            // Bilinear in the photograph.
            const px = photo.center[0] + c * dx - s * dy - 0.5;
            const py = photo.center[1] + s * dx + c * dy - 0.5;
            const [ix, iy] = [Math.floor(px), Math.floor(py)];
            if (ix < 0 || iy < 0 || ix >= PHOTO_PX - 1 || iy >= PHOTO_PX - 1) continue;
            const [fx, fy] = [px - ix, py - iy];
            const theirs = [0, 1, 2].map((ch) => {
                const p = (j, i) => img[(j * PHOTO_PX + i) * 3 + ch];
                const top = p(iy, ix) * (1 - fx) + p(iy, ix + 1) * fx;
                return top * (1 - fy) + (p(iy + 1, ix) * (1 - fx) + p(iy + 1, ix + 1) * fx) * fy;
            });
            if ([...ours, ...theirs].some((value) => value < LOW || value > HIGH)) continue;
            const b = sums[bin];
            b.n++;
            for (let ch = 0; ch < 3; ch++) {
                b.render[ch] += linear(ours[ch]);
                b.photo[ch] += linear(theirs[ch]) - (sky[ch] ?? 0);
            }
        }
    }
    const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const chroma = (rgb) => rgb.map((v) => v / (rgb[0] + rgb[1] + rgb[2]));
    const bins = sums
        .map((b, i) => {
            if (b.n < 200) return null;
            const render = b.render.map((v) => v / b.n);
            const theirs = b.photo.map((v) => v / b.n);
            return {
                rho: (i + 0.5) * STEP,
                n: b.n,
                render,
                photo: theirs,
                renderChroma: chroma(render),
                photoChroma: chroma(theirs),
                brightness: luminance(render) / luminance(theirs),
            };
        })
        .filter(Boolean);
    results.push({ index, photo, depth: g.depth, bins, sky });
}

// The table: per bin the chromaticities r, g, b of both, and the render's brightness in stops over the photograph's.
const f3 = (v) => v.toFixed(3);
for (const { photo, depth, bins, sky } of results) {
    console.log(
        `\n${photo.date.slice(11, 16)} UTC, ${photo.label}, ${photo.seconds} s, umbral magnitude ${depth.toFixed(2)}`,
    );
    console.log(`  the photograph's sky, taken off: linear ${sky.map((v) => v.toExponential(2)).join(" ")}`);
    console.log("  rho    pixels   render r g b          photo r g b           g/r ratio  b/r ratio  stops");
    for (const b of bins) {
        const ratio = (i) => b.renderChroma[i] / b.renderChroma[0] / (b.photoChroma[i] / b.photoChroma[0]);
        console.log(
            `  ${b.rho.toFixed(3)}  ${String(b.n).padStart(7)}  ${b.renderChroma.map(f3).join(" ")}   ${b.photoChroma.map(f3).join(" ")}   ` +
                `${f3(ratio(1)).padStart(9)}  ${f3(ratio(2)).padStart(9)}  ${Math.log2(b.brightness).toFixed(2).padStart(5)}`,
        );
    }
}

if (args.out) {
    mkdirSync(args.out, { recursive: true });
    const lines = ["photo,time,seconds,rho,pixels,render_r,render_g,render_b,photo_r,photo_g,photo_b,brightness_ratio"];
    for (const { photo, bins } of results) {
        for (const b of bins) {
            lines.push(
                [photo.file, photo.date, photo.seconds, b.rho.toFixed(3), b.n, ...b.render, ...b.photo, b.brightness]
                    .map((v) => (typeof v === "number" ? Number(v.toPrecision(6)) : v))
                    .join(","),
            );
        }
    }
    writeFileSync(join(args.out, "eclipse-color.csv"), `${lines.join("\n")}\n`);
    // One panel per photograph: the chromaticities over rho, the render's solid, the photograph's dashed.
    const [W, H, M] = [360, 220, 36];
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * results.length}" height="${H}" font-family="sans-serif" font-size="10">`;
    results.forEach(({ photo, bins }, p) => {
        const x = (rho) => p * W + M + ((rho - 0.4) / 0.8) * (W - 2 * M);
        const y = (v) => H - M - (v / 0.9) * (H - 2 * M);
        svg += `<text x="${p * W + M}" y="14">${photo.date.slice(11, 16)} UTC, ${photo.label}</text>`;
        svg += `<line x1="${x(1)}" y1="${y(0)}" x2="${x(1)}" y2="${y(0.9)}" stroke="#999" stroke-dasharray="2 2"/>`;
        svg += `<text x="${x(1) + 2}" y="${y(0.88)}" fill="#666">umbra's edge</text>`;
        for (const v of [0, 0.3, 0.6, 0.9]) svg += `<text x="${p * W + 4}" y="${y(v) + 3}" fill="#666">${v}</text>`;
        for (const r of [0.4, 0.6, 0.8, 1, 1.2])
            svg += `<text x="${x(r) - 6}" y="${H - M + 14}" fill="#666">${r}</text>`;
        ["#d33", "#3a3", "#36d"].forEach((color, ch) => {
            for (const [key, dash] of [
                ["renderChroma", ""],
                ["photoChroma", ' stroke-dasharray="4 3"'],
            ]) {
                const points = bins.map((b) => `${x(b.rho).toFixed(1)},${y(b[key][ch]).toFixed(1)}`).join(" ");
                svg += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5"${dash}/>`;
            }
        });
    });
    svg += `<text x="4" y="${H - 4}" fill="#666">chromaticity r, g, b over the distance from the shadow's axis in umbral radii; nachtgestirn solid, photograph dashed</text></svg>`;
    writeFileSync(join(args.out, "eclipse-color.svg"), svg);
    console.log(`\nwritten to ${args.out}`);
}
