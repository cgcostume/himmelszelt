import type { AutoExposureKey, SkyPass, Tint } from "@himmelszelt/dunstkreis";
import {
    autoExposureCompensation,
    autoExposureTint,
    createSkyPass,
    DEFAULT_AUTO_EXPOSURE_KEYS,
} from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { figureInfo } from "../figure-info";
import { onDemand } from "../frame";
import { drawSvg, svgText } from "../sternzeit/figure";
import { gpuMissing } from "../webgpu";
import { skyWhite } from "../white";
import {
    configureCanvas,
    displayOutput,
    gpu,
    gpuDevice,
    onDisplay,
    onTables,
    quality,
    SDR,
    tables,
} from "./atmosphere";
import { cameraBasis } from "./skycamera";

// Grading the day: the evening sky at eight altitudes of the Sun, metered, as the meter reads it and graded by the
// ramp's keys, which are edited in three lanes under the tiles, each tile above its own altitude.

const DEG = Math.PI / 180;
const ALTITUDES = [-12, -6, -3, 0, 3, 10, 30, 60];
// Wide enough that the floor never holds the exposure, so the keys alone decide it, night included.
const RANGE: [number, number] = [-10, 20];
// Each tile looks west, at the setting Sun's azimuth, from the ground, its horizon low in the frame.
const CAMERA = { yaw: -90 * DEG, pitch: 22 * DEG, fov: 68 * DEG };
const SUN_DIAMETER = 0.53;
const OBSERVER_HEIGHT_M = 2;

/** A key as the lanes edit it: the compensation, and the tint as warmth and magenta, each a stop between channels. */
type Key = { sunAltitude: number; compensation: AutoExposureKey["compensation"]; warmth: number; magenta: number };
type Lane = { field: "stops" | "warmth" | "magenta"; range: [number, number]; ends: [string, string]; step: number };
const LANES: Lane[] = [
    { field: "stops", range: [-3, 1.5], ends: ["+1.5", "−3"], step: 0.1 },
    { field: "warmth", range: [-1.5, 1.5], ends: ["warmer", "cooler"], step: 0.05 },
    { field: "magenta", range: [-1.5, 1.5], ends: ["magenta", "green"], step: 0.05 },
];

const neutral = (keys: readonly AutoExposureKey[]): Key[] =>
    keys.map(({ sunAltitude, compensation }) => ({ sunAltitude, compensation, warmth: 0, magenta: 0 }));
const graded = (rows: [number, number | { rising: number; setting: number }, number, number][]): Key[] =>
    rows.map(([sunAltitude, compensation, warmth, magenta]) => ({ sunAltitude, compensation, warmth, magenta }));

const PRESETS: Record<string, () => Key[]> = {
    physical: () => neutral(DEFAULT_AUTO_EXPOSURE_KEYS).map((key) => ({ ...key, compensation: 0 })),
    default: () => neutral(DEFAULT_AUTO_EXPOSURE_KEYS),
    purple: () =>
        graded([
            [-18, -2, -0.3, 0.4],
            [-8, -1.4, -0.4, 0.8],
            [-5, -0.8, -0.2, 1.1],
            [-2, -0.7, 0.2, 0.9],
            [-1, -0.5, 0.4, 0.6],
            [0, { rising: 0, setting: 0.2 }, 0.5, 0.3],
            [6, { rising: 0.2, setting: 0.3 }, 0.2, 0.1],
            [60, 0, 0, 0],
        ]),
    golden: () =>
        graded([
            [-18, -2, 0, 0],
            [-8, -1.5, -0.1, 0],
            [-5, -0.8, 0, 0],
            [-2, -0.6, 0.5, 0.1],
            [-1, -0.3, 0.8, 0.1],
            [0, { rising: 0.2, setting: 0.4 }, 1, 0.1],
            [6, { rising: 0.4, setting: 0.6 }, 0.9, 0],
            [20, 0.2, 0.3, 0],
            [60, 0, 0, 0],
        ]),
};

const root = find("#grading");
const canvas = find<HTMLCanvasElement>(".grading-tiles > canvas", root);
const svgEl = find<SVGSVGElement>(".grading-lanes > svg", root);
const presetInputs = [...root.querySelectorAll<HTMLInputElement>('input[name="grading-preset"]')];

let preset = presetInputs.find((input) => input.checked)?.value ?? "default";
let keys = (PRESETS[preset] ?? PRESETS.default)?.() ?? [];

const round = (x: number, digits = 3) => Number(x.toFixed(digits));
const tintOf = ({ warmth, magenta }: Key): Tint => [
    round(2 ** (warmth / 2)),
    round(2 ** (-magenta / 2)),
    round(2 ** (-warmth / 2)),
];

/** The keys as the library takes them: a tint only where a key has one. */
function libraryKeys(): AutoExposureKey[] {
    return keys.map((key) => ({
        sunAltitude: key.sunAltitude,
        compensation: key.compensation,
        ...(key.warmth || key.magenta ? { tint: tintOf(key) } : {}),
    }));
}

/** What Copy gives: the keys to paste, none where they change nothing. */
function exported(): AutoExposureKey[] {
    const flat = keys.every((key) => key.compensation === 0 && !key.warmth && !key.magenta);
    return flat ? [] : libraryKeys();
}

// The setting Sun, in the west, at an altitude in degrees.
const sunAt = (altitude: number): [number, number, number] => [-Math.cos(altitude * DEG), 0, Math.sin(altitude * DEG)];
const setting = (c: Key["compensation"]) => (typeof c === "number" ? c : c.setting);

/** A lane's value of the ramp as the library applies it, at an altitude: the tint read back as warmth and magenta. */
function laneValue(field: Lane["field"], ramp: AutoExposureKey[], altitude: number) {
    if (field === "stops") return autoExposureCompensation(ramp, sunAt(altitude));
    const [r, g, b] = autoExposureTint(ramp, sunAt(altitude));
    return field === "warmth" ? Math.log2(r / b) : Math.log2((r * b) / (g * g));
}
const keyValue = (field: Lane["field"], key: Key) => (field === "stops" ? setting(key.compensation) : key[field]);

const HANDLE_RADIUS = 5;
// The x of an altitude: the tiles' centers at their altitudes, linear between them, and the half tile at either end
// down to −18° and up to 90°.
const STOPS = [-18, ...ALTITUDES, 90];
// The ends a handle's radius in, so the keys at −18° and 90° show whole.
const stopX = (i: number, width: number) => {
    const x = (Math.min(Math.max(i - 0.5, 0), ALTITUDES.length) / ALTITUDES.length) * width;
    return Math.min(Math.max(x, HANDLE_RADIUS + 2), width - HANDLE_RADIUS - 2);
};
function xOf(altitude: number, width: number) {
    const a = Math.min(Math.max(altitude, STOPS[0] as number), STOPS[STOPS.length - 1] as number);
    const i = Math.max(STOPS.findIndex((s) => s >= a) - 1, 0);
    const [a0, a1] = [STOPS[i] as number, STOPS[i + 1] as number];
    return stopX(i, width) + ((a - a0) / (a1 - a0)) * (stopX(i + 1, width) - stopX(i, width));
}
function altitudeOf(x: number, width: number) {
    for (let i = 0; i < STOPS.length - 1; i++) {
        const [x0, x1] = [stopX(i, width), stopX(i + 1, width)];
        if (x <= x1 || i === STOPS.length - 2) {
            const t = Math.min(Math.max((x - x0) / (x1 - x0 || 1), 0), 1);
            return (STOPS[i] as number) + t * ((STOPS[i + 1] as number) - (STOPS[i] as number));
        }
    }
    return 0;
}

// The lanes as last laid out, for the pointer.
const LANE_HEIGHT = 64;
const LANE_GAP = 14;
type Handle = { key: number; lane: number; x: number; y: number };
let handles: Handle[] = [];
const laneTop = (lane: number) => 6 + lane * (LANE_HEIGHT + LANE_GAP);
const laneY = (lane: Lane, index: number, value: number) => {
    const [lo, hi] = lane.range;
    return laneTop(index) + (1 - (Math.min(Math.max(value, lo), hi) - lo) / (hi - lo)) * LANE_HEIGHT;
};
const f = (n: number) => n.toFixed(1);

function drawLanes() {
    const width = svgEl.clientWidth || 600;
    const height = laneTop(LANES.length) - LANE_GAP + 6;
    svgEl.style.height = `${height}px`;
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const ramp = libraryKeys();
    handles = [];
    let svg = "";
    LANES.forEach((lane, l) => {
        const top = laneTop(l);
        svg += `<rect x="0" y="${top}" width="${width}" height="${LANE_HEIGHT}" class="grading-lane grading-lane-${lane.field}"/>`;
        for (const altitude of ALTITUDES) {
            const x = xOf(altitude, width);
            svg += `<line x1="${f(x)}" y1="${top}" x2="${f(x)}" y2="${top + LANE_HEIGHT}" class="figure-grid"/>`;
        }
        const zero = laneY(lane, l, 0);
        svg += `<line x1="0" y1="${f(zero)}" x2="${width}" y2="${f(zero)}" class="grading-zero"/>`;
        const points = Array.from({ length: 241 }, (_, i) => {
            const x = (i / 240) * width;
            return `${f(x)},${f(laneY(lane, l, laneValue(lane.field, ramp, altitudeOf(x, width))))}`;
        });
        svg += `<path d="M${points.join("L")}" class="grading-curve"/>`;
        keys.forEach((key, k) => {
            const [x, y] = [xOf(key.sunAltitude, width), laneY(lane, l, keyValue(lane.field, key))];
            handles.push({ key: k, lane: l, x, y });
            svg += `<circle cx="${f(x)}" cy="${f(y)}" r="${HANDLE_RADIUS}" class="figure-thumb grading-handle"/>`;
        });
        svg += svgText(6, top + 12, lane.field, "figure-label figure-anchor-start grading-name");
        svg += svgText(width - 6, top + 12, lane.ends[0], "figure-label figure-anchor-end grading-end");
        svg += svgText(width - 6, top + LANE_HEIGHT - 5, lane.ends[1], "figure-label figure-anchor-end grading-end");
    });
    drawSvg(svgEl, svg, 1);
}

// The sky pass the tiles are drawn with, made anew for new tables or another output, and a tile's texture.
let pass: SkyPass | null = null;
let passKey = "";
let passLuts: unknown = null;
let building = "";
let buildingLuts: unknown = null;
let scratch: GPUTexture | null = null;
let configured: GPUTextureFormat | null = null;
const context = gpu.error ? null : canvas.getContext("webgpu");

function inverseViewProjection(aspect: number) {
    const { f: forward, r, u, tx, ty } = cameraBasis(CAMERA, aspect);
    return new Float32Array([...r.map((c) => c * tx), 0, ...u.map((c) => c * ty), 0, 0, 0, 0, 1, ...forward, 0]);
}

function drawTiles() {
    const table = tables();
    if (!context || !table) return;
    const device = gpuDevice();
    const { format, headroom } = displayOutput();
    const key = [format, headroom, quality.groundLight].join();
    if (!pass || passKey !== key || passLuts !== table.luts) {
        const { luts } = table;
        if (building === key && buildingLuts === luts) return;
        building = key;
        buildingLuts = luts;
        const { groundLight } = quality;
        const dither = format === SDR;
        createSkyPass(device, {
            luts,
            format,
            headroom,
            toneMap: "neutral",
            dither,
            autoExposure: true,
            groundLight,
        }).then((next) => {
            if (building !== key || tables()?.luts !== luts) return next.destroy();
            pass?.destroy();
            pass = next;
            passKey = key;
            passLuts = luts;
            building = "";
            requestRender();
        });
        return;
    }
    if (configured !== format) {
        configured = format;
        configureCanvas(context, format, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const tile = Math.max(8, Math.round((canvas.clientWidth * dpr) / ALTITUDES.length));
    const [width, height] = [tile * ALTITUDES.length, tile * 2];
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    if (!scratch || scratch.width !== tile || scratch.format !== format) {
        scratch?.destroy();
        scratch = device.createTexture({
            label: "sternwarte:gradingTile",
            size: [tile, tile],
            format,
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
    }
    const target = context.getCurrentTexture();
    const graded = libraryKeys();
    const view = inverseViewProjection(1);
    // One submission per tile: the uniforms are written on the queue, so each tile's go out before the next ones. The
    // two rows of an altitude share its sky-view table, built once.
    ALTITUDES.forEach((altitude, i) => {
        const sunDirection = sunAt(altitude);
        for (const row of [0, 1]) {
            pass?.update({
                sunDirection,
                sunAngularDiameter: SUN_DIAMETER,
                observerHeightM: OBSERVER_HEIGHT_M,
                inverseViewProjection: view,
                projectionDistance: 0,
                pixelRatio: dpr,
                autoExposureKeys: row === 0 ? [] : graded,
                autoExposureRange: RANGE,
                whiteBalance: skyWhite(sunDirection),
            });
            const encoder = device.createCommandEncoder({ label: "sternwarte:grading" });
            pass?.encode(encoder, scratch as GPUTexture);
            encoder.copyTextureToTexture(
                { texture: scratch as GPUTexture },
                { texture: target, origin: [i * tile, row * tile] },
                [tile, tile],
            );
            device.queue.submit([encoder.finish()]);
        }
    });
}

function render() {
    drawTiles();
    drawLanes();
}
const requestRender = onDemand(render, root);

// A drag moves a key up or down in its lane, and along the altitudes between its neighbors, in every lane alike.
let dragging: { key: number; lane: number } | null = null;

function pointer(event: PointerEvent) {
    const rect = svgEl.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top] as const;
}

function drag(px: number, py: number) {
    if (!dragging) return;
    const lane = LANES[dragging.lane];
    const key = keys[dragging.key];
    if (!lane || !key) return;
    const [lo, hi] = lane.range;
    const t = 1 - (py - laneTop(dragging.lane)) / LANE_HEIGHT;
    const value = Math.round(Math.min(Math.max(lo + t * (hi - lo), lo), hi) / lane.step) * lane.step;
    const v = round(value, 2);
    if (lane.field === "stops") {
        const c = key.compensation;
        key.compensation = typeof c === "number" ? v : { ...c, setting: v };
    } else key[lane.field] = v;
    // Between its neighbors, half a degree clear of them.
    const [before, after] = [keys[dragging.key - 1], keys[dragging.key + 1]];
    const lowest = before ? before.sunAltitude + 0.5 : -18;
    const highest = after ? after.sunAltitude - 0.5 : 90;
    const altitude = Math.round(altitudeOf(px, svgEl.clientWidth || 600) * 2) / 2;
    key.sunAltitude = Math.min(Math.max(altitude, lowest), highest);
    // No preset any more: the keys are the reader's own.
    for (const input of presetInputs) input.checked = false;
    preset = "custom";
    requestRender();
}

svgEl.addEventListener("pointerdown", (event) => {
    const [px, py] = pointer(event);
    const near = handles.map((h) => ({ ...h, d: Math.hypot(h.x - px, h.y - py) })).sort((a, b) => a.d - b.d)[0];
    if (!near || near.d > 3 * HANDLE_RADIUS) return;
    dragging = { key: near.key, lane: near.lane };
    svgEl.setPointerCapture(event.pointerId);
    event.preventDefault();
});
svgEl.addEventListener("pointermove", (event) => {
    if (dragging) drag(...pointer(event));
});
for (const type of ["pointerup", "pointercancel"]) svgEl.addEventListener(type, () => (dragging = null));

for (const input of presetInputs) {
    input.addEventListener("change", () => {
        preset = input.value;
        keys = PRESETS[preset]?.() ?? keys;
        requestRender();
    });
}

figureInfo(root, () => ({ preset, autoExposureRange: RANGE, autoExposureKeys: exported() }));

if (gpu.error) {
    gpuMissing(canvas);
    drawLanes();
} else {
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
