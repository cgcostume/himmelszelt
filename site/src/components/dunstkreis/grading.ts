import type { AirTable, AtmosphereLUTs, AutoExposureKey, SkyPass, Tint } from "@himmelszelt/dunstkreis";
import {
    airTable,
    autoExposureCompensation,
    autoExposureTint,
    createAirTexture,
    createSkyPass,
} from "@himmelszelt/dunstkreis";
import { NO_WHITE_BALANCE, type WhiteBalance } from "@himmelszelt/helldunkel";
import { horizonZ } from "@himmelszelt/nachtgestirn";
import type { MilkyWay, StarCatalog, StarsPass } from "@himmelszelt/sternenheer";
import { createStarsPass, loadCatalog } from "@himmelszelt/sternenheer";
import { fromDate, julianEphemerisDay, stars } from "@himmelszelt/sternzeit";
import { showCode } from "../code";
import { find } from "../dom";
import { figureInfo } from "../figure-info";
import { onDemand } from "../frame";
import { milkyWayOnce } from "../sternenheer/renderer";
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
import { PHOTO_RAMP } from "./ramps";
import { cameraBasis } from "./skycamera";

// Grading the day: the evening sky at nine altitudes of the Sun with its stars, metered, as the meter reads it and
// graded by the ramp's keys, which are edited in three lanes under the tiles, each tile above its own altitude.

const DEG = Math.PI / 180;
const ALTITUDES = [-30, -12, -6, -3, 0, 3, 10, 30, 60];
// The floor holds the night, which the model's air alone would meter as bright as day: EV100 −10, a moonless night as
// sternenheer's figures expose it. Above it the keys alone decide, down to the end of nautical twilight.
const RANGE: [number, number] = [-10, 20];
// Each tile looks west, at the setting Sun's azimuth, from the ground, its horizon low in the frame.
const CAMERA = { yaw: -90 * DEG, pitch: 22 * DEG, fov: 68 * DEG };
const SUN_DIAMETER = 0.53;
const OBSERVER_HEIGHT_M = 2;
// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
// The stars of a March night at 50° north, Orion setting in the west: the Sun is placed by the tiles alone.
const NIGHT = fromDate(new Date("2026-03-15T22:20:00Z"));
const SKY_ROTATION = stars.horizontalMatrix(NIGHT, { latitude: 50, longitude: 0 });
const YEARS = (julianEphemerisDay(NIGHT) - 2451545) / 365.25;

/** A key as the lanes edit it: the compensation, and the tint as warmth and magenta, each a stop between channels. */
type Key = { sunAltitude: number; compensation: AutoExposureKey["compensation"]; warmth: number; magenta: number };
type Lane = { field: "stops" | "warmth" | "magenta"; range: [number, number]; ends: [string, string]; step: number };
const LANES: Lane[] = [
    { field: "stops", range: [-4, 1.5], ends: ["+1.5", "−4"], step: 0.1 },
    { field: "warmth", range: [-1.5, 1.5], ends: ["warmer", "cooler"], step: 0.05 },
    { field: "magenta", range: [-1.5, 1.5], ends: ["magenta", "green"], step: 0.05 },
];

const neutral = (keys: readonly AutoExposureKey[]): Key[] =>
    keys.map(({ sunAltitude, compensation }) => ({ sunAltitude, compensation, warmth: 0, magenta: 0 }));
const graded = (rows: [number, number | { rising: number; setting: number }, number, number][]): Key[] =>
    rows.map(([sunAltitude, compensation, warmth, magenta]) => ({ sunAltitude, compensation, warmth, magenta }));

const PRESETS: Record<string, () => Key[]> = {
    physical: () => neutral(PHOTO_RAMP).map((key) => ({ ...key, compensation: 0 })),
    photo: () => neutral(PHOTO_RAMP),
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
const codeEl = find('[data-field="code"]', root);
const summaryEl = find('[data-field="summary"]', root);
const presetInputs = [...root.querySelectorAll<HTMLInputElement>('input[name="grading-preset"]')];

let preset = presetInputs.find((input) => input.checked)?.value ?? "photo";
let keys = (PRESETS[preset] ?? PRESETS.photo)?.() ?? [];

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

/** The keys as code to paste, a key to a line where it fits 80 columns, and how a sky pass takes them. */
function snippet(ramp: AutoExposureKey[]): string {
    const n = (x: number) => String(round(x, 1));
    const fields = ({ sunAltitude, compensation: c, tint }: AutoExposureKey) => [
        `sunAltitude: ${sunAltitude}`,
        `compensation: ${typeof c === "number" ? n(c) : `{ rising: ${n(c.rising)}, setting: ${n(c.setting)} }`}`,
        ...(tint && !("rising" in tint) ? [`tint: [${tint.join(", ")}]`] : []),
    ];
    const lines = ramp.map((key) => {
        const one = `    { ${fields(key).join(", ")} },`;
        return one.length <= 80 ? one : ["    {", ...fields(key).map((f) => `        ${f},`), "    },"].join("\n");
    });
    return [
        'import { type AutoExposureKey, createSkyPass } from "@himmelszelt/dunstkreis";',
        "",
        ...(ramp.length
            ? ["const keys: AutoExposureKey[] = [", ...lines, "];"]
            : ["// None: the meter's reading as it is.", "const keys: AutoExposureKey[] = [];"]),
        "",
        "const sky = await createSkyPass(device, { luts, format, autoExposure: true });",
        "sky.update({",
        "    sunDirection,",
        "    autoExposureKeys: keys,",
        "    // The figure's range, whose floor holds the night.",
        `    autoExposureRange: [${RANGE.join(", ")}],`,
        "});",
    ].join("\n");
}

let shownCode = "";
function updateCode() {
    const ramp = exported();
    const code = snippet(ramp);
    if (code === shownCode) return;
    shownCode = code;
    const tinted = ramp.filter((key) => key.tint).length;
    summaryEl.textContent = ramp.length ? `${ramp.length} keys${tinted ? `, ${tinted} tinted` : ""}` : "no keys";
    if (codeEl.closest("details")?.open) showCode(codeEl, code);
}
codeEl.closest("details")?.addEventListener("toggle", () => {
    if (codeEl.closest("details")?.open) showCode(codeEl, shownCode);
});

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
// down to −45° and up to 90°.
const STOPS = [-45, ...ALTITUDES, 90];
// The ends a handle's radius in, so the keys at the ends show whole.
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

// The sky pass writes each tile's sky in cd/m², and the stars pass composes the stars over it, exposes and tone maps
// it. The sky pass is made anew for new tables, the stars pass for another output or once the catalog and the Milky
// Way are in.
let pass: SkyPass | null = null;
let passLuts: AtmosphereLUTs | null = null;
let passKey = "";
let building = "";
let buildingLuts: AtmosphereLUTs | null = null;
let starsPass: StarsPass | null = null;
let starsKey = "";
let starsBuilding = "";
let catalog: StarCatalog | null = null;
let milkyWay: MilkyWay | null = null;
let milkyWayAsked = false;
let skyTile: GPUTexture | null = null;
let scratch: GPUTexture | null = null;
let configured: GPUTextureFormat | null = null;
// The air table of the observer's height, as the stars pass reads it: refraction, extinction and the horizon.
let air: { luts: AtmosphereLUTs; table: AirTable; texture: GPUTexture } | null = null;
// The meter's reading at each altitude, without keys, read back once per sky pass: the keys then grade it on the CPU,
// so the stars are exposed as the sky is.
let metered: { pass: SkyPass; ev100: number[] } | null = null;
const context = gpu.error ? null : canvas.getContext("webgpu");

function inverseViewProjection(aspect: number) {
    const { f: forward, r, u, tx, ty } = cameraBasis(CAMERA, aspect);
    return new Float32Array([...r.map((c) => c * tx), 0, ...u.map((c) => c * ty), 0, 0, 0, 0, 1, ...forward, 0]);
}

async function meter(sky: SkyPass) {
    const ev100: number[] = [];
    for (const altitude of ALTITUDES) {
        sky.update({
            sunDirection: sunAt(altitude),
            observerHeightM: OBSERVER_HEIGHT_M,
            autoExposureKeys: [],
            exposureCompensation: 0,
            autoExposureRange: [-60, 60],
        });
        ev100.push(await sky.meteredEV100());
        if (pass !== sky) return;
    }
    metered = { pass: sky, ev100 };
    requestRender();
}

// The keys' tint after the white balance, its rows scaled, as dunstkreis' sky pass applies it.
function tinted(white: WhiteBalance, [r, g, b]: readonly number[]): WhiteBalance {
    const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = white;
    return [m0 * r, m1 * g, m2 * b, m3 * r, m4 * g, m5 * b, m6 * r, m7 * g, m8 * b];
}

function drawTiles() {
    const table = tables();
    if (!context || !table) return;
    const device = gpuDevice();
    const { luts } = table;
    const { format, headroom } = displayOutput();
    const key = String(quality.groundLight);
    if (!pass || passLuts !== luts || passKey !== key) {
        if (building === key && buildingLuts === luts) return;
        building = key;
        buildingLuts = luts;
        createSkyPass(device, {
            luts,
            format: "rgba32float",
            toneMap: false,
            dither: false,
            groundLight: quality.groundLight,
        }).then((next) => {
            if (building !== key || tables()?.luts !== luts) return next.destroy();
            pass?.destroy();
            pass = next;
            passKey = key;
            passLuts = luts;
            building = "";
            meter(next);
        });
        return;
    }
    if (!milkyWayAsked) {
        milkyWayAsked = true;
        milkyWayOnce(device, "small").then((loaded) => {
            milkyWay = loaded;
            requestRender();
        });
    }
    const nextStarsKey = [format, headroom, catalog ? "stars" : "", milkyWay ? "milky way" : ""].join();
    if (!starsPass || starsKey !== nextStarsKey) {
        if (starsBuilding === nextStarsKey) return;
        starsBuilding = nextStarsKey;
        createStarsPass(device, {
            format,
            toneMap: "neutral",
            headroom,
            dither: format === SDR,
            catalog,
            milkyWay,
        }).then((next) => {
            if (starsBuilding !== nextStarsKey) return next.destroy();
            starsPass?.destroy();
            starsPass = next;
            starsKey = nextStarsKey;
            starsBuilding = "";
            requestRender();
        });
        if (!starsPass) return;
    }
    if (metered?.pass !== pass) return;
    if (air?.luts !== luts) {
        air?.texture.destroy();
        const airAt = airTable(luts.model, OBSERVER_HEIGHT_M);
        air = { luts, table: airAt, texture: createAirTexture(device, airAt) };
    }
    if (configured !== format) {
        configured = format;
        configureCanvas(context, format, GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const tile = Math.max(8, Math.round((canvas.clientWidth * dpr) / ALTITUDES.length));
    const [width, height] = [tile * ALTITUDES.length, tile * 2];
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    if (!skyTile || skyTile.width !== tile) {
        skyTile?.destroy();
        skyTile = device.createTexture({
            label: "sternwarte:gradingSky",
            size: [tile, tile],
            format: "rgba32float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
        });
    }
    if (!scratch || scratch.width !== tile || scratch.format !== format) {
        scratch?.destroy();
        scratch = device.createTexture({
            label: "sternwarte:gradingTile",
            size: [tile, tile],
            format,
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        });
    }
    const [sky, starry, background, out] = [pass, starsPass, skyTile, scratch];
    if (!starry) return;
    const target = context.getCurrentTexture();
    const ramp = libraryKeys();
    const view = inverseViewProjection(1);
    const { groundRadiusKm } = luts.model.planet;
    const dip = Math.acos(groundRadiusKm / (groundRadiusKm + OBSERVER_HEIGHT_M / 1000)) / DEG;
    const horizon = horizonZ(OBSERVER_HEIGHT_M, groundRadiusKm);
    const [lo, hi] = RANGE;
    // One submission per tile: the uniforms are written on the queue, so each tile's go out before the next ones. The
    // two rows of an altitude share its sky-view table, built once.
    ALTITUDES.forEach((altitude, i) => {
        const sunDirection = sunAt(altitude);
        const reading = metered?.ev100[i] ?? 0;
        for (const row of [0, 1]) {
            const keyed = row === 0 ? [] : ramp;
            const ev100 = Math.min(Math.max(reading - autoExposureCompensation(keyed, sunDirection, dip), lo), hi);
            sky.update({
                sunDirection,
                sunAngularDiameter: SUN_DIAMETER,
                observerHeightM: OBSERVER_HEIGHT_M,
                inverseViewProjection: view,
                projectionDistance: 0,
                pixelRatio: dpr,
                ev100: UNIT_EV100,
                // The disc's edge stays smooth through the stars pass' tone curve: twice what it shows as white.
                sunDiscCeiling: 2 * headroom * 1.2 * 2 ** ev100,
                autoExposureKeys: [],
                whiteBalance: NO_WHITE_BALANCE,
            });
            starry.update({
                skyRotation: SKY_ROTATION,
                years: YEARS,
                inverseViewProjection: view,
                projectionDistance: 0,
                ev100,
                whiteBalance: tinted(skyWhite(sunDirection), autoExposureTint(keyed, sunDirection, dip)),
                knee: headroom,
                horizonZ: horizon,
                air: air && { texture: air.texture, horizon: air.table.horizon },
            });
            const encoder = device.createCommandEncoder({ label: "sternwarte:grading" });
            sky.encode(encoder, background);
            starry.encode(encoder, out, { background });
            const origin = [i * tile, row * tile];
            encoder.copyTextureToTexture({ texture: out }, { texture: target, origin }, [tile, tile]);
            device.queue.submit([encoder.finish()]);
        }
    });
}

function render() {
    drawTiles();
    drawLanes();
    updateCode();
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
    const lowest = before ? before.sunAltitude + 0.5 : (STOPS[0] as number);
    const highest = after ? after.sunAltitude - 0.5 : (STOPS[STOPS.length - 1] as number);
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
    updateCode();
} else {
    loadCatalog().then((loaded) => {
        catalog = loaded;
        requestRender();
    });
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
