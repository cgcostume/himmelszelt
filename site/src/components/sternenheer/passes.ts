import type { AtmosphereLUTs, AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import {
    airTable,
    createAirTexture,
    createSkyPass,
    DEFAULT_ATMOSPHERE_MODEL,
    liftedDirection,
} from "@himmelszelt/dunstkreis";
import type { MeterPass } from "@himmelszelt/helldunkel";
import {
    createMeterPass,
    ev100FromLuminance,
    localAdaptation,
    lowLightCompensation,
    meteredLuminance,
} from "@himmelszelt/helldunkel";
import type { MoonMaps, MoonPass } from "@himmelszelt/nachtgestirn";
import {
    createMoonPass,
    horizonZ,
    loadMoonMaps,
    MOON_MAPS_WHOLE,
    refractionTable,
    SUN_ILLUMINANCE,
} from "@himmelszelt/nachtgestirn";
import type {
    ConstellationLines,
    DeepStars,
    MilkyWay,
    PackedStars,
    StarCatalog,
    StarsInspection,
    StarsPass,
} from "@himmelszelt/sternenheer";
import {
    createStarsPass,
    loadCatalog,
    loadConstellations,
    loadFaintStars,
    loadMilkyWay,
    MILKY_WAY_MAPS,
} from "@himmelszelt/sternenheer";
import { find } from "../dom";
import { gpu, onTables, quality, tables } from "../dunstkreis/atmosphere";
import { cameraBasis } from "../dunstkreis/skycamera";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { deepStarsOnce, inverseViewProjection, skyAt } from "./renderer";
import { bindStarGroups, picked } from "./stargroups";

// The frame: the budget figure's view, at half its size, at a moonless night's exposure.
const [WIDTH, HEIGHT] = [960, 540];
const VIEW = { yaw: Math.PI, pitch: (35 * Math.PI) / 180, fov: (120 * Math.PI) / 180 };
const EV100 = -9;
const FRAMES = 64;
// The halos' logarithmic curve, SH_HALO_KNEE in the pass' params.wgsl.
const HALO_KNEE = 0.25;
const PASSES = ["sky", "lines", "bin", "deep", "halo", "compose", "moon"] as const;
// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);

const encode = (v: number) => {
    const c = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};
const thousands = (n: number) => n.toLocaleString("en-US");

/** The passes figure on `root`: a frame of the stars pass made with `debug`, what it leaves between its passes. */
export function passesFigure(root: HTMLElement) {
    const field = <T extends Element = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const canvases = Object.fromEntries(
        ["tiles", "lines", "points", "spread", "image"].map((name) => [name, field<HTMLCanvasElement>(name)]),
    );
    const sliders = { tileSize: field<HTMLInputElement>("tileSize"), capacity: field<HTMLInputElement>("capacity") };
    const status = field("status");
    const pressed = (name: string) => field(name).getAttribute("aria-pressed") === "true";
    const device = gpu.device;
    if (!device) {
        status.innerHTML = gpu.error ?? "This needs WebGPU.";
        return;
    }
    const texture = (label: string, format: GPUTextureFormat, usage: number) =>
        device.createTexture({ label, size: [WIDTH, HEIGHT], format, usage });
    const target = texture(
        "sternwarte:passes",
        "rgba8unorm",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    );
    // The sky behind the stars and the stars before the Moon, both in cd/m².
    const background = texture(
        "sternwarte:passesSky",
        "rgba32float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    );
    const composed = texture(
        "sternwarte:passesStars",
        "rgba32float",
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    );
    // The sky's pass and the Moon's timed on the GPU's clock, the sky's by an encoder that adds the timestamps to it.
    const clock = device.features.has("timestamp-query")
        ? {
              queries: device.createQuerySet({ type: "timestamp", count: 4 }),
              resolved: device.createBuffer({
                  size: 32,
                  usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
              }),
          }
        : null;
    const writes = (at: number) =>
        clock ? { querySet: clock.queries, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 } : undefined;
    const timedEncoder = (encoder: GPUCommandEncoder, at: number) =>
        new Proxy(encoder, {
            get(real, key) {
                if (key === "beginComputePass")
                    return (descriptor: GPUComputePassDescriptor = {}) =>
                        real.beginComputePass({ ...descriptor, timestampWrites: writes(at) });
                const value = Reflect.get(real, key);
                return typeof value === "function" ? value.bind(real) : value;
            },
        });
    async function bracketed(ran: { sky: boolean; moon: boolean }) {
        if (!clock || !device) return {};
        const buffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(clock.resolved, 0, buffer, 0, 32);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const ns = new BigInt64Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        buffer.destroy();
        const ms = (i: number) => Number((ns[i + 1] ?? 0n) - (ns[i] ?? 0n)) / 1e6;
        return { ...(ran.sky ? { sky: ms(0) } : {}), ...(ran.moon ? { moon: ms(2) } : {}) };
    }
    const air = (() => {
        let made: { key: string; texture: GPUTexture; horizon: number; table: ReturnType<typeof airTable> } | null =
            null;
        return (heightM: number, model: AtmosphereModel) => {
            const key = `${heightM} ${model.refractivity} ${model.planet.groundRadiusKm} ${model.planet.thicknessKm}`;
            if (made?.key === key) return made;
            made?.texture.destroy();
            const table = airTable(model, heightM);
            made = { key, texture: createAirTexture(device, table), horizon: table.horizon, table };
            return made;
        };
    })();
    let data: {
        catalog: StarCatalog;
        faint: PackedStars | null;
        lines: ConstellationLines;
        milkyWay: MilkyWay;
    } | null = null;
    Promise.all([
        loadCatalog(),
        loadFaintStars().catch(() => null),
        loadConstellations(),
        loadMilkyWay(device, MILKY_WAY_MAPS.small),
    ]).then(([catalog, faint, lines, milkyWay]) => {
        data = { catalog, faint, lines, milkyWay };
        request();
    });
    let meter: MeterPass | null = null;
    createMeterPass(device, { source: "2d" }).then((made) => {
        meter = made;
        request();
    });
    let moonMaps: MoonMaps | null = null;
    loadMoonMaps(device, MOON_MAPS_WHOLE["512"]).then((maps) => {
        moonMaps = maps;
        request();
    });
    let deep: DeepStars | null | "loading" = null;
    let pass: { key: string; pass: StarsPass } | null = null;
    let sky: { luts: AtmosphereLUTs; pass: SkyPass } | null = null;
    let moon: MoonPass | null = null;
    let busy = false;
    let again = false;

    const tileSize = () => 2 ** Number(sliders.tileSize.value);
    const capacity = () => 2 ** Number(sliders.capacity.value);

    // Under the Moon the stars stay in cd/m² for its pass to expose; alone they are tone mapped into the target.
    async function passFor(moonOn: boolean) {
        if (!data || !device) return null;
        const catalog = picked(root, "catalog");
        const wantsDeep = catalog === "tycho" && deep !== null && deep !== "loading";
        const key = `${tileSize()} ${capacity()} ${catalog} ${wantsDeep} ${moonOn}`;
        if (pass?.key === key) return pass.pass;
        pass?.pass.destroy();
        pass = null;
        const made = await createStarsPass(device, {
            format: moonOn ? "rgba32float" : "rgba8unorm",
            ...(moonOn ? { toneMap: false, dither: false } : { dither: true }),
            catalog: data.catalog,
            faintStars: catalog !== "yale" ? data.faint : null,
            deepStars: wantsDeep ? (deep as DeepStars) : null,
            constellations: data.lines,
            milkyWay: data.milkyWay,
            tileSize: tileSize(),
            capacity: capacity(),
            debug: true,
        });
        pass = { key, pass: made };
        return made;
    }

    async function skyFor(luts: AtmosphereLUTs) {
        if (sky?.luts === luts) return sky.pass;
        sky?.pass.destroy();
        sky = null;
        const made = await createSkyPass(device as GPUDevice, {
            luts,
            format: "rgba32float",
            toneMap: false,
            autoExposure: false,
            moonlight: true,
            groundLight: quality.groundLight,
            dither: false,
        });
        sky = { luts, pass: made };
        return made;
    }

    async function moonFor() {
        if (moon || !moonMaps) return moon;
        moon = await createMoonPass(device as GPUDevice, {
            format: "rgba8unorm",
            toneMap: "neutral",
            dither: true,
            background: true,
            maps: moonMaps,
            darkAdapted: false,
            samples: 4,
        });
        return moon;
    }

    async function draw() {
        if (busy) {
            again = true;
            return;
        }
        busy = true;
        try {
            if (picked(root, "catalog") === "tycho" && deep === null) {
                deep = "loading";
                status.textContent = "Fetching Tycho-2's 2.4 million stars, 14 MB …";
                deepStarsOnce().then((loaded) => {
                    deep = loaded;
                    status.textContent = loaded ? "" : "No deep stars here: pnpm assets makes them.";
                    request();
                });
            }
            const [moonOn, airOn] = [pressed("moon"), pressed("air")];
            const luts = tables()?.luts ?? null;
            if (airOn && !luts) return;
            const p = await passFor(moonOn);
            const skyPass = airOn && luts ? await skyFor(luts) : null;
            const moonPass = moonOn ? await moonFor() : null;
            if (!p || !device || (moonOn && !moonPass)) return;
            const model = luts?.model ?? DEFAULT_ATMOSPHERE_MODEL;
            const s = skyAt(state.jd, state, model);
            const basis = cameraBasis(VIEW, WIDTH / HEIGHT);
            const view = {
                inverseViewProjection: inverseViewProjection(basis.f, basis.r, basis.u, basis.tx, basis.ty),
                projectionDistance: basis.d,
            };
            const theAir = airOn ? air(s.heightM, model) : null;
            const ground = airOn ? horizonZ(s.heightM, model.planet.groundRadiusKm) : -1;
            const moonShown = theAir ? liftedDirection(theAir.table, s.moonDirection) : s.moonDirection;
            skyPass?.update({
                ...view,
                sunDirection: s.sunDirection,
                sunAngularDiameter: s.sunAngularDiameter,
                observerHeightM: s.heightM,
                pixelRatio: 1,
                ev100: UNIT_EV100,
                autoExposureKeys: [],
                autoExposureRange: [-20, 20],
                moonDirection: s.moonDirection,
                moonIlluminance: moonOn ? s.moonIlluminance : 0,
                moonAngularDiameter: moonOn ? s.moonAngularDiameter : 0,
            });
            // A moonless night's exposure, or the sky's metered one where its light, by day or by the Moon, is brighter.
            let ev100 = EV100;
            if (skyPass && meter) {
                const encoder = device.createCommandEncoder({ label: "sternwarte:passesMeter" });
                skyPass.encode(encoder, background);
                meter.encode(encoder, background, { maxSize: 256 });
                device.queue.submit([encoder.finish()]);
                const histogram = await meter.readHistogram();
                // The ground and empty space are black, not dark: they say nothing about the light.
                histogram.luminance[0] = 0;
                const light = meteredLuminance(histogram);
                ev100 = Math.max(EV100, ev100FromLuminance(light) - lowLightCompensation(light));
            }
            // The disc's edge stays smooth through the tone curve: twice what it shows as white.
            skyPass?.update({ sunDiscCeiling: 2 * 1.2 * 2 ** ev100 });
            p.update({
                ...view,
                skyRotation: s.skyRotation,
                years: s.years,
                ev100: moonOn ? UNIT_EV100 : ev100,
                displayEV100: moonOn ? ev100 : null,
                horizonZ: ground,
                occluder: moonOn ? { direction: moonShown, angularDiameter: s.moonAngularDiameter } : null,
                air: theAir && { texture: theAir.texture, horizon: theAir.horizon },
                constellations: null,
                constellationOpacity: 0.3,
            });
            moonPass?.update({
                ...view,
                direction: s.moonDirection,
                angularDiameter: s.moonAngularDiameter,
                sunDirection: s.moonSunDirection,
                sunIlluminance: SUN_ILLUMINANCE,
                earthshine: s.earthshine,
                exposureCompensation: localAdaptation(ev100, s.moonEV100 + (airOn ? s.moonAirStops : 0)),
                orientation: s.moonOrientation,
                ev100,
                horizonZ: ground,
                albedoMap: true,
                relief: true,
                shadows: true,
                eclipse: null,
                sunAngularDiameter: s.sunAngularDiameter,
                refraction: airOn ? refractionTable(s.moonDirection, s.moonAngularDiameter, s.bend, s.through) : null,
                distanceKm: s.distanceKm - model.planet.groundRadiusKm * s.moonDirection[2],
            });
            // The frames timed, then the last one read back.
            const sums: Record<string, number> = {};
            let timed = 0;
            for (let frame = 0; frame < FRAMES; frame++) {
                const encoder = device.createCommandEncoder({ label: "sternwarte:passes" });
                skyPass?.encode(clock ? timedEncoder(encoder, 0) : encoder, background);
                p.encode(encoder, moonPass ? composed : target, skyPass ? { background } : {});
                const timestampWrites = writes(2);
                moonPass?.encode(encoder, target, {
                    background: composed,
                    ...(timestampWrites ? { timestampWrites } : {}),
                });
                if (clock) encoder.resolveQuerySet(clock.queries, 0, 4, clock.resolved, 0);
                device.queue.submit([encoder.finish()]);
                const times = await p.timings();
                if (!times) break;
                timed++;
                const around = await bracketed({ sky: Boolean(skyPass), moon: Boolean(moonPass) });
                for (const [name, ms] of Object.entries({ ...times, ...around })) sums[name] = (sums[name] ?? 0) + ms;
            }
            const inspection = await p.inspect();
            const image = await readTarget();
            show(
                inspection,
                image,
                timed ? Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, v / timed])) : null,
                ev100,
            );
        } finally {
            busy = false;
        }
        if (again) {
            again = false;
            draw();
        }
    }

    async function readTarget() {
        if (!device) return new Uint8Array();
        const rowBytes = Math.ceil((WIDTH * 4) / 256) * 256;
        const buffer = device.createBuffer({
            size: rowBytes * HEIGHT,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: rowBytes }, [WIDTH, HEIGHT]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const padded = new Uint8Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        buffer.destroy();
        const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
        for (let y = 0; y < HEIGHT; y++)
            pixels.set(padded.subarray(y * rowBytes, y * rowBytes + WIDTH * 4), y * WIDTH * 4);
        return pixels;
    }

    /** `rgba` bytes into `canvas` at their own size. */
    function paint(canvas: HTMLCanvasElement, width: number, height: number, rgba: Uint8ClampedArray<ArrayBuffer>) {
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        canvas.getContext("2d")?.putImageData(new ImageData(rgba, width, height), 0, 0);
    }

    /** The tiles by a count each, brighter the more, those past `most` in the accent. */
    function tiles(canvas: HTMLCanvasElement, t: StarsInspection["tiles"], counts: Uint32Array, most: number) {
        const accent = getComputedStyle(root).getPropertyValue("--accent").trim();
        const probe = document.createElement("canvas").getContext("2d");
        let rgb = [255, 160, 60];
        if (probe && accent) {
            probe.fillStyle = accent;
            probe.fillRect(0, 0, 1, 1);
            rgb = Array.from(probe.getImageData(0, 0, 1, 1).data.slice(0, 3));
        }
        const rgba = new Uint8ClampedArray(new ArrayBuffer(t.columns * t.rows * 4));
        for (let i = 0; i < t.columns * t.rows; i++) {
            const n = counts[i] ?? 0;
            const v = n > most ? rgb : Array(3).fill(encode(Math.log2(1 + n) / Math.log2(1 + most)));
            rgba.set([...v, 255], i * 4);
        }
        paint(canvas, t.columns, t.rows, rgba);
    }

    /** A level of the halos' grid as light, in units of display white on the halos' curve, the target's part of it. */
    function light(
        canvas: HTMLCanvasElement,
        level: { width: number; height: number; own: Float32Array; sum: Float32Array },
        which: "own" | "sum",
        margin: number,
    ) {
        const values = level[which];
        const [x0, y0] = [margin, margin];
        const [w, h] = [Math.min(level.width - 2 * margin, WIDTH / 2), Math.min(level.height - 2 * margin, HEIGHT / 2)];
        const rgba = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const at = ((y + y0) * level.width + x + x0) * 4;
                const c = [0, 1, 2].map((k) => values[at + k] ?? 0);
                const top = Math.max(...c);
                const shaped = top > 0 ? (HALO_KNEE * Math.log1p(top / HALO_KNEE)) / top : 0;
                rgba.set([...c.map((v) => encode(v * shaped)), 255], (y * w + x) * 4);
            }
        }
        paint(canvas, w, h, rgba);
    }

    function show(inspection: StarsInspection, image: Uint8Array, ms: Record<string, number> | null, ev100: number) {
        const t = inspection.tiles;
        const full = Array.from(t.stars).filter((n) => n > t.capacity).length;
        const fullest = Math.max(...t.stars);
        tiles(canvases.tiles as HTMLCanvasElement, t, t.stars, t.capacity);
        field("tilesNote").textContent =
            `: ${thousands(t.columns * t.rows)} tiles of ${t.size} pixels, ${thousands(full)} full, the fullest ${thousands(fullest)} stars`;
        const lineTiles = Array.from(t.lines).filter((n) => n > 0).length;
        tiles(canvases.lines as HTMLCanvasElement, t, t.lines, t.lineCapacity);
        field("linesNote").textContent = `: ${thousands(lineTiles)} tiles crossed`;
        const halo = inspection.halo;
        const finest = halo?.levels[0];
        if (halo && finest) {
            const margin = halo.margin / halo.scale;
            light(canvases.points as HTMLCanvasElement, finest, "own", margin);
            light(canvases.spread as HTMLCanvasElement, finest, "sum", margin);
            field("pointsNote").textContent =
                `: ${thousands(inspection.stars.halos)} stars, ${finest.width} by ${finest.height} texels with the margin`;
            const shares = halo.weights.map((w) => `${(w * 100).toFixed(w < 0.095 ? 1 : 0)}%`).join(", ");
            field("spreadNote").textContent = `: ${halo.levels.length} levels, their shares ${shares}`;
        }
        paint(canvases.image as HTMLCanvasElement, WIDTH, HEIGHT, new Uint8ClampedArray(image.buffer as ArrayBuffer));
        field("imageNote").textContent =
            `: ${thousands(inspection.stars.drawn)} of ${thousands(inspection.stars.count)} stars drawn, at EV100 ${ev100 < 0 ? "−" : ""}${Math.abs(ev100).toFixed(1)}`;
        times(ms);
        if (deep !== "loading") status.textContent = "";
    }

    function times(ms: Record<string, number> | null) {
        const svg = field<SVGSVGElement>("times");
        if (!ms) {
            field("timesNote").textContent = ": this browser hands out no GPU clock";
            drawSvg(svg, "", 1);
            return;
        }
        const width = svg.clientWidth || 320;
        const rows = PASSES.filter((name) => ms[name] !== undefined);
        const [left, row, right] = [64, 24, 70];
        const height = rows.length * row + 8;
        const most = Math.max(...rows.map((name) => ms[name] ?? 0), 1e-3);
        svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        let out = "";
        rows.forEach((name, i) => {
            const y = 4 + i * row;
            const w = ((ms[name] ?? 0) / most) * (width - left - right);
            out += svgText(left - 6, y + row / 2, name, "figure-label figure-anchor-end");
            out += `<rect x="${left}" y="${y + 5}" width="${Math.max(w, 1).toFixed(1)}" height="${row - 10}" class="passes-bar"/>`;
            out += svgText(
                left + w + 6,
                y + row / 2,
                `${(ms[name] ?? 0).toFixed(3)} ms`,
                "figure-label figure-anchor-start",
            );
        });
        drawSvg(svg, out, 1);
        const total = rows.reduce((sum, name) => sum + (ms[name] ?? 0), 0);
        field("timesNote").textContent = `: ${total.toFixed(2)} ms together`;
    }

    const request = onDemand(() => {
        for (const [name, input] of Object.entries(sliders)) {
            paintRange(input);
            field(`${name}Value`).textContent = name === "tileSize" ? `${tileSize()} px` : String(capacity());
        }
        draw();
    }, root);
    for (const input of Object.values(sliders)) input.addEventListener("input", request);
    for (const name of ["moon", "air"])
        field(name).addEventListener("click", () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            request();
        });
    bindStarGroups(root, request);
    onChange(request);
    onTables(request);
    request();
}
