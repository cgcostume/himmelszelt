// Fits the photographs of sternenheer's photo figure to the sky, and measures them against what the figure draws.
//
// The fit finds the stars in a photograph, names them from the catalog for the photograph's moment and place, each
// lifted by the air as the stars pass lifts it, and fits by least squares where the camera pointed, how it was turned,
// its focal length and its lens' radial distortion. No guess of the direction is needed: pairs of bright stars as far
// apart in the photograph as in the catalog propose a camera each, and the one that puts the most stars on stars wins.
// --assets resamples each original to an ideal lens, straight and centered, as the figure's camera is, into a WebP
// under public/stars/; --write puts the fit into photo-options.ts. --measure then reads the figure's canvas from the
// running dev server and measures both pictures alike: the faintest stars, the stars' light against the exposure, the
// sky's brightness and color, the Milky Way's, the stars' colors and the halos' sizes.
//
//   node scripts/stars-fit.mjs [--only 0,2] [--assets] [--write] [--out dir] [--cache dir] [--clock minutes]
//                              [--near ra,dec]   (J2000, degrees: a hint where too few bright stars propose)
//   npx astro dev --port 4406                   (in another terminal)
//   node scripts/stars-fit.mjs --measure [--write] [--url http://localhost:4406/sternenheer/]
//                                          [--halo share]
//
// A tool for the chapter while its content is worked on, not part of any package.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { airAt, airTable, DEFAULT_ATMOSPHERE_MODEL, liftedDirection } from "@himmelszelt/dunstkreis";
import { fromDate, julianEphemerisDay, moon, stars } from "@himmelszelt/sternzeit";
import sharp from "sharp";
import { PHOTOS } from "../src/components/sternenheer/photo-options.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OPTIONS = join(here, "../src/components/sternenheer/photo-options.ts");
const ASSETS = join(here, "../public/stars");
const DATA = join(here, "../../packages/sternenheer/data");
const { values: args } = parseArgs({
    options: {
        only: { type: "string" },
        assets: { type: "boolean", default: false },
        write: { type: "boolean", default: false },
        measure: { type: "boolean", default: false },
        out: { type: "string" },
        url: { type: "string", default: "http://localhost:4406/sternenheer/" },
        cache: { type: "string", default: join(tmpdir(), "himmelszelt-stars-fit") },
        wait: { type: "string" },
        clock: { type: "string" },
        near: { type: "string" },
        halo: { type: "string" },
    },
});
const DEG = Math.PI / 180;
// The width the stars are looked for at, and the asset's.
const WORK = 3000;
const ASSET = 1600;

// Images as linear RGB floats through sharp, the ICC profile ignored as ImageMagick did, resized in linear light, as a
// sensor with fewer pixels would add up, clipped to 0 to 1.
// The photographs and screenshots all hold 8 bits.
const LINEAR = Float32Array.from({ length: 256 }, (_, i) => encodeInverse(i / 255));
async function load(file, width, height) {
    const { data, info } = await sharp(file, { ignoreIcc: true, limitInputPixels: false })
        .rotate()
        .removeAlpha()
        .toColourspace("srgb")
        .raw()
        .toBuffer({ resolveWithObject: true });
    let linear = Float32Array.from(data, (v) => LINEAR[v]);
    if (width) linear = await resizeLinear(linear, info.width, info.height, width, height);
    const n = linear.length / 3;
    const [r, g, b] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const clip = (v) => Math.min(Math.max(v, 0), 1);
    for (let i = 0; i < n; i++) {
        r[i] = clip(linear[i * 3]);
        g[i] = clip(linear[i * 3 + 1]);
        b[i] = clip(linear[i * 3 + 2]);
    }
    return { r, g, b };
}
/** Interleaved linear RGB floats resized by Lanczos 3, as ImageMagick's -resize, through 16 bits as it gave them. */
async function resizeLinear(linear, width, height, toWidth, toHeight) {
    const words = Uint16Array.from(linear, (v) => Math.round(65535 * Math.min(Math.max(v, 0), 1)));
    const resized = await sharp(words, { raw: { width, height, channels: 3 }, limitInputPixels: false })
        .resize(toWidth, toHeight, { fit: "fill", kernel: "lanczos3" })
        .toColourspace("rgb16")
        .raw({ depth: "ushort" })
        .toBuffer();
    return Float32Array.from(new Uint16Array(resized.buffer, resized.byteOffset, resized.length / 2), (v) => v / 65535);
}
async function identify(file) {
    const { autoOrient } = await sharp(file).metadata();
    return [autoOrient.width, autoOrient.height];
}
const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
function encodeInverse(c) {
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const luminance = ({ r, g, b }) => r.map((v, i) => 0.2126 * v + 0.7152 * g[i] + 0.0722 * b[i]);
async function savePng(file, { r, g, b }, width, height) {
    const bytes = new Uint8Array(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        bytes[i * 3] = Math.round(255 * encode(Math.min(Math.max(r[i], 0), 1)));
        bytes[i * 3 + 1] = Math.round(255 * encode(Math.min(Math.max(g[i], 0), 1)));
        bytes[i * 3 + 2] = Math.round(255 * encode(Math.min(Math.max(b[i], 0), 1)));
    }
    await sharp(bytes, { raw: { width, height, channels: 3 } })
        .png()
        .toFile(file);
}

async function download(photo) {
    mkdirSync(args.cache, { recursive: true });
    const file = join(args.cache, decodeURIComponent(photo.original.split("/").pop()).replace(/[^\w.-]+/g, "_"));
    if (!existsSync(file)) {
        const response = await fetch(photo.original, { headers: { "User-Agent": "stars-fit/0.1" } });
        if (!response.ok) throw new Error(`${photo.original}: ${response.status}`);
        writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    return file;
}

// The mean over a box of half size h around every pixel, by a summed area table.
function boxMean(img, w, h, half) {
    const sums = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
            row += img[y * w + x];
            sums[(y + 1) * (w + 1) + x + 1] = sums[y * (w + 1) + x + 1] + row;
        }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        const [y0, y1] = [Math.max(y - half, 0), Math.min(y + half + 1, h)];
        for (let x = 0; x < w; x++) {
            const [x0, x1] = [Math.max(x - half, 0), Math.min(x + half + 1, w)];
            const sum =
                sums[y1 * (w + 1) + x1] - sums[y0 * (w + 1) + x1] - sums[y1 * (w + 1) + x0] + sums[y0 * (w + 1) + x0];
            out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
        }
    }
    return out;
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

// The stars of an image, brightest first: peaks of the display-encoded gray over its surroundings' mean, each with its
// centroid and the light it adds, summed in the linear image.
function detect(image, w, h, count = 900) {
    const linear = luminance(image);
    const gray = linear.map(encode);
    const around = boxMean(gray, w, h, 10);
    const high = gray.map((v, i) => v - around[i]);
    const smooth = boxMean(high, w, h, 1);
    const sample = [];
    for (let i = 0; i < high.length; i += 97) sample.push(Math.abs(high[i]));
    const noise = 1.4826 * median(sample) + 1e-4;
    const found = [];
    const [SMALL, LARGE] = [4, 16];
    let previousRim = Number.POSITIVE_INFINITY;
    for (let y = LARGE + 1; y < h - LARGE - 1; y++) {
        for (let x = LARGE + 1; x < w - LARGE - 1; x++) {
            const v = smooth[y * w + x];
            if (v < 4 * noise) continue;
            let peak = true;
            for (let dy = -2; dy <= 2 && peak; dy++)
                for (let dx = -2; dx <= 2; dx++) if (smooth[(y + dy) * w + x + dx] > v) peak = false;
            if (!peak) continue;
            // As wide a window as the star's image: grown until its rim has fallen to the noise. The rim's upper
            // quartile is what the star stands on, in the encoded picture and in the linear: a star stands out all
            // around, while the edge of a tree or a hill against the sky has its bright side on the rim.
            let R = SMALL;
            let [rim, linearRim] = [0, 0];
            for (; R <= LARGE; R += 2) {
                const ring = [];
                for (let k = -R; k < R; k++)
                    ring.push((y - R) * w + x + k, (y + R) * w + x - k, (y + k) * w + x + R, (y - k) * w + x - R);
                const quartile = (values) => values.sort((p, q) => p - q)[Math.floor(values.length * 0.75)];
                rim = quartile(ring.map((i) => gray[i]));
                linearRim = quartile(ring.map((i) => linear[i]));
                if (R >= SMALL + 2 && rim - previousRim > -noise) break;
                previousRim = rim;
            }
            previousRim = Number.POSITIVE_INFINITY;
            // Not a star: a lamp, the Moon or a lit cloud is wider than any star's image.
            if (R > LARGE) continue;
            if (gray[y * w + x] - rim < 5 * noise) continue;
            let [sum, sx, sy, flux] = [0, 0, 0, 0];
            for (let dy = -R; dy <= R; dy++) {
                for (let dx = -R; dx <= R; dx++) {
                    const i = (y + dy) * w + x + dx;
                    const weight = Math.max(gray[i] - rim - noise, 0);
                    sum += weight;
                    sx += weight * dx;
                    sy += weight * dy;
                    flux += linear[i] - linearRim;
                }
            }
            if (sum <= 0) continue;
            found.push({ x: x + 0.5 + sx / sum, y: y + 0.5 + sy / sum, flux, peak: gray[y * w + x], R });
        }
    }
    // Of the peaks within one star's image, the brightest.
    found.sort((a, b) => b.flux - a.flux);
    const kept = [];
    for (const p of found) if (!kept.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < Math.max(q.R, 5))) kept.push(p);
    return kept.slice(0, count);
}

// The catalogs as the package ships them, the bright stars and the Hipparcos stars the bright star catalog lacks.
function catalog() {
    const rows = (name) =>
        readFileSync(join(DATA, name), "utf8")
            .trim()
            .split("\n")
            .slice(1)
            .map((line) => line.split(",").map(Number));
    // The bright star catalog's right ascensions are in hours, the Hipparcos stars' in degrees.
    const bright = rows("brightstars.csv").map(([magnitude, hours, declination, pmRa, pmDe, bv]) => ({
        magnitude,
        rightAscension: hours * 15,
        declination,
        properMotionRightAscension: pmRa,
        properMotionDeclination: pmDe,
        bv,
    }));
    const faint = rows("hipparcos.csv").map(([magnitude, rightAscension, declination, bv]) => ({
        magnitude,
        rightAscension,
        declination,
        properMotionRightAscension: 0,
        properMotionDeclination: 0,
        bv,
    }));
    return [...bright, ...faint];
}

/** Where every star of the catalog shows at the photograph's moment and place, ENU, lifted by the air, and what of its
 *  light the air lets through; stars below the horizon left out. */
function skyOf(photo, all) {
    // --clock tries the camera's clock so many minutes late, for a photograph whose Moon or landmark can tell.
    const time = fromDate(new Date(Date.parse(photo.date) + Number(args.clock ?? 0) * 60_000));
    const jde = julianEphemerisDay(time);
    const rotation = stars.horizontalMatrix(time, photo.place);
    const heightM = Math.max(photo.place.heightM, 1);
    const air = airTable(DEFAULT_ATMOSPHERE_MODEL, heightM);
    const shown = [];
    for (const star of all) {
        const d = liftedDirection(
            air,
            stars.applyMatrix3(rotation, stars.equatorialToVector(stars.properMotion(star, jde))),
        );
        const altitude = Math.asin(d[2]) / DEG;
        if (altitude < 0.5) continue;
        const [r, g, b] = airAt(air, altitude)?.transmittance ?? [0, 0, 0];
        shown.push({ ...star, d, altitude, through: 0.2126 * r + 0.7152 * g + 0.0722 * b });
    }
    shown.sort((a, b) => a.magnitude - b.magnitude);
    return { shown, time, moon: moon.direction(time, photo.place) };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => v.map((c) => c / Math.hypot(...v));
// Matrices as three columns.
const apply = (m, v) => [0, 1, 2].map((i) => m[0][i] * v[0] + m[1][i] * v[1] + m[2][i] * v[2]);
const transposed = (m) => [0, 1, 2].map((i) => [m[0][i], m[1][i], m[2][i]]);
const times = (a, b) => b.map((column) => apply(a, column));
function rotationBy([x, y, z]) {
    const angle = Math.hypot(x, y, z);
    if (angle < 1e-12)
        return [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ];
    const [c, s, k] = [Math.cos(angle), Math.sin(angle), [x / angle, y / angle, z / angle]];
    const column = (e) => {
        const kxe = cross(k, e);
        const along = dot(k, e) * (1 - c);
        return [0, 1, 2].map((i) => e[i] * c + kxe[i] * s + k[i] * along);
    };
    return [column([1, 0, 0]), column([0, 1, 0]), column([0, 0, 1])];
}

/**
 * The camera: `R` holds its right, its up and its back, against where it looks, in ENU as columns, a rotation, `f` the focal length in pixels of the original,
 * `c` the point the lens' axis meets the frame at, `k1` and `k2` the radial distortion, by which a point at the tangent
 * r of its angle from the axis shows at r (1 + k1 r² + k2 r⁴).
 */
function project(camera, d) {
    const [x, y, back] = apply(transposed(camera.R), d);
    if (back >= -0.05) return null;
    const [u, v] = [x / -back, y / -back];
    const r2 = u * u + v * v;
    const bent = 1 + camera.k1 * r2 + camera.k2 * r2 * r2;
    return [camera.c[0] + camera.f * u * bent, camera.c[1] - camera.f * v * bent];
}
// The ray of a pixel, the distortion undone by iteration.
function rayOf(camera, [px, py]) {
    const [bu, bv] = [(px - camera.c[0]) / camera.f, -(py - camera.c[1]) / camera.f];
    let [u, v] = [bu, bv];
    for (let i = 0; i < 12; i++) {
        const r2 = u * u + v * v;
        const bent = 1 + camera.k1 * r2 + camera.k2 * r2 * r2;
        [u, v] = [bu / bent, bv / bent];
    }
    return apply(camera.R, unit([u, v, -1]));
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

// A camera from two stars found in the photograph and the two of the catalog they are taken for: the rotation that
// turns the pixels' rays onto the stars.
function cameraFrom(base, [p1, p2], [d1, d2]) {
    const frame = (a, b) => {
        const z = unit(cross(a, b));
        return [a, cross(z, a), z];
    };
    const flat = {
        ...base,
        R: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ],
    };
    const [r1, r2] = [rayOf(flat, p1), rayOf(flat, p2)];
    return { ...base, R: times(frame(d1, d2), transposed(frame(r1, r2))) };
}

// The stars found in the photograph, each with the catalog's star nearest to where the camera puts one, within `reach`
// pixels; of two taking the same, the nearer.
function pairsOf(camera, found, shown, reach, size) {
    const cell = Math.max(reach, 8);
    const grid = new Map();
    found.forEach((p, i) => {
        const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
        grid.set(key, [...(grid.get(key) ?? []), i]);
    });
    const best = new Map();
    for (const star of shown) {
        const at = project(camera, star.d);
        if (!at || at[0] < 0 || at[1] < 0 || at[0] >= size[0] || at[1] >= size[1]) continue;
        const [gx, gy] = [Math.floor(at[0] / cell), Math.floor(at[1] / cell)];
        for (let y = gy - 1; y <= gy + 1; y++) {
            for (let x = gx - 1; x <= gx + 1; x++) {
                for (const i of grid.get(`${x},${y}`) ?? []) {
                    const distance = Math.hypot(found[i].x - at[0], found[i].y - at[1]);
                    if (distance > reach) continue;
                    const taken = best.get(i);
                    // The stars come brightest first: the brighter one within reach is the likelier, unless another lies far nearer.
                    if (!taken || distance < taken.distance - 0.5 * reach)
                        best.set(i, { star, distance, found: found[i] });
                }
            }
        }
    }
    return [...best.values()];
}

// Least squares over the camera's turn, its focal length and whichever of `free` (k1, k2, cx, cy), by Gauss-Newton
// with a numeric Jacobian; pairs beyond three times the median error are left out and the fit repeated.
function refine(start, pairs, free) {
    const names = ["wx", "wy", "wz", "f", ...free];
    const moved = (camera, x) => {
        const out = { ...camera, c: [...camera.c] };
        names.forEach((name, i) => {
            if (name === "f") out.f = camera.f * (1 + x[i]);
            else if (name === "k1") out.k1 = camera.k1 + x[i];
            else if (name === "k2") out.k2 = camera.k2 + x[i];
            else if (name === "cx") out.c[0] = camera.c[0] + x[i] * camera.f;
            else if (name === "cy") out.c[1] = camera.c[1] + x[i] * camera.f;
        });
        out.R = times(camera.R, rotationBy([x[0], x[1], x[2]]));
        return out;
    };
    const errors = (camera, list) =>
        list.flatMap(({ star, found }) => {
            const at = project(camera, star.d);
            return at ? [at[0] - found.x, at[1] - found.y] : [1e3, 1e3];
        });
    let camera = start;
    let use = pairs;
    for (let round = 0; round < 5; round++) {
        for (let step = 0; step < 8; step++) {
            const e0 = errors(camera, use);
            const n = names.length;
            const J = names.map((_, i) => {
                const x = new Array(n).fill(0);
                x[i] = 1e-6;
                const e = errors(moved(camera, x), use);
                return e.map((v, k) => (v - e0[k]) / 1e-6);
            });
            const AtA = J.map((a) => J.map((b) => a.reduce((sum, v, k) => sum + v * b[k], 0)));
            const Atb = J.map((a) => -a.reduce((sum, v, k) => sum + v * e0[k], 0));
            for (let i = 0; i < n; i++) AtA[i][i] *= 1 + 1e-9;
            camera = moved(camera, solve(AtA, Atb));
        }
        const each = pairs.map(({ star, found }) => {
            const at = project(camera, star.d);
            return at ? Math.hypot(at[0] - found.x, at[1] - found.y) : 1e3;
        });
        const middle = median(each);
        use = pairs.filter((_, i) => each[i] < 3 * Math.max(middle, 0.3));
    }
    const each = use.map(({ star, found }) => Math.hypot(...errors(camera, [{ star, found }])));
    return {
        camera,
        used: use,
        rms: Math.sqrt(each.reduce((sum, e) => sum + e * e, 0) / each.length),
        median: median(each),
    };
}

/** The camera of a photograph from its stars alone. `found` in pixels of the original, brightest first; `axis` where
 *  the lens' axis meets the frame, as shares of it, the middle unless the frame is a part of the sensor's; `near` a
 *  direction the frame holds, for a long lens, whose field has too few bright stars far enough apart to propose. */
function solveCamera(found, shown, size, focal, cropped, axis = [0.5, 0.5], near = null) {
    const base = { f: focal, c: [axis[0] * size[0], axis[1] * size[1]], k1: 0, k2: 0 };
    const flat = {
        ...base,
        R: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ],
    };
    const field = 2 * Math.atan(size[0] / 2 / focal);
    const long = field < 30 * DEG;
    const bright = near
        ? shown.filter((s) => s.magnitude < (long ? 6.5 : 4.5) && Math.acos(Math.min(dot(s.d, near), 1)) < field)
        : shown.filter((s) => s.magnitude < 4);
    // Through a long lens the stars counted go fainter, as it finds fainter stars in a smaller field.
    const deeper = near && long ? 1.5 : 0;
    const top = found.slice(0, 24);
    const check = found.slice(0, 40);
    const reach = 0.006 * size[0];
    // The proposals that put the most bright stars on stars, one per direction.
    let proposals = [];
    for (let i = 0; i < top.length; i++) {
        for (let j = i + 1; j < top.length; j++) {
            const [p1, p2] = [
                [top[i].x, top[i].y],
                [top[j].x, top[j].y],
            ];
            const apart = Math.acos(dot(rayOf(flat, p1), rayOf(flat, p2)));
            if (apart < Math.min(4 * DEG, field / 8)) continue;
            for (const a of bright) {
                for (const b of bright) {
                    if (a === b || Math.abs(Math.acos(Math.min(dot(a.d, b.d), 1)) - apart) > 0.02 * apart + 0.2 * DEG)
                        continue;
                    const camera = cameraFrom(base, [p1, p2], [a.d, b.d]);
                    const score = pairsOf(camera, check, bright, reach, size).length;
                    if (proposals.length === 16 && score <= proposals[15].score) continue;
                    const same = proposals.findIndex(
                        (q) =>
                            dot(q.camera.R[2], camera.R[2]) > Math.cos(2 * DEG) &&
                            dot(q.camera.R[0], camera.R[0]) > Math.cos(4 * DEG),
                    );
                    if (same >= 0 && proposals[same].score >= score) continue;
                    if (same >= 0) proposals.splice(same, 1);
                    proposals = [...proposals, { score, camera }].sort((p, q) => q.score - p.score).slice(0, 16);
                }
            }
        }
    }
    if (!proposals.length) throw new Error("no camera found");
    // From the bright stars inwards: more and fainter stars, a tighter reach, more of the lens' terms; a frame cut
    // from the sensor's has the lens' axis fitted too, once the stars are many.
    const steps = [
        [5, 0.012, []],
        [5.5, 0.008, ["k1"]],
        [6.5, 0.004, ["k1"]],
        [7.5, 0.002, cropped ? ["k1", "k2", "cx", "cy"] : ["k1", "k2"]],
        [8.5, 0.0012, cropped ? ["k1", "k2", "cx", "cy"] : ["k1", "k2"]],
    ];
    let best = null;
    for (const proposal of proposals) {
        let fit = { camera: proposal.camera };
        try {
            for (const [magnitude, share, terms] of steps) {
                const pairs = pairsOf(
                    fit.camera,
                    found,
                    shown.filter((s) => s.magnitude < magnitude + deeper),
                    share * size[0],
                    size,
                );
                if (pairs.length < 12) throw new Error("too few stars");
                fit = refine(fit.camera, pairs, terms);
            }
        } catch {
            continue;
        }
        if (!best || fit.used.length > best.used.length) best = { ...fit, proposed: proposal.score };
    }
    if (!best) throw new Error("no camera found");
    return best;
}

// The camera as the figure takes it: where it looks, as a compass azimuth and an altitude, how far its up is turned
// clockwise from the zenith's, and the angle its frame's width spans.
function pointing(camera, width) {
    const [right, up] = camera.R;
    const forward = camera.R[2].map((c) => -c);
    const azimuth = (((Math.atan2(forward[0], forward[1]) / DEG) % 360) + 360) % 360;
    const altitude = Math.asin(forward[2]) / DEG;
    const level = unit([forward[1], -forward[0], 0]);
    const top = cross(level, forward);
    return {
        azimuth,
        altitude,
        roll: Math.atan2(dot(up, level), dot(up, top)) / DEG,
        fieldOfView: (2 * Math.atan(width / 2 / camera.f)) / DEG,
        right,
    };
}

// The frame of an ideal lens inside the photograph: centered on the lens' axis, as wide and as high as fits whole, so
// a photograph cut from the sensor's frame off its middle loses the far side's surplus. Returns its size in pixels of
// the original at the focal length the fit found.
function idealFrame(camera, [w, h]) {
    const bent = (u, v) => {
        const r2 = (u * u + v * v) / camera.f ** 2;
        return 1 + camera.k1 * r2 + camera.k2 * r2 * r2;
    };
    const inside = (halfWidth, halfHeight) => {
        for (let i = 0; i <= 40; i++) {
            const t = (i / 40) * 2 - 1;
            for (const [u, v] of [
                [t * halfWidth, halfHeight],
                [t * halfWidth, -halfHeight],
                [halfWidth, t * halfHeight],
                [-halfWidth, t * halfHeight],
            ]) {
                const [x, y] = [camera.c[0] + u * bent(u, v), camera.c[1] - v * bent(u, v)];
                if (x < 1 || y < 1 || x > w - 1 || y > h - 1) return false;
            }
        }
        return true;
    };
    // As far as the nearer edge lies along each axis, then both shrunk together until the corners fit too.
    const reach = (edge, along) => {
        let [low, high] = [0, 2 * edge];
        for (let i = 0; i < 40; i++) {
            const middle = (low + high) / 2;
            if (middle * (along ? bent(middle, 0) : bent(0, middle)) < edge - 1) low = middle;
            else high = middle;
        }
        return low;
    };
    const [halfWidth, halfHeight] = [
        reach(Math.min(camera.c[0], w - camera.c[0]), true),
        reach(Math.min(camera.c[1], h - camera.c[1]), false),
    ];
    let [low, high] = [0, 1];
    for (let i = 0; i < 30 && !inside(halfWidth, halfHeight); i++) {
        const middle = (low + high) / 2;
        if (inside(middle * halfWidth, middle * halfHeight)) low = middle;
        else high = middle;
    }
    const scale = inside(halfWidth, halfHeight) ? 1 : low;
    return [2 * scale * halfWidth, 2 * scale * halfHeight];
}

// The photograph through an ideal lens: every pixel of the asset looked up where the real lens put its ray.
async function resample(file, camera, [w, h], frame, target) {
    // Twice the asset's size, halved at the end, from an original shrunk to no more than it needs.
    const [ow, oh] = [2 * ASSET, 2 * Math.round((ASSET * frame[1]) / frame[0])];
    const shrink = Math.max(1, Math.floor(frame[0] / ow));
    const [sw, sh] = [Math.round(w / shrink), Math.round(h / shrink)];
    const source = await load(file, sw, sh);
    const out = { r: new Float32Array(ow * oh), g: new Float32Array(ow * oh), b: new Float32Array(ow * oh) };
    for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
            const [u, v] = [((x + 0.5) / ow - 0.5) * frame[0], (0.5 - (y + 0.5) / oh) * frame[1]];
            const r2 = (u * u + v * v) / camera.f ** 2;
            const bent = 1 + camera.k1 * r2 + camera.k2 * r2 * r2;
            const [px, py] = [((camera.c[0] + u * bent) / w) * sw - 0.5, ((camera.c[1] - v * bent) / h) * sh - 0.5];
            const [ix, iy] = [
                Math.min(Math.max(Math.floor(px), 0), sw - 2),
                Math.min(Math.max(Math.floor(py), 0), sh - 2),
            ];
            const [fx, fy] = [px - ix, py - iy];
            const i = iy * sw + ix;
            for (const c of ["r", "g", "b"]) {
                const s = source[c];
                out[c][y * ow + x] =
                    (s[i] * (1 - fx) + s[i + 1] * fx) * (1 - fy) + (s[i + sw] * (1 - fx) + s[i + sw + 1] * fx) * fy;
            }
        }
    }
    // Halved by Lanczos in linear light from 16 bits, then sRGB in 8 bits. The preset "icon" turns off spatial noise
    // shaping and the loop filter, which would smooth the faint stars away.
    const linear = new Float32Array(ow * oh * 3);
    for (let i = 0; i < ow * oh; i++) for (const [k, c] of ["r", "g", "b"].entries()) linear[i * 3 + k] = out[c][i];
    const half = await resizeLinear(linear, ow, oh, ow / 2, oh / 2);
    const bytes = Uint8Array.from(half, (v) => Math.round(255 * encode(Math.min(Math.max(v, 0), 1))));
    const picture = sharp(bytes, { raw: { width: ow / 2, height: oh / 2, channels: 3 } });
    await picture.webp({ quality: 86, effort: 6, preset: "icon" }).toFile(target);
    // A small one for the picker, its middle square.
    await sharp(target)
        .resize(240, 240, { fit: "cover", position: "centre", kernel: "lanczos3" })
        .webp({ quality: 80, effort: 6 })
        .toFile(target.replace(".webp", "-thumb.webp"));
    return [ow / 2, oh / 2];
}

// A number as the options hold it: to so many decimals, without the zeros a formatter would take off again.
const rounded = (value, decimals) => String(Number(value.toFixed(decimals)));

function replaceIn(source, photo, values) {
    const start = source.indexOf(`label: "${photo.label}"`);
    if (start < 0) throw new Error(`${photo.label} not found in photo-options.ts`);
    const end = source.indexOf("\n    },", start);
    let entry = source.slice(start, end);
    for (const [key, value] of Object.entries(values)) {
        // The key's value on its line, or an object over several, closed at the key's own indent.
        const line = new RegExp(`^( {8}${key}: )(?:\\{\\n[\\s\\S]*?\\n {8}\\}|.*),$`, "m");
        if (!line.test(entry)) throw new Error(`${photo.label}: no ${key} in photo-options.ts`);
        entry = entry.replace(line, `$1${value},`);
    }
    return source.slice(0, start) + entry + source.slice(end);
}

const only = args.only?.split(",").map(Number);
const chosen = PHOTOS.map((photo, index) => ({ photo, index })).filter(({ index }) => !only || only.includes(index));
const all = catalog();
if (args.out) mkdirSync(args.out, { recursive: true });
let source = readFileSync(OPTIONS, "utf8");

if (!args.measure) {
    for (const { photo, index } of chosen) {
        const file = await download(photo);
        const [w, h] = await identify(file);
        const scale = w / WORK;
        const [ww, wh] = [WORK, Math.round(h / scale)];
        const found = detect(await load(file, ww, wh), ww, wh).map((p) => ({ ...p, x: p.x * scale, y: p.y * scale }));
        const sky = skyOf(photo, all);
        // The focal length the camera noted, in pixels: of the whole sensor's width, of which a crop keeps a part.
        const focal = (photo.camera.focalLengthMm / photo.camera.sensorWidthMm) * (photo.camera.widthPx ?? w);
        const cropped = (photo.camera.widthPx ?? w) !== w || photo.cropped === true;
        const started = performance.now();
        const [ra, dec] = args.near?.split(",").map(Number) ?? [];
        const near = args.near
            ? stars.applyMatrix3(
                  stars.horizontalMatrix(sky.time, photo.place),
                  stars.equatorialToVector({ rightAscension: ra, declination: dec }),
              )
            : null;
        const fit = solveCamera(found, sky.shown, [w, h], focal, cropped, photo.camera.axis, near);
        const { camera } = fit;
        const at = pointing(camera, w);
        const perPixel = (Math.atan(1 / camera.f) / DEG) * 60;
        // The same stars through a lens without distortion, for what the distortion is worth.
        const plain = refine({ ...camera, k1: 0, k2: 0 }, fit.used, []);
        const corner = Math.hypot(w / 2, h / 2) / camera.f;
        const frame = idealFrame(camera, [w, h]);
        const ideal = { ...at, fieldOfView: (2 * Math.atan(frame[0] / 2 / camera.f)) / DEG };
        const faintest = Math.max(...fit.used.map((p) => p.star.magnitude));
        console.log(
            `\n${index} ${photo.label}: ${w} x ${h}, ${found.length} stars found, ${fit.used.length} named to magnitude ${faintest.toFixed(1)} (${((performance.now() - started) / 1000).toFixed(1)} s, ${fit.proposed} on the first proposal)`,
        );
        console.log(
            `  looks to azimuth ${at.azimuth.toFixed(2)}°, altitude ${at.altitude.toFixed(2)}°, turned ${at.roll.toFixed(2)}°; ${at.fieldOfView.toFixed(2)}° wide`,
        );
        console.log(
            `  focal length ${((camera.f / (photo.camera.widthPx ?? w)) * photo.camera.sensorWidthMm).toFixed(2)} mm (noted ${photo.camera.focalLengthMm}), ${perPixel.toFixed(3)}' a pixel, axis at ${(camera.c[0] / w).toFixed(4)}, ${(camera.c[1] / h).toFixed(4)}`,
        );
        console.log(
            `  distortion k1 ${camera.k1.toFixed(5)}, k2 ${camera.k2.toFixed(5)}: ${(100 * (camera.k1 * corner ** 2 + camera.k2 * corner ** 4)).toFixed(2)}% in the corners`,
        );
        console.log(
            `  residual ${fit.rms.toFixed(2)} px rms, ${fit.median.toFixed(2)} px median, ${(fit.rms * perPixel).toFixed(2)}' rms; without distortion ${plain.rms.toFixed(2)} px (${(plain.rms * perPixel).toFixed(2)}')`,
        );
        console.log(
            `  as the asset, ${ASSET} wide: ${((fit.rms * ASSET) / frame[0]).toFixed(2)} px rms; its frame ${((100 * frame[0]) / w).toFixed(1)}% of the photograph's width, ${ideal.fieldOfView.toFixed(2)}° wide`,
        );
        // The Moon, where the frame holds it: where the fit puts it against where its glare lies.
        const moonAt = project(camera, liftedDirection(airTable(DEFAULT_ATMOSPHERE_MODEL, 1), sky.moon));
        if (moonAt && moonAt[0] > 0 && moonAt[1] > 0 && moonAt[0] < w && moonAt[1] < h)
            console.log(`  the Moon at ${moonAt.map((v) => v.toFixed(0)).join(", ")} px of the original`);
        if (photo.landmark) {
            const d = rayOf(camera, [photo.landmark.at[0] * w, photo.landmark.at[1] * h]);
            console.log(
                `  ${photo.landmark.name}: azimuth ${((Math.atan2(d[0], d[1]) / DEG + 360) % 360).toFixed(2)}°, altitude ${(Math.asin(d[2]) / DEG).toFixed(2)}° (true: ${photo.landmark.azimuth.toFixed(2)}°, ${photo.landmark.altitude.toFixed(2)}°)`,
            );
        }
        let size = [photo.width, photo.height];
        if (args.assets) {
            mkdirSync(ASSETS, { recursive: true });
            size = await resample(file, camera, [w, h], frame, join(ASSETS, photo.file));
            console.log(`  wrote ${photo.file}, ${size.join(" x ")}`);
        }
        if (args.out) {
            // The photograph with a ring where the fit puts each named star.
            const rings = fit.used.map(({ star }) => {
                const [x, y] = project(camera, star.d).map((v) => v / scale);
                return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="none" stroke="#0f0"/>`;
            });
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ww}" height="${wh}">${rings.join("")}</svg>`;
            await sharp(file, { limitInputPixels: false })
                .rotate()
                .resize(ww, wh, { fit: "fill" })
                .composite([{ input: Buffer.from(svg) }])
                .jpeg()
                .toFile(join(args.out, `fit-${index}.jpg`));
        }
        if (args.write) {
            const focalLength = (camera.f / (photo.camera.widthPx ?? w)) * photo.camera.sensorWidthMm;
            const distortion = 100 * (camera.k1 * corner ** 2 + camera.k2 * corner ** 4);
            const residualPx = (fit.rms * ASSET) / frame[0];
            source = replaceIn(source, photo, {
                width: size[0],
                height: size[1],
                azimuth: rounded(ideal.azimuth, 3),
                altitude: rounded(ideal.altitude, 3),
                // To a hundredth of a degree, a fifteenth of a pixel at the frame's edge.
                roll: rounded(ideal.roll, 2),
                fieldOfView: rounded(ideal.fieldOfView, 3),
                fit: `{ stars: ${fit.used.length}, residual: ${rounded(fit.rms * perPixel, 2)}, residualPx: ${rounded(residualPx, 2)}, distortion: ${rounded(distortion, 2)}, focalLengthMm: ${rounded(focalLength, 2)} }`,
            });
        }
    }
    if (args.write) writeFileSync(OPTIONS, source);
}

// The figure's own picture of a photograph, from its download with the split at the photograph's left edge, so the
// whole frame is sternenheer's: its canvas' pixels, as many as the asset's.
async function drawn(page, index, { switches = [], tone = null } = {}) {
    await page.evaluate(
        ({ index, switches, strength }) => {
            const root = document.querySelector("figure[data-star-photos]");
            root.querySelector(`[data-pick="${index}"]`).click();
            const slider = root.querySelector("[data-field=split]");
            slider.value = "0";
            slider.dispatchEvent(new Event("input"));
            for (const [name, on] of switches) {
                const toggle = root.querySelector(`[data-field=${name}]`);
                if ((toggle.getAttribute("aria-pressed") === "true") !== on) toggle.click();
            }
            // The halos at another share of the light past the knee than the pass' own.
            if (strength) {
                const input = root.querySelector("[data-field=halo]");
                input.value = String(strength);
                input.dispatchEvent(new Event("input"));
            }
        },
        { index, switches, strength: args.halo },
    );
    if (tone)
        await page.evaluate(
            (tone) => document.querySelector(`#stars input[name="stars-tone"][value="${tone}"]`)?.click(),
            tone,
        );
    // The passes are built, the maps and the catalogs fetched, and the frame drawn again as each arrives: wait until
    // a frame has been drawn since and none has followed for two seconds.
    await page.locator("figure[data-star-photos]").scrollIntoViewIfNeeded();
    const frames = () =>
        page.evaluate(() => Number(document.querySelector("figure[data-star-photos]").dataset.frames ?? 0));
    await page.evaluate(() =>
        document.querySelector("figure[data-star-photos] [data-field=exposure]").dispatchEvent(new Event("input")),
    );
    let [count, still] = [await frames(), 0];
    for (let waited = 0; waited < 60 && still < 4; waited++) {
        await page.waitForTimeout(500);
        const now = await frames();
        still = now === count ? still + 1 : 0;
        count = now;
    }
    const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.evaluate(() => document.querySelector("figure[data-star-photos] [data-field=download]").click()),
    ]);
    return download.path();
}

// The ideal camera the figure draws a photograph with, as photos.ts builds it, and where a direction shows in the asset.
function idealCamera(photo) {
    const [azimuth, altitude, roll] = [photo.azimuth * DEG, photo.altitude * DEG, photo.roll * DEG];
    const forward = [
        Math.cos(altitude) * Math.sin(azimuth),
        Math.cos(altitude) * Math.cos(azimuth),
        Math.sin(altitude),
    ];
    const level = [Math.cos(azimuth), -Math.sin(azimuth), 0];
    const top = cross(level, forward);
    const [c, s] = [Math.cos(roll), Math.sin(roll)];
    const tx = Math.tan((photo.fieldOfView * DEG) / 2);
    const [right, up] = [level.map((r, i) => c * r - s * top[i]), top.map((u, i) => c * u + s * level[i])];
    const ty = (tx * photo.height) / photo.width;
    return {
        at(d) {
            const along = dot(d, forward);
            if (along <= 0.05) return null;
            return [
                ((dot(d, right) / along / tx + 1) / 2) * photo.width,
                ((1 - dot(d, up) / along / ty) / 2) * photo.height,
            ];
        },
        ray: (x, y) =>
            unit(
                forward.map(
                    (f, i) =>
                        f + ((x / photo.width) * 2 - 1) * tx * right[i] + (1 - (y / photo.height) * 2) * ty * up[i],
                ),
            ),
        // A pixel's solid angle at `x`, `y`, in steradians: smaller away from the axis by the cube of the cosine.
        solidAngle(x, y) {
            const [u, v] = [((x / photo.width) * 2 - 1) * tx, (1 - (y / photo.height) * 2) * ty];
            return ((2 * tx) / photo.width) ** 2 * (1 + u * u + v * v) ** -1.5;
        },
    };
}

const MAGNITUDE_ZERO_LUX = 2.5775e-6;
const BLOCK = 32;

/**
 * A picture's numbers, the photograph's and the figure's by the same steps. `image` linear, `w` by `h`; `list` the
 * catalog's stars in the frame with where each shows; `blocks` the blocks of sky to read, the same for both pictures.
 */
function measure(image, w, h, camera, list, blocks, photo) {
    const Y = luminance(image);
    const stars = [];
    for (const star of list) {
        // The star's brightest pixel within two of where the fit puts it.
        let [px, py, peak] = [0, 0, -1];
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                const [x, y] = [Math.floor(star.x) + dx, Math.floor(star.y) + dy];
                if (Y[y * w + x] > peak) [px, py, peak] = [x, y, Y[y * w + x]];
            }
        }
        // What it stands on: the middle of a ring from 7 to 10 pixels out, and the ring's own scatter as displayed.
        const ring = [];
        for (let dy = -10; dy <= 10; dy++) {
            for (let dx = -10; dx <= 10; dx++) {
                const d = Math.hypot(dx, dy);
                if (d >= 7 && d <= 10) ring.push((py + dy) * w + px + dx);
            }
        }
        const under = {
            r: median(ring.map((i) => image.r[i])),
            g: median(ring.map((i) => image.g[i])),
            b: median(ring.map((i) => image.b[i])),
        };
        const underY = 0.2126 * under.r + 0.7152 * under.g + 0.0722 * under.b;
        const shown = ring.map((i) => encode(Y[i]));
        const middle = median(shown);
        const noise = 1.4826 * median(shown.map((v) => Math.abs(v - middle)));
        const flux = { r: 0, g: 0, b: 0, y: 0 };
        let [moment, weight] = [0, 0];
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                if (Math.hypot(dx, dy) > 3.6) continue;
                const i = (py + dy) * w + px + dx;
                flux.r += image.r[i] - under.r;
                flux.g += image.g[i] - under.g;
                flux.b += image.b[i] - under.b;
                flux.y += Y[i] - underY;
                const light = Math.max(Y[i] - underY, 0);
                moment += light * (dx * dx + dy * dy);
                weight += light;
            }
        }
        const found = encode(peak) - middle > Math.max(4 * noise, 2.5 / 255);
        stars.push({
            ...star,
            found,
            peak: encode(peak),
            flux,
            noise,
            sigma: Math.sqrt(moment / Math.max(2 * weight, 1e-9)),
        });
    }
    // The magnitude at which half of the stars are still found: from where all are, half a magnitude at a time.
    const share = (m) => {
        const bin = stars.filter((s) => Math.abs(s.magnitude - m) < 0.25);
        return bin.length >= 6 ? bin.filter((s) => s.found).length / bin.length : null;
    };
    let limitingMagnitude = 0;
    const shares = [];
    for (let m = 3; m <= 12; m += 0.5) {
        const here = share(m);
        if (here === null) continue;
        shares.push(`${m}: ${(100 * here).toFixed(0)}%`);
        const before = share(m - 0.5);
        if (here >= 0.5) limitingMagnitude = m;
        else if (before !== null && before >= 0.5 && limitingMagnitude === m - 0.5)
            limitingMagnitude = m - 0.5 + (0.5 * (before - 0.5)) / (before - here);
    }
    // The stars' light against their magnitudes below the air: found, not burnt out, clear of the noise, near the axis.
    const good = stars.filter(
        (s) =>
            s.found &&
            s.peak < 0.8 &&
            s.flux.y > 0 &&
            s.flux.b > 0 &&
            s.flux.r > 0 &&
            s.central &&
            encode(s.flux.y / 20) > 3 * s.noise,
    );
    const zeroPoint = median(good.map((s) => s.magnitude - 2.5 * Math.log10(s.through) + 2.5 * Math.log10(s.flux.y)));
    // The sky: the blocks' own middles, so the stars in them do not count, scaled to cd/m² by the stars' light.
    const read = (list) => {
        const sum = { r: 0, g: 0, b: 0, luminance: 0 };
        for (const { x, y } of list) {
            const at = [];
            for (let dy = 0; dy < BLOCK; dy++) for (let dx = 0; dx < BLOCK; dx++) at.push((y + dy) * w + x + dx);
            const block = {
                r: median(at.map((i) => image.r[i])),
                g: median(at.map((i) => image.g[i])),
                b: median(at.map((i) => image.b[i])),
            };
            const value = 0.2126 * block.r + 0.7152 * block.g + 0.0722 * block.b;
            sum.r += block.r / list.length;
            sum.g += block.g / list.length;
            sum.b += block.b / list.length;
            sum.luminance +=
                (value * MAGNITUDE_ZERO_LUX) /
                10 ** (0.4 * zeroPoint) /
                camera.solidAngle(x + BLOCK / 2, y + BLOCK / 2) /
                list.length;
        }
        return sum;
    };
    const [dark, bright, low] = [read(blocks.dark), read(blocks.bright), read(blocks.low)];
    // The stars' colors: how far the blue falls behind the red per magnitude of B-V, by least squares.
    const colored = good.filter((s) => Number.isFinite(s.bv) && s.magnitude < 8);
    const [bvs, colors] = [colored.map((s) => s.bv), colored.map((s) => -2.5 * Math.log10(s.flux.b / s.flux.r))];
    const mean = (values) => values.reduce((sum, v) => sum + v, 0) / Math.max(values.length, 1);
    const [bvMean, colorMean] = [mean(bvs), mean(colors)];
    const starColor =
        colored.length < 10
            ? Number.NaN
            : bvs.reduce((sum, v, i) => sum + (v - bvMean) * (colors[i] - colorMean), 0) /
              Math.max(
                  bvs.reduce((sum, v) => sum + (v - bvMean) ** 2, 0),
                  1e-9,
              );
    const sharpness = median(good.filter((s) => s.peak > 0.25).map((s) => s.sigma));
    // The brightest star's halo: the light around it, ring by ring, down to a twentieth of display white over the sky.
    const brightest = stars
        .filter((s) => s.x > 60 && s.y > 60 && s.x < w - 60 && s.y < h - 60)
        .sort((a, b) => a.magnitude - b.magnitude)[0];
    let halo = 0;
    if (brightest) {
        const rings = Array.from({ length: 60 }, () => []);
        for (let dy = -59; dy <= 59; dy++) {
            for (let dx = -59; dx <= 59; dx++) {
                const d = Math.floor(Math.hypot(dx, dy));
                if (d < 60) rings[d].push(Y[(Math.round(brightest.y) + dy) * w + Math.round(brightest.x) + dx]);
            }
        }
        const profile = rings.map(median);
        const far = median(profile.slice(50));
        const edge = profile.findIndex((v) => v - far < 0.05);
        halo = (edge < 0 ? 60 : edge) * ((photo.fieldOfView * 60) / photo.width);
    }
    return {
        numbers: {
            limitingMagnitude,
            // A sky darker than a display's first step is none: black, as a photograph's processing may clip it.
            sky: 255 * encode(0.2126 * dark.r + 0.7152 * dark.g + 0.0722 * dark.b) < 1 ? 0 : dark.luminance,
            skyColor: [dark.r / dark.g, dark.b / dark.g],
            milkyWay: photo.band === false ? 0 : Math.max(bright.luminance - dark.luminance, 0),
            horizon: blocks.low.length >= 4 ? low.luminance : 0,
            horizonColor: blocks.low.length >= 4 ? [low.r / low.g, low.b / low.g] : [1, 1],
            starColor,
            sharpness,
            halo,
        },
        zeroPoint,
        shares,
        used: good.length,
        colored: colored.length,
        brightest,
        dark,
        bright,
    };
}

if (args.measure) {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({
        channel: "chromium",
        headless: true,
        args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan"],
    });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1200 }, acceptDownloads: true });
    await page.goto(args.url);
    await page.locator("figure[data-star-photos]").scrollIntoViewIfNeeded();
    for (const { photo, index } of chosen) {
        const [w, h] = [photo.width, photo.height];
        const camera = idealCamera(photo);
        const sky = skyOf(photo, all);
        // The catalog's stars in the frame, clear of its edge, each without a neighbor as bright within seven pixels.
        const inFrame = sky.shown
            .map((star) => ({ ...star, at: camera.at(star.d) }))
            .filter(({ at }) => at && at[0] > 14 && at[1] > 14 && at[0] < w - 14 && at[1] < h - 14)
            .map((star) => ({
                ...star,
                x: star.at[0],
                y: star.at[1],
                central: Math.hypot(star.at[0] - w / 2, star.at[1] - h / 2) < 0.7 * Math.hypot(w / 2, h / 2),
            }));
        const cells = new Map();
        for (const star of inFrame) {
            const key = `${Math.floor(star.x / 8)},${Math.floor(star.y / 8)}`;
            cells.set(key, [...(cells.get(key) ?? []), star]);
        }
        const alone = inFrame.filter((star) => {
            for (let dy = -1; dy <= 1; dy++)
                for (let dx = -1; dx <= 1; dx++)
                    for (const other of cells.get(`${Math.floor(star.x / 8) + dx},${Math.floor(star.y / 8) + dy}`) ??
                        [])
                        if (
                            other !== star &&
                            other.magnitude < star.magnitude + 1.5 &&
                            Math.hypot(other.x - star.x, other.y - star.y) < 7
                        )
                            return false;
            return true;
        });
        const asset = await load(join(ASSETS, photo.file));
        // The light as it is exposed, cut off at white, for the numbers; the page's own tone curve for what a reader sees.
        const linear = await load(await drawn(page, index, { tone: "clip" }));
        const toned = await load(await drawn(page, index, { tone: "neutral" }));
        const deep = await load(await drawn(page, index, { tone: "clip", switches: [["deep", true]] }));
        await drawn(page, index, { switches: [["deep", false]] });
        // The blocks of sky both pictures are read in: over the ground and its haze, clear of the frame's corners,
        // not a tree or a hill in the photograph; the darkest tenth of them as drawn, and the brightest fiftieth.
        const [assetY, linearY] = [luminance(asset), luminance(linear)];
        const candidates = [];
        const lows = [];
        for (let y = BLOCK; y + 2 * BLOCK <= h; y += BLOCK) {
            for (let x = BLOCK; x + 2 * BLOCK <= w; x += BLOCK) {
                const [cx, cy] = [x + BLOCK / 2, y + BLOCK / 2];
                const altitude = Math.asin(camera.ray(cx, cy)[2]) / DEG;
                const at = [];
                for (let dy = 0; dy < BLOCK; dy++) for (let dx = 0; dx < BLOCK; dx++) at.push((y + dy) * w + x + dx);
                const block = {
                    x,
                    y,
                    photo: median(at.map((i) => assetY[i])),
                    drawn: median(at.map((i) => linearY[i])),
                };
                if (altitude > 3 && altitude < 8) lows.push(block);
                if (altitude > 12 && Math.hypot(cx - w / 2, cy - h / 2) < 0.7 * Math.hypot(w / 2, h / 2))
                    candidates.push(block);
            }
        }
        const typical = median(candidates.map((c) => c.photo));
        const open = candidates.filter((c) => c.photo > 0.5 * typical).sort((a, b) => a.drawn - b.drawn);
        // The sky low over the horizon, from 3° to 8° up, where no tree or hill stands in it.
        const low = lows.filter((c) => c.photo > 0.5 * typical);
        const blocks = {
            dark: open.slice(0, Math.ceil(open.length / 10)),
            bright: open.slice(-Math.ceil(open.length / 50)),
            low,
        };
        const results = {
            photo: measure(asset, w, h, camera, alone, blocks, photo),
            drawn: measure(linear, w, h, camera, alone, blocks, photo),
            toned: measure(toned, w, h, camera, alone, blocks, photo),
            deep: measure(deep, w, h, camera, alone, blocks, photo),
        };
        // How much brighter the photograph shows its stars than the figure drew them, on top of what it drew them by.
        const stops = photo.stops + (results.photo.zeroPoint - results.drawn.zeroPoint) / (2.5 * Math.log10(2));
        console.log(
            `\n${index} ${photo.label}: ${alone.length} stars alone in the frame, ${open.length} blocks of sky, ${blocks.dark.length} dark, ${blocks.bright.length} bright`,
        );
        for (const [name, m] of Object.entries(results)) {
            const n = m.numbers;
            console.log(
                `  ${name}: faintest ${n.limitingMagnitude.toFixed(2)}, zero point ${m.zeroPoint.toFixed(2)} from ${m.used} stars, sky ${n.sky.toExponential(2)} cd/m², red ${n.skyColor[0].toFixed(2)} blue ${n.skyColor[1].toFixed(2)}, Milky Way ${n.milkyWay.toExponential(2)} cd/m² over it (${(n.milkyWay / n.sky + 1).toFixed(1)} times), colors ${n.starColor.toFixed(2)} from ${m.colored}, image ${n.sharpness.toFixed(2)} px, halo ${n.halo.toFixed(1)}' around magnitude ${m.brightest?.magnitude}, low sky ${n.horizon.toExponential(2)} cd/m² (red ${n.horizonColor[0].toFixed(2)} blue ${n.horizonColor[1].toFixed(2)}, ${blocks.low.length} blocks)`,
            );
            console.log(`    found: ${m.shares.join(", ")}`);
            console.log(
                `    sky as shown: dark ${(255 * encode(0.2126 * m.dark.r + 0.7152 * m.dark.g + 0.0722 * m.dark.b)).toFixed(1)}, bright ${(255 * encode(0.2126 * m.bright.r + 0.7152 * m.bright.g + 0.0722 * m.bright.b)).toFixed(1)} of 255`,
            );
        }
        console.log(
            `  the photograph's stars are ${stops.toFixed(2)} stops brighter than its exposure draws them (${photo.stops} so far)`,
        );
        if (args.out) {
            // Both pictures in one: the photograph in red, the figure's in green, so a star on its star shows yellow.
            await savePng(
                join(args.out, `both-${index}.png`),
                { r: assetY.map((v) => 3 * v), g: linearY.map((v) => 3 * v), b: new Float32Array(w * h) },
                w,
                h,
            );
            await savePng(join(args.out, `drawn-${index}.png`), linear, w, h);
            await savePng(join(args.out, `toned-${index}.png`), toned, w, h);
            await savePng(join(args.out, `deep-${index}.png`), deep, w, h);
        }
        if (args.write) {
            const pair = ([a, b]) => `[${rounded(a, 2)}, ${rounded(b, 2)}]`;
            const lines = (n) => [
                `limitingMagnitude: ${rounded(n.limitingMagnitude, 1)}`,
                `sky: ${Number(n.sky.toPrecision(3))}`,
                `skyColor: ${pair(n.skyColor)}`,
                `milkyWay: ${Number(n.milkyWay.toPrecision(3))}`,
                `horizon: ${Number(n.horizon.toPrecision(3))}`,
                `horizonColor: ${pair(n.horizonColor)}`,
                `starColor: ${rounded(n.starColor, 2)}`,
                `sharpness: ${rounded(n.sharpness, 2)}`,
                `halo: ${rounded(n.halo, 1)}`,
            ];
            const object = (n) =>
                `{\n${lines(n)
                    .map((line) => `                ${line},\n`)
                    .join("")}            }`;
            source = replaceIn(source, photo, {
                stops: rounded(stops, 1),
                measured: `{\n            photo: ${object(results.photo.numbers)},\n            drawn: ${object(results.drawn.numbers)},\n        }`,
            });
        }
    }
    await browser.close();
    if (args.write) writeFileSync(OPTIONS, source);
}
