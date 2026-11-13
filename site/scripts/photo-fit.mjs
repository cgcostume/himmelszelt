// Fits the photographs of nachtgestirn's photo figure onto its Moon: renders each photograph's Moon in the running dev
// server, finds several hundred features of that render in the photograph by normalized cross-correlation, coarse to
// fine, and fits by least squares how the photograph is placed (moved, scaled, turned), how far nachtgestirn's Moon is
// turned off the photograph's (a libration error, which moves a feature by the depth z under it) and a lens' radial
// distortion. Prints them with the diurnal libration, the part a geocentric libration misses; --write puts
// the placement alone, fitted without the other two, into photo-options.ts, as the figure can show no more. The photo
// figure draws its Moon turned by each photograph's listed turn, so the fit measures what is left and adds it back.
// With --figure photo-eclipse it fits the eclipse photographs instead, a tile each in a row, into eclipse-photos.ts.
//
//   pnpm dev                                   (in another terminal)
//   node scripts/photo-fit.mjs [--write] [--only 0,2] [--figure photo-eclipse] [--out dir] [--url http://localhost:4321/nachtgestirn/]
//
// A tool for the chapter while its content is worked on, not part of any package.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
    apparentSiderealTime,
    equatorialToHorizontal,
    fromDate,
    horizontalToDirection,
    julianEphemerisDay,
    moon,
} from "@himmelszelt/sternzeit";
import { chromium } from "@playwright/test";
import { CLIFTON_PARK, ECLIPSE_PHOTOS } from "../src/components/nachtgestirn/eclipse-photos.ts";
import { PHOTOS } from "../src/components/nachtgestirn/photo-options.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OPTIONS = join(here, "../src/components/nachtgestirn/photo-options.ts");
const { values: args } = parseArgs({
    options: {
        write: { type: "boolean", default: false },
        // Try turns this many degrees either side of the listed one first, for a photograph whose turn is only guessed.
        scan: { type: "string" },
        // The figure holding the photographs fitted: the eclipse's are in a figure of their own.
        figure: { type: "string", default: "photo" },
        only: { type: "string" },
        out: { type: "string" },
        url: { type: "string", default: "http://localhost:4321/nachtgestirn/" },
        cache: { type: "string", default: join(tmpdir(), "himmelszelt-photo-fit") },
        size: { type: "string" },
    },
});
const ECLIPSE = args.figure === "photo-eclipse";
const ECLIPSE_FILE = join(here, "../src/components/nachtgestirn/eclipse-photos.ts");
// The eclipse photographs, 1024 pixels square and served from the site, as the others are listed: by shares of them.
const ECLIPSE_PX = 1024;
const LIST = ECLIPSE
    ? ECLIPSE_PHOTOS.map((p) => ({
          ...p,
          src: join(here, "../public/eclipse-2008", p.file),
          local: true,
          width: ECLIPSE_PX,
          height: ECLIPSE_PX,
          center: [p.center[0] / ECLIPSE_PX, p.center[1] / ECLIPSE_PX],
          radius: p.radius / ECLIPSE_PX,
          place: CLIFTON_PARK,
          air: false,
      }))
    : PHOTOS;
// As photo.ts and eclipsephotos.ts have them: the disc's radius as a share of the square, or of a tile.
const DISC = ECLIPSE ? 0.455 : 0.42;
const DEG = Math.PI / 180;
const MOON_RADIUS_KM = 1737.4;
// A tile of the eclipse's at the photographs' own size.
const CSS = Number(args.size ?? (ECLIPSE ? ECLIPSE_PX / 2 : 1200));
const DPR = 2;
const S = CSS * DPR;
// The size of the level of the image pyramid the fit works on.
let N = S;
function downsample(img, f) {
    const n = S / f;
    const out = new Float32Array(n * n);
    for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) out[Math.floor(y / f) * n + Math.floor(x / f)] += img[y * S + x] / (f * f);
    return out;
}

// Images as gray floats through ImageMagick.
function gray(file, width, height) {
    const resize = ["-resize", `${width}x${height}!`];
    const raw = execFileSync("magick", [file, "-colorspace", "Gray", ...resize, "-depth", "8", "gray:-"], {
        maxBuffer: 1 << 30,
    });
    if (raw.length !== width * height) throw new Error(`${file}: ${raw.length} bytes, not ${width}x${height}`);
    return Float32Array.from(raw);
}
function savePng(file, data, width, height) {
    const bytes = Uint8Array.from(data, (v) => Math.max(0, Math.min(255, v)));
    execFileSync("magick", ["-size", `${width}x${height}`, "-depth", "8", "gray:-", file], { input: bytes });
}
function identify(file) {
    return execFileSync("magick", ["identify", "-format", "%w %h", `${file}[0]`])
        .toString()
        .split(" ")
        .map(Number);
}

async function download(photo) {
    if (photo.local) return photo.src;
    mkdirSync(args.cache, { recursive: true });
    const file = join(args.cache, decodeURIComponent(photo.src.split("/").pop()));
    if (!existsSync(file)) {
        const response = await fetch(photo.src, {
            headers: { "User-Agent": "himmelszelt-photo-fit/0.1 (https://github.com/cgcostume/himmelszelt)" },
        });
        if (!response.ok) throw new Error(`${photo.src}: ${response.status}`);
        writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return file;
}

// The photograph's pixel p lands on the square's q = c + R(turn) k (p - p0), as placePhoto's CSS transform puts it.
function placement(photo, width, height) {
    return {
        k: (DISC * S) / (photo.radius * width),
        turn: photo.turn * DEG,
        p0: [photo.center[0] * width, photo.center[1] * height],
    };
}
function warp(img, width, height, { k, turn, p0 }) {
    const out = new Float32Array(N * N).fill(Number.NaN);
    const [c, s] = [Math.cos(-turn) / k, Math.sin(-turn) / k];
    const f = S / N;
    for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
            const [dx, dy] = [(x + 0.5) * f - S / 2, (y + 0.5) * f - S / 2];
            const px = p0[0] + c * dx - s * dy - 0.5;
            const py = p0[1] + s * dx + c * dy - 0.5;
            const [ix, iy] = [Math.floor(px), Math.floor(py)];
            if (ix < 0 || iy < 0 || ix >= width - 1 || iy >= height - 1) continue;
            const [fx, fy] = [px - ix, py - iy];
            const i = iy * width + ix;
            const top = img[i] * (1 - fx) + img[i + 1] * fx;
            const bottom = img[i + width] * (1 - fx) + img[i + width + 1] * fx;
            out[y * N + x] = top * (1 - fy) + bottom * fy;
        }
    }
    return out;
}

function stats(img, x0, y0, h) {
    let [sum, sum2, n] = [0, 0, 0];
    for (let y = y0 - h; y <= y0 + h; y++) {
        for (let x = x0 - h; x <= x0 + h; x++) {
            const v = img[y * N + x];
            if (Number.isNaN(v)) return null;
            sum += v;
            sum2 += v * v;
            n++;
        }
    }
    const mean = sum / n;
    return { mean, std: Math.sqrt(Math.max(sum2 / n - mean * mean, 0)) };
}

// The render's patch of half size h at q found in the photograph within r pixels of q + o, by normalized cross-correlation.
function match(render, photo, qx, qy, h, r, [ox0, oy0] = [0, 0]) {
    const n = (2 * h + 1) ** 2;
    const t = new Float32Array(n);
    const own = stats(render, qx, qy, h);
    let i = 0;
    for (let y = qy - h; y <= qy + h; y++) for (let x = qx - h; x <= qx + h; x++) t[i++] = render[y * N + x] - own.mean;
    const [cx, cy] = [Math.round(ox0), Math.round(oy0)];
    const side = 2 * r + 1;
    const score = new Float32Array(side * side).fill(-1);
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            let [sum, sum2, cross] = [0, 0, 0];
            let j = 0;
            let bad = qy + cy + dy - h < 0 || qy + cy + dy + h >= N;
            for (let y = qy + cy + dy - h; y <= qy + cy + dy + h && !bad; y++) {
                const row = y * N;
                for (let x = qx + cx + dx - h; x <= qx + cx + dx + h; x++) {
                    const v = x < 0 || x >= N ? Number.NaN : photo[row + x];
                    if (Number.isNaN(v)) {
                        bad = true;
                        break;
                    }
                    sum += v;
                    sum2 += v * v;
                    cross += v * t[j++];
                }
            }
            if (bad) continue;
            const variance = sum2 - (sum * sum) / n;
            if (variance <= 1e-6) continue;
            score[(dy + r) * side + dx + r] = cross / Math.sqrt(variance * own.std * own.std * n);
        }
    }
    let best = 0;
    for (let k = 1; k < score.length; k++) if (score[k] > score[best]) best = k;
    const [bx, by] = [best % side, Math.floor(best / side)];
    if (bx === 0 || by === 0 || bx === side - 1 || by === side - 1) return null;
    // Sub-pixel by a parabola through the peak and its neighbors, each way.
    const at = (x, y) => score[y * side + x];
    const vertex = (a, b, c) => (a - 2 * b + c < 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0);
    const ox = vertex(at(bx - 1, by), at(bx, by), at(bx + 1, by));
    const oy = vertex(at(bx, by - 1), at(bx, by), at(bx, by + 1));
    // The runner-up outside the peak's neighborhood, so repeated texture does not count.
    let second = -1;
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++)
            if (Math.max(Math.abs(x - bx), Math.abs(y - by)) > 3) second = Math.max(second, at(x, y));
    }
    return { dx: cx + bx - r + ox, dy: cy + by - r + oy, score: at(bx, by), second };
}

// The features: patches on a grid over the disc where the render has texture, the most textured first.
function features(render, photo, h, r, step, count) {
    const [c, R] = [N / 2, DISC * N];
    const found = [];
    for (let y = h + r + 1; y < N - h - r - 1; y += step) {
        for (let x = h + r + 1; x < N - h - r - 1; x += step) {
            const [u, v] = [(x - c) / R, (c - y) / R];
            if (u * u + v * v > 0.96 ** 2) continue;
            const a = stats(render, x, y, h);
            const b = stats(photo, x, y, h);
            if (!a || !b) continue;
            found.push({ x, y, texture: Math.min(a.std / (a.mean + 8), b.std / (b.mean + 8)) });
        }
    }
    return found.sort((a, b) => b.texture - a.texture).slice(0, count);
}

function solve(A, b) {
    const n = b.length;
    const m = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
        [m[col], m[pivot]] = [m[pivot], m[col]];
        for (let row = 0; row < n; row++) {
            if (row === col) continue;
            const f = m[row][col] / m[col][col];
            for (let k = col; k <= n; k++) m[row][k] -= f * m[col][k];
        }
    }
    return m.map((row, i) => row[n] / row[i]);
}
function inverse(A) {
    return A.map((_, i) =>
        solve(
            A,
            A.map((__, j) => (i === j ? 1 : 0)),
        ),
    );
}

// Least squares in disc radii, y up: the photograph's point v corrected by (1 + a, b) and t, and by kappa v |v|^2 for a
// lens' radial distortion, lands on the render's u shifted by (alpha, beta) z, where nachtgestirn's Moon is turned off
// the photograph's about its up and right axes. `terms` picks which of a, b, tx, ty, alpha, beta, kappa are fitted.
function fit(pairs, terms) {
    const rowsOf = ({ u, v, z }) => {
        const r2 = v[0] ** 2 + v[1] ** 2;
        return [
            [[v[0], -v[1], 1, 0, -z, 0, v[0] * r2], u[0] - v[0]],
            [[v[1], v[0], 0, 1, 0, -z, v[1] * r2], u[1] - v[1]],
        ];
    };
    const used = terms.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
    let use = pairs;
    let result;
    for (let round = 0; round < 4; round++) {
        const n = used.length;
        const AtA = Array.from({ length: n }, () => new Array(n).fill(0));
        const Atb = new Array(n).fill(0);
        const rows = use.flatMap(rowsOf);
        for (const [row, b] of rows) {
            for (let i = 0; i < n; i++) {
                Atb[i] += row[used[i]] * b;
                for (let j = 0; j < n; j++) AtA[i][j] += row[used[i]] * row[used[j]];
            }
        }
        const solved = solve(AtA, Atb);
        const x = new Array(7).fill(0);
        const sigma = new Array(7).fill(0);
        const misfit = ([row, b]) => row.reduce((sum, r, i) => sum + r * x[i], 0) - b;
        used.forEach((k, i) => {
            x[k] = solved[i];
        });
        const sigma2 = rows.reduce((sum, row) => sum + misfit(row) ** 2, 0) / Math.max(rows.length - n, 1);
        const covariance = inverse(AtA);
        used.forEach((k, i) => {
            sigma[k] = Math.sqrt(covariance[i][i] * sigma2);
        });
        const residual = (p) => Math.hypot(...rowsOf(p).map(misfit));
        const errors = pairs.map(residual);
        const rms = Math.sqrt(use.map(residual).reduce((sum, e) => sum + e * e, 0) / use.length);
        result = { x, sigma, rms, count: use.length };
        // Drop what lies beyond three times the median error, then fit again.
        const median = [...errors].sort((a, b) => a - b)[Math.floor(errors.length / 2)];
        use = pairs.filter((_, i) => errors[i] < 3 * Math.max(median, 1e-5));
    }
    return result;
}

// The photograph's placement after the correction: q' = c + M (q - c) + t, M = s R(-phi) on the screen, y down.
function corrected(place, [a, b, tx, ty]) {
    const s = Math.hypot(1 + a, b);
    const phi = Math.atan2(b, 1 + a);
    const R = DISC * S;
    const turn = place.turn - phi;
    const k = place.k * s;
    const t = [tx * R, -ty * R];
    // p0' = p0 - (M R(turn) k)^-1 t = p0 - R(-turn') t / k'
    const [c, sn] = [Math.cos(-turn), Math.sin(-turn)];
    const p0 = [place.p0[0] - (c * t[0] - sn * t[1]) / k, place.p0[1] - (sn * t[0] + c * t[1]) / k];
    return { k, turn, p0 };
}

// How far the face the photographer saw is turned from the one seen from Earth's center, which nachtgestirn draws,
// in the square's frame: the Moon's center seen from Earth's center less from the observer, about the right and up axes.
function diurnalLibration(photo) {
    const time = fromDate(new Date(photo.date));
    const jde = julianEphemerisDay(time);
    const obs = photo.place;
    const topocentric = moon.direction(time, obs);
    const geocentric = horizontalToDirection(
        equatorialToHorizontal(moon.apparentPosition(jde), apparentSiderealTime(time), obs),
    );
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const norm = (v) => v.map((x) => x / Math.hypot(...v));
    // viewFrame, then turned from the zenith to the sky's north as tileFrame turns it with a position angle of 0.
    const up0 = norm(cross(cross(topocentric, [0, 0, 1]), topocentric));
    const right0 = cross(topocentric, up0);
    const turn = photo.air ? 0 : -moon.parallacticAngle(time, obs) * DEG;
    const [c, s] = [Math.cos(turn), Math.sin(turn)];
    const right1 = right0.map((r, i) => r * c + up0[i] * s);
    const up1 = up0.map((u, i) => u * c - right0[i] * s);
    // Then on to the photograph's own up, as photo.ts' viewOf turns the view; the eclipse's tiles stay north up.
    const t = (ECLIPSE ? 0 : photo.turn) * DEG;
    const [ct, st] = [Math.cos(t), Math.sin(t)];
    const right = right1.map((r, i) => ct * r - st * up1[i]);
    const up = up1.map((u, i) => st * right1[i] + ct * u);
    const d = geocentric.map((g, i) => g - topocentric[i]);
    // The point facing the observer moves along d on the Moon, so the features move the other way.
    return { alpha: -dot3(d, right) / DEG, beta: -dot3(d, up) / DEG, total: Math.hypot(...d) / DEG };
}

async function screenshot(page, index) {
    if (ECLIPSE) return settled(page, index, { x: index * CSS, y: 0, width: CSS, height: CSS });
    await page.evaluate(({ i, figure }) => document.querySelector(`#${figure} [data-pick="${i}"]`).click(), {
        i: index,
        figure: args.figure,
    });
    await page.waitForLoadState("networkidle");
    const box = await page.locator(`#${args.figure} canvas`).boundingBox();
    if (Math.abs(box.width - CSS) > 0.5 || box.x !== 0 || box.y !== 0)
        throw new Error(`canvas at ${JSON.stringify(box)}`);
    return settled(page, index, { x: 0, y: 0, width: CSS, height: CSS });
}
async function settled(page, index, clip) {
    let last = null;
    for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(1000);
        const shot = await page.screenshot({ clip });
        if (last?.equals(shot)) return shot;
        last = shot;
    }
    throw new Error(`photo ${index}: the render never settled`);
}

const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"],
});
const columns = ECLIPSE ? ECLIPSE_PHOTOS.length : 1;
const page = await browser.newPage({ viewport: { width: columns * CSS, height: CSS }, deviceScaleFactor: DPR });
await page.goto(args.url);
// The eclipse's figure fixed over the page's top left, the row of photographs' tiles alone, each tile the size asked for.
if (ECLIPSE) {
    await page.addStyleTag({
        content: `#photo-eclipse { position: fixed !important; left: 0; top: 0; margin: 0 !important; width: ${columns * CSS}px !important; max-width: none !important; z-index: 1000; }
        #photo-eclipse > :not(.eclipse-photos), #photo-eclipse .eclipse-photo, #photo-eclipse .tiles-start { display: none !important; }`,
    });
    await page.locator("#photo-eclipse .eclipse-photos > canvas").scrollIntoViewIfNeeded();
    const box = await page.locator("#photo-eclipse .eclipse-photos > canvas").boundingBox();
    if (Math.abs(box.width - columns * CSS) > 0.5 || box.x !== 0 || box.y !== 0)
        throw new Error(`canvas at ${JSON.stringify(box)}`);
} else
    await page.addStyleTag({
        // The square fixed over the page's top left, out of the figure's overflow, at the size the fit asks for.
        content: `#${args.figure} .photo-compare { position: fixed !important; left: 0; top: 0; z-index: 1000; width: ${CSS}px !important; }
        #${args.figure} .photo-disc > img, #${args.figure} .photo-marks, #${args.figure} .tiles-start, #${args.figure} .tiles-ends { visibility: hidden; }`,
    });
if (!ECLIPSE) await page.locator(`#${args.figure}`).scrollIntoViewIfNeeded();
if (!ECLIPSE)
    await page.evaluate((figure) => {
        const slider = document.querySelector(`#${figure} [data-field=split]`);
        slider.value = "0";
        slider.dispatchEvent(new Event("input"));
    }, args.figure);

const only = args.only?.split(",").map(Number);
const fitted = [];
for (const [index, photo] of LIST.entries()) {
    if (only && !only.includes(index)) continue;
    const file = await download(photo);
    const [width, height] = identify(file);
    if (width !== photo.width || height !== photo.height)
        console.warn(`${photo.label}: ${width}x${height}, not as listed`);
    const shotFile = join(args.cache, `render-${index}.png`);
    writeFileSync(shotFile, await screenshot(page, index));
    const [sw, sh] = identify(shotFile);
    if (sw !== S || sh !== S) throw new Error(`render ${sw}x${sh}, not ${S}`);
    const render = gray(shotFile, S, S);
    // The photograph resized to the render's scale, so sampling it does not alias.
    const pw = Math.round(width * placement(photo, width, height).k);
    const ph = Math.round((height * pw) / width);
    const img = gray(file, pw, ph);

    const R = DISC * S;
    // The photo figure draws nachtgestirn's Moon turned already by the photograph's listed turn, so the fit finds only
    // what is left of it, added back when written; the eclipse's tiles are drawn north up and the photograph turned.
    const drawnTurn = ECLIPSE ? 0 : photo.turn;
    let place = { ...placement(photo, pw, ph), turn: (photo.turn - drawnTurn) * DEG };
    const before = place;
    let result;
    let plain;
    let lib = [0, 0, 0];
    let shown;
    let noLens;
    if (args.out) {
        mkdirSync(args.out, { recursive: true });
        savePng(
            join(args.out, `photo-${index}-start.png`),
            warp(img, pw, ph, place).map((v) => (Number.isNaN(v) ? 0 : v)),
            S,
            S,
        );
    }
    if (args.scan) {
        // How many features the coarsest level finds at each turn, in steps of 2°: the best one starts the fit.
        N = S / 4;
        const level = downsample(render, 4);
        let best = { count: -1, turn: place.turn };
        for (let d = -Number(args.scan); d <= Number(args.scan); d += 2) {
            const trial = { ...place, turn: place.turn + d * DEG };
            N = S;
            const full = warp(img, pw, ph, trial);
            N = S / 4;
            const warped = downsample(full, 4);
            let count = 0;
            for (const { x, y } of features(level, warped, 10, 24, 8, 600)) {
                const m = match(level, warped, x, y, 10, 24);
                if (m && m.score >= 0.6 && m.second <= m.score - 0.05) count++;
            }
            if (process.env.DEBUG) console.log(`turn ${(trial.turn / DEG).toFixed(1)}: ${count}`);
            if (count > best.count) best = { count, turn: trial.turn };
        }
        place = { ...place, turn: best.turn };
    }
    // Coarse to fine: a wide search first, then narrow ones around the corrected placement.
    for (const [f, h, r, step] of [
        [4, 10, 24, 8],
        [2, 12, 8, 12],
        [1, 16, 4, 20],
        [1, 16, 3, 20],
    ]) {
        N = S / f;
        const toDisc = (x, y) => [(x - N / 2) / (DISC * N), (N / 2 - y) / (DISC * N)];
        const level = f === 1 ? render : downsample(render, f);
        N = S;
        const full = warp(img, pw, ph, place);
        N = S / f;
        const warped = f === 1 ? full : downsample(full, f);
        const pairs = [];
        const found = features(level, warped, h, r, step, 900);
        const tally = { candidates: found.length, edge: 0, weak: 0, ambiguous: 0 };
        for (const { x, y } of found) {
            const u = toDisc(x, y);
            const z = Math.sqrt(Math.max(1 - u[0] ** 2 - u[1] ** 2, 0));
            const r2 = u[0] ** 2 + u[1] ** 2;
            const shift = [lib[0] * z - lib[2] * u[0] * r2, lib[1] * z - lib[2] * u[1] * r2];
            const m = match(level, warped, x, y, h, r, [shift[0] * DISC * N, -shift[1] * DISC * N]);
            if (!m) tally.edge++;
            else if (m.score < 0.6) tally.weak++;
            else if (m.second > m.score - 0.05) tally.ambiguous++;
            if (!m || m.score < 0.6 || m.second > m.score - 0.05) continue;
            pairs.push({ u, v: toDisc(x + m.dx, y + m.dy), z });
        }
        if (process.env.DEBUG) console.log(f, JSON.stringify(tally), pairs.length);
        if (pairs.length < 12) throw new Error(`${photo.label}: only ${pairs.length} features found`);
        result = fit(pairs, [1, 1, 1, 1, 1, 1, 1]);
        // What the figure can show is a CSS transform: the placement that lies closest without the other terms.
        shown = corrected(place, fit(pairs, [1, 1, 1, 1, 0, 0, 0]).x);
        plain = fit(pairs, [1, 1, 1, 1, 0, 0, 1]);
        noLens = fit(pairs, [1, 1, 1, 1, 1, 1, 0]);
        place = corrected(place, result.x);
        // The libration's shift stays in the next level's photograph, which only the placement corrects.
        lib = [result.x[4], result.x[5], result.x[6]];
        if (args.out) {
            mkdirSync(args.out, { recursive: true });
            N = S;
            savePng(
                join(args.out, `photo-${index}-warped.png`),
                warp(img, pw, ph, place).map((v) => (Number.isNaN(v) ? 0 : v)),
                S,
                S,
            );
            savePng(join(args.out, `photo-${index}-render.png`), render, S, S);
        }
    }
    const kmPerUnit = MOON_RADIUS_KM;
    const pxPerUnit = R;
    const [alpha, beta] = [result.x[4] / DEG, result.x[5] / DEG];
    const [sa, sb] = [result.sigma[4] / DEG, result.sigma[5] / DEG];
    const diurnal = diurnalLibration(photo);
    const center = [shown.p0[0] / pw, shown.p0[1] / ph];
    const radius = (DISC * S) / (shown.k * pw);
    const turn = shown.turn / DEG + drawnTurn;
    console.log(`\n${index} ${photo.label}: ${result.count} features`);
    console.log(
        `  rms ${(result.rms * pxPerUnit).toFixed(2)} px of ${S}, ${(result.rms * kmPerUnit).toFixed(1)} km; ` +
            `without the libration term ${(plain.rms * pxPerUnit).toFixed(2)} px, without the lens' ${(noLens.rms * pxPerUnit).toFixed(2)} px`,
    );
    console.log(
        `  radial distortion ${(result.x[6] * 100).toFixed(2)}% ± ${(result.sigma[6] * 100).toFixed(2)} at the limb`,
    );
    console.log(
        `  libration off by ${alpha.toFixed(3)}° ± ${sa.toFixed(3)} right, ${beta.toFixed(3)}° ± ${sb.toFixed(3)} up`,
    );
    console.log(
        `  the diurnal libration, drawn since moonAt takes the topocentric one, ${diurnal.alpha.toFixed(3)}° right, ${diurnal.beta.toFixed(3)}° up (${diurnal.total.toFixed(3)}°)`,
    );
    console.log(
        `  center [${center.map((v) => v.toFixed(4)).join(", ")}] was [${photo.center.join(", ")}], ` +
            `radius ${radius.toFixed(4)} was ${photo.radius}, turn ${turn.toFixed(2)} was ${photo.turn}`,
    );
    console.log(
        `  moved ${Math.hypot(shown.p0[0] - before.p0[0], shown.p0[1] - before.p0[1]).toFixed(1)} px, ` +
            `scaled ${((shown.k / before.k - 1) * 100).toFixed(2)}%, turned ${(turn - photo.turn).toFixed(2)}°`,
    );
    fitted.push({ photo, center, radius, turn });
}
await browser.close();
// Written at the end, as the dev server reloads the page on every change; read right before, and only each
// photograph's own entry changed, as others may edit the file meanwhile.
if (args.write && ECLIPSE) {
    let source = readFileSync(ECLIPSE_FILE, "utf8");
    for (const { photo, center, radius, turn } of fitted) {
        const block = source.indexOf(`file: "${photo.file}"`);
        if (block < 0) throw new Error(`${photo.label}: no longer in eclipse-photos.ts`);
        const end = source.indexOf("\n    },", block);
        const px = (v) => (v * ECLIPSE_PX).toFixed(2);
        const text = source
            .slice(block, end)
            .replace(/center: \[[^\]]*\]/, `center: [${center.map(px).join(", ")}]`)
            .replace(/radius: [\d.]+/, `radius: ${px(radius)}`)
            .replace(/turn: -?[\d.]+/, `turn: ${turn.toFixed(2)}`);
        source = source.slice(0, block) + text + source.slice(end);
    }
    writeFileSync(ECLIPSE_FILE, source);
} else if (args.write) {
    let source = readFileSync(OPTIONS, "utf8");
    for (const { photo, center, radius, turn } of fitted) {
        const block = source.indexOf(`page: "${photo.page}"`);
        if (block < 0) throw new Error(`${photo.label}: no longer in photo-options.ts`);
        const end = source.indexOf("\n    },", block);
        const text = source
            .slice(block, end)
            .replace(/center: \[[^\]]*\]/, `center: [${center.map((v) => v.toFixed(4)).join(", ")}]`)
            .replace(/radius: [\d.]+/, `radius: ${radius.toFixed(4)}`)
            .replace(/turn: -?[\d.]+/, `turn: ${turn.toFixed(2)}`);
        source = source.slice(0, block) + text + source.slice(end);
    }
    writeFileSync(OPTIONS, source);
}
