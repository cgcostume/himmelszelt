import type { AtmosphereLUTs, AtmosphereModel, PrecomputedTextureConfig, SkyPass } from "@himmelszelt/dunstkreis";
import {
    clampObserverHeight,
    createSkyPass,
    MULTI_SCATTERING_LOG2_OFFSET,
    precomputeAtmosphere,
    spectrumToRgb,
} from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { onDemand } from "../frame";
import { gpuDevice, onTables, quality, type Sky, tables } from "./atmosphere";
import type { TableName } from "./lutmap";

/**
 * The tables against a reference with many more texels and samples, as the package's research notes measure them: each
 * table's relative error of the luminance, over the texels brighter than a floor, and its effect on the sky-view table
 * with everything else at the reference. Shown as heat maps over the tables figure, on a log scale.
 */

/** The reference: more texels and samples than any setting of the figure gives, short of the sky view's. */
export const REFERENCE: PrecomputedTextureConfig = {
    transmittance: { width: 1024, height: 1024 },
    multiScattering: { width: 256, height: 256 },
    skyView: { width: 1024, height: 1024 },
    integralSamples: { transmittance: 512, multiScattering: 64, skyView: 256 },
};

// The research notes' floors: texels darker than this share of the reference's brightest are not measured.
const FLOOR = { transmittance: 1e-4, multiScattering: 1e-6, sky: 1e-3 };
// The heat maps' scale, log10 of the relative error from 0.1% to 100%: below it lies the half floats' own rounding.
const SCALE = { from: -3, to: 0 };

const NAMES: TableName[] = ["transmittance", "multiScattering", "skyView"];
const root = find("#tables");
const lut = (name: TableName) => find(`[data-lut="${name}"]`, root);
const part = <T extends HTMLElement = HTMLElement>(name: TableName, field: string) =>
    find<T>(`[data-field="${field}"]`, lut(name));
const field = (name: string) => find(`[data-field="${name}"]`, root);

/** A table as a grid to read at any point: the luminance per texel, or for a table stored as log2 its four channels. */
type Grid = { data: Float32Array; width: number; height: number; log2: boolean; split: boolean; weights: number[] };
type Stats = { mean: number; p99: number; max: number };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

// Half floats decoded by table: a megatexel reads back in milliseconds.
const HALF = new Float32Array(65536);
for (let bits = 0; bits < 65536; ++bits) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    HALF[bits] =
        exponent === 0
            ? sign * mantissa * 2 ** -24
            : exponent === 31
              ? Number.NaN
              : sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

async function readBack(texture: GPUTexture): Promise<Float32Array> {
    const device = gpuDevice();
    const { width, height } = texture;
    const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
    const buffer = device.createBuffer({
        size: bytesPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = device.createCommandEncoder({ label: "sternwarte:starve" });
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, { width, height });
    device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const raw = new Uint16Array(buffer.getMappedRange());
    const data = new Float32Array(width * height * 4);
    const stride = bytesPerRow / 2;
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width * 4; ++x) data[y * width * 4 + x] = HALF[raw[y * stride + x] ?? 0] ?? 0;
    }
    buffer.unmap();
    buffer.destroy();
    return data;
}

/** What the luminance weighs each wavelength by: through the model's matrix, of sunlight for a ratio. */
function weights(model: AtmosphereModel, ratio: boolean, scale = 1) {
    const matrix = spectrumToRgb(model);
    const y = [0.2126, 0.7152, 0.0722];
    return [0, 1, 2, 3].map(
        (j) =>
            (matrix.reduce((sum, row, c) => sum + (y[c] ?? 0) * (row[j] ?? 0), 0) *
                (ratio ? (model.solarSpectrum[j] ?? 1) : 1)) /
            scale,
    );
}

async function grid(texture: GPUTexture, w: number[], log2 = false, split = false): Promise<Grid> {
    const stored = await readBack(texture);
    const { width, height } = texture;
    const data = log2 ? stored : new Float32Array(width * height);
    if (!log2) {
        for (let i = 0; i < data.length; ++i) {
            const k = 4 * i;
            data[i] =
                (w[0] ?? 0) * (stored[k] ?? 0) +
                (w[1] ?? 0) * (stored[k + 1] ?? 0) +
                (w[2] ?? 0) * (stored[k + 2] ?? 0) +
                (w[3] ?? 0) * (stored[k + 3] ?? 0);
        }
    }
    return { data, width, height, log2, split, weights: w };
}

/**
 * The luminance at (s, v), each from 0 to 1 over the table's texel centers, read bilinearly as the shaders read it:
 * the sky view's sky and ground apart, the multiple scattering interpolated geometrically, as its log2.
 */
function at(g: Grid, s: number, v: number): number {
    const x = clamp(s, 0, 1) * (g.width - 1);
    let y = clamp(v, 0, 1) * (g.height - 1);
    if (g.split) {
        const half = Math.floor(g.height / 2);
        y = v < 0.5 ? Math.min(y, half - 1) : Math.max(y, half);
    }
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, g.width - 1);
    const y1 = Math.min(y0 + 1, g.height - 1);
    const fx = x - x0;
    const fy = y - y0;
    const d = g.data;
    if (!g.log2) {
        const top = (d[y0 * g.width + x0] ?? 0) * (1 - fx) + (d[y0 * g.width + x1] ?? 0) * fx;
        const bottom = (d[y1 * g.width + x0] ?? 0) * (1 - fx) + (d[y1 * g.width + x1] ?? 0) * fx;
        return top * (1 - fy) + bottom * fy;
    }
    let sum = 0;
    for (let c = 0; c < 4; ++c) {
        const texel = (xx: number, yy: number) => d[(yy * g.width + xx) * 4 + c] ?? 0;
        const top = texel(x0, y0) * (1 - fx) + texel(x1, y0) * fx;
        const bottom = texel(x0, y1) * (1 - fx) + texel(x1, y1) * fx;
        sum += (g.weights[c] ?? 0) * 2 ** (top * (1 - fy) + bottom * fy - MULTI_SCATTERING_LOG2_OFFSET);
    }
    return sum;
}

const unit = (i: number, n: number) => (n > 1 ? i / (n - 1) : 0);

const peaks = new WeakMap<Grid, number>();
/** The reference's brightest texel. */
function peakOf(ref: Grid) {
    const known = peaks.get(ref);
    if (known !== undefined) return known;
    let peak = 0;
    for (let j = 0; j < ref.height; ++j)
        for (let i = 0; i < ref.width; ++i) peak = Math.max(peak, at(ref, unit(i, ref.width), unit(j, ref.height)));
    peaks.set(ref, peak);
    return peak;
}

/** Mean, worst hundredth and worst relative error, at the reference's texel centers above the floor. */
function compare(test: Grid, ref: Grid, floor: number): Stats {
    const peak = peakOf(ref);
    // The worst hundredth from a histogram of 100 bins a decade, from 10⁻⁸ up.
    const bins = new Uint32Array(1100);
    let [sum, max, n] = [0, 0, 0];
    for (let j = 0; j < ref.height; ++j) {
        const v = unit(j, ref.height);
        for (let i = 0; i < ref.width; ++i) {
            const s = unit(i, ref.width);
            const r = at(ref, s, v);
            if (!(r >= floor * peak)) continue;
            const e = Math.abs(at(test, s, v) - r) / r;
            sum += e;
            max = Math.max(max, e);
            n += 1;
            const bin = clamp(Math.floor((Math.log10(Math.max(e, 1e-8)) + 8) * 100), 0, bins.length - 1);
            bins[bin] = (bins[bin] ?? 0) + 1;
        }
    }
    let p99 = max;
    for (let b = 0, seen = 0; b < bins.length; ++b) {
        seen += bins[b] ?? 0;
        if (seen >= 0.99 * n) {
            p99 = Math.min(10 ** ((b + 1) / 100 - 8), max);
            break;
        }
    }
    return { mean: n ? sum / n : 0, p99, max };
}

/** What a panel shows: a grid against its reference, laid out as the panel shows its table. */
type Layout = { width: number; height: number; flip: boolean; mirror: boolean };
type Heat = { test: Grid; ref: Grid; floor: number; peak: number; layout: Layout };

/** Which texel center a fraction of the panel's width or height falls on, as a fraction of the table's span. */
const param = (f: number, n: number) => (n > 1 ? clamp((f * n - 0.5) / (n - 1), 0, 1) : 0);

function pointOf(layout: Layout, fx: number, fy: number) {
    const x = layout.mirror ? (fx < 0.5 ? 1 - 2 * fx : 2 * fx - 1) : fx;
    return { s: param(x, layout.width), v: param(layout.flip ? 1 - fy : fy, layout.height) };
}

function errorAt(heat: Heat, fx: number, fy: number) {
    const { s, v } = pointOf(heat.layout, fx, fy);
    const r = at(heat.ref, s, v);
    return r >= heat.floor * heat.peak ? Math.abs(at(heat.test, s, v) - r) / r : Number.NaN;
}

// Inferno's colors from a tenth of the way up, so the smallest error measured stays apart from black, not measured.
const COLORS = [
    [31, 12, 72],
    [87, 16, 110],
    [188, 55, 84],
    [249, 142, 9],
    [252, 255, 164],
];

function color(e: number, out: Uint8ClampedArray, k: number) {
    const t =
        clamp((Math.log10(Math.max(e, 1e-12)) - SCALE.from) / (SCALE.to - SCALE.from), 0, 1) * (COLORS.length - 1);
    const i = Math.min(Math.floor(t), COLORS.length - 2);
    const f = t - i;
    const [a, b] = [COLORS[i] ?? [0, 0, 0], COLORS[i + 1] ?? [0, 0, 0]];
    for (let c = 0; c < 3; ++c) out[k + c] = (a[c] ?? 0) * (1 - f) + (b[c] ?? 0) * f;
    out[k + 3] = 255;
}

function paintHeat(canvas: HTMLCanvasElement, heat: Heat) {
    const { width, height } = canvas;
    const context = canvas.getContext("2d");
    if (!context || width === 0 || height === 0) return;
    const image = context.createImageData(width, height);
    for (let py = 0; py < height; ++py) {
        for (let px = 0; px < width; ++px) {
            const e = errorAt(heat, (px + 0.5) / width, (py + 0.5) / height);
            if (!Number.isNaN(e)) color(e, image.data, (py * width + px) * 4);
        }
    }
    context.putImageData(image, 0, 0);
}

export const percent = (e: number) => {
    const p = 100 * e;
    if (p < 0.001) return "<0.001%";
    return `${Number(p.toPrecision(p < 1 ? 1 : 2))}%`;
};
const statsLine = (what: string, { mean, p99, max }: Stats) =>
    `${what}: ${percent(mean)} on average, ${percent(p99)} in the worst hundredth, ${percent(max)} at worst`;

// What is computed, each kept until what it depends on changes.
type Reference = { key: string; luts: AtmosphereLUTs; t: Grid; m: Grid; ms: number };
type Current = { luts: AtmosphereLUTs; t: Grid; m: Grid; t2: Stats; m2: Stats };
type Skies = { key: string; ref: Grid; rc: Grid; cur: Grid; t: Grid; m: Grid; stats: Record<string, Stats> };
let reference: Reference | null = null;
let current: Current | null = null;
let skies: Skies | null = null;
let sky: Sky | null = null;

/** Whether the figure shows the heat maps, and which: A each table in its own texels, B its effect on the sky. */
export const starving = { on: false, variant: "A" as "A" | "B" };

const ids = new WeakMap<object, number>();
let lastId = 0;
const idOf = (o: object) => {
    if (!ids.has(o)) ids.set(o, ++lastId);
    return ids.get(o);
};
const passes = new Map<string, { key: string; pass: SkyPass }>();

/** A sky pass of its own for a role, made anew only when its tables or its sky view's settings change. */
async function passFor(role: string, luts: AtmosphereLUTs) {
    const { skyView, integralSamples } = luts.config;
    const key = [
        idOf(luts.transmittance),
        idOf(luts.multiScattering),
        skyView.width,
        skyView.height,
        integralSamples.skyView,
        quality.groundLight,
    ].join();
    const held = passes.get(role);
    if (held?.key === key) return held.pass;
    held?.pass.destroy();
    passes.delete(role);
    const pass = await createSkyPass(gpuDevice(), {
        luts,
        format: "rgba16float",
        toneMap: false,
        groundLight: quality.groundLight,
    });
    passes.set(role, { key, pass });
    return pass;
}

/** The reference's tables with the current one's sky view settings, and one of the current tables put in. */
function mixed(ref: AtmosphereLUTs, cur: AtmosphereLUTs, take: "transmittance" | "multiScattering" | null) {
    const config: PrecomputedTextureConfig = {
        ...ref.config,
        skyView: cur.config.skyView,
        integralSamples: { ...ref.config.integralSamples, skyView: cur.config.integralSamples.skyView },
    };
    return take ? { ...ref, config, [take]: cur[take] } : { ...ref, config };
}

async function skyGrid(role: string, luts: AtmosphereLUTs, at: Sky) {
    const pass = await passFor(role, luts);
    pass.update({ sunDirection: at.sunDirection, observerHeightM: at.observerHeightM });
    return grid(pass.skyViewTexture, weights(luts.model, false, pass.skyViewScale), false, true);
}

let running = false;
let again = false;

/** Brings everything up to date with the tables and the sky, one run at a time, the latest state next. */
async function run() {
    if (running) {
        again = true;
        return;
    }
    running = true;
    try {
        do {
            again = false;
            await step();
        } while (again);
    } catch (error) {
        // Tables replaced while read: the next change runs it again.
        console.warn("starve:", error);
    }
    running = false;
}

async function step() {
    const table = tables();
    if (!starving.on || !table) return;
    const { luts } = table;
    const status = field("starve-status");
    const key = JSON.stringify(luts.model);
    if (reference?.key !== key) {
        status.textContent = "computing the reference…";
        for (const { pass } of passes.values()) pass.destroy();
        passes.clear();
        reference?.luts.destroy();
        reference = null;
        skies = null;
        const started = performance.now();
        const refLuts = await precomputeAtmosphere(gpuDevice(), { model: luts.model, config: REFERENCE });
        await gpuDevice().queue.onSubmittedWorkDone();
        const ms = performance.now() - started;
        reference = {
            key,
            luts: refLuts,
            ms,
            t: await grid(refLuts.transmittance, weights(luts.model, true)),
            m: await grid(refLuts.multiScattering, weights(luts.model, true), true),
        };
    }
    if (!reference) return;
    if (current?.luts !== luts) {
        const t = await grid(luts.transmittance, weights(luts.model, true));
        const m = await grid(luts.multiScattering, weights(luts.model, true), true);
        current = {
            luts,
            t,
            m,
            t2: compare(t, reference.t, FLOOR.transmittance),
            m2: compare(m, reference.m, FLOOR.multiScattering),
        };
    }
    const at = sky;
    const height = clampObserverHeight(at?.observerHeightM ?? 1);
    const inSpace = height / 1000 > luts.model.planet.thicknessKm;
    if (at && !inSpace) {
        const skyKey = [at.sunDirection.join(), height, idOf(luts), idOf(reference.luts), quality.groundLight].join(
            "|",
        );
        if (skies?.key !== skyKey) {
            const ref = reference.luts;
            const s = {
                ref: await skyGrid("ref", ref, at),
                rc: await skyGrid("rc", mixed(ref, luts, null), at),
                cur: await skyGrid("cur", luts, at),
                t: await skyGrid("t", mixed(ref, luts, "transmittance"), at),
                m: await skyGrid("m", mixed(ref, luts, "multiScattering"), at),
            };
            skies = {
                key: skyKey,
                ...s,
                stats: {
                    total: compare(s.cur, s.ref, FLOOR.sky),
                    skyView: compare(s.rc, s.ref, FLOOR.sky),
                    transmittance: compare(s.t, s.rc, FLOOR.sky),
                    multiScattering: compare(s.m, s.rc, FLOOR.sky),
                },
            };
        }
    } else skies = null;
    status.textContent = `reference computed in ${reference.ms.toFixed(0)} ms`;
    requestPaint();
}

const REFERENCE_NOTE: Record<TableName, string> = {
    transmittance: `${REFERENCE.transmittance.width}×${REFERENCE.transmittance.height}, ${REFERENCE.integralSamples.transmittance} samples`,
    multiScattering: `${REFERENCE.multiScattering.width}×${REFERENCE.multiScattering.height}, ${REFERENCE.integralSamples.multiScattering} samples`,
    skyView: `${REFERENCE.skyView.width}×${REFERENCE.skyView.height}, ${REFERENCE.integralSamples.skyView} samples`,
};

/** What each panel's heat map compares, by the variant: the table itself, or the sky with it. */
function heatOf(name: TableName): Heat | null {
    const skyLayout = (g: Grid): Layout => ({ width: g.width, height: g.height, flip: false, mirror: true });
    const heat = (test: Grid, ref: Grid, floor: number, layout: Layout) => ({
        test,
        ref,
        floor,
        peak: peakOf(ref),
        layout,
    });
    if (name === "skyView") return skies ? heat(skies.rc, skies.ref, FLOOR.sky, skyLayout(skies.rc)) : null;
    if (starving.variant === "B") {
        return skies
            ? heat(skies[name === "transmittance" ? "t" : "m"], skies.rc, FLOOR.sky, skyLayout(skies.rc))
            : null;
    }
    if (!current || !reference) return null;
    const own = name === "transmittance" ? current.t : current.m;
    const ref = name === "transmittance" ? reference.t : reference.m;
    const floor = FLOOR[name];
    return heat(own, ref, floor, { width: own.width, height: own.height, flip: true, mirror: false });
}

const heats: Partial<Record<TableName, Heat>> = {};
// The frames' and axes' own shape and labels, while variant B shows the sky in them.
const kept = new Map<HTMLElement, string>();

function swapToSky(name: TableName, sky: boolean) {
    if (name === "skyView") return;
    for (const span of lut(name).querySelectorAll<HTMLElement>("[data-sky]")) {
        if (!kept.has(span)) kept.set(span, span.textContent ?? "");
        span.textContent = sky ? (span.dataset.sky ?? "") : (kept.get(span) ?? "");
    }
    lut(name).classList.toggle("starve-sky", sky);
    const frame = part(name, "heat").parentElement;
    if (!frame) return;
    if (!kept.has(frame)) kept.set(frame, frame.style.aspectRatio);
    const { width, height } = skies?.rc ?? { width: 128, height: 256 };
    frame.style.aspectRatio = sky ? `${2 * width} / ${height}` : (kept.get(frame) ?? "");
}

/** Remembers a frame's own shape when the table figure sets it, so variant B can put it back. */
export function keepShape(name: TableName) {
    const frame = part(name, "heat").parentElement;
    if (frame) kept.set(frame, frame.style.aspectRatio);
    if (starving.on && starving.variant === "B") swapToSky(name, true);
}

function paint() {
    const legend = field("starve-legend");
    legend.hidden = !starving.on;
    for (const name of NAMES) {
        const canvas = part<HTMLCanvasElement>(name, "heat");
        const stats = part(name, "starve");
        canvas.hidden = !starving.on;
        stats.hidden = !starving.on;
        swapToSky(name, starving.on && starving.variant === "B");
        if (!starving.on) continue;
        const heat = heatOf(name);
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        Object.assign(canvas, { width: Math.round(rect.width * dpr), height: Math.round(rect.height * dpr) });
        if (heat) {
            heats[name] = heat;
            paintHeat(canvas, heat);
        } else delete heats[name];
        const lines = [`against ${REFERENCE_NOTE[name]}`];
        if (name !== "skyView" && current)
            lines.push(statsLine("the table", name === "transmittance" ? current.t2 : current.m2));
        if (skies) lines.push(statsLine("the sky", skies.stats[name] as Stats));
        stats.textContent = lines.join("\n");
    }
    const total = field("starve-total");
    total.textContent = skies ? statsLine("the sky with all three as set", skies.stats.total as Stats) : "";
}
const requestPaint = onDemand(paint, root);

/** The error under the pointer, as a line for the readout: null where nothing is measured or nothing is shown. */
export function errorLine(name: TableName, event: MouseEvent) {
    const heat = heats[name];
    if (!starving.on || !heat) return null;
    const rect = part(name, "heat").getBoundingClientRect();
    const e = errorAt(heat, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    const what = name === "skyView" || starving.variant === "A" ? "this table" : "the sky with this table";
    return Number.isNaN(e) ? "too dark to measure" : `${what} off by ${percent(e)}`;
}

/** Follows the tables, the sky, and the switch. */
export function startStarving(button: HTMLElement, variants: Iterable<HTMLElement>) {
    const show = () => {
        button.setAttribute("aria-pressed", String(starving.on));
        for (const v of variants) v.setAttribute("aria-pressed", String(v.dataset.variant === starving.variant));
    };
    show();
    button.addEventListener("click", () => {
        starving.on = !starving.on;
        show();
        requestPaint();
        run();
    });
    for (const v of variants) {
        v.addEventListener("click", () => {
            starving.variant = v.dataset.variant === "B" ? "B" : "A";
            show();
            requestPaint();
        });
    }
    onTables(() => run());
    for (const name of NAMES) new ResizeObserver(() => starving.on && requestPaint()).observe(part(name, "heat"));
}

// The sky the figure follows: rerun once it is on screen, as the table figure shows the sky view.
const requestRun = onDemand(() => run(), root);
export function starveSky(next: Sky) {
    sky = next;
    if (starving.on) requestRun();
}
