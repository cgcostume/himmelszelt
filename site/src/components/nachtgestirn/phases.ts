import type { AtmosphereLUTs } from "@himmelszelt/dunstkreis";
import { MOON_GEOMETRIC_ALBEDO, moonEV100, phaseLaw, SUN_ILLUMINANCE } from "@himmelszelt/nachtgestirn";
import { fromJulianDay, julianEphemerisDay, moon } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, gpuDevice, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { drawSvg, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { type Law, noGpu, orbited } from "./laws";
import { saveFigure } from "./snapshot";

// The two laws worth comparing with the measured Moon over the month: the best rough diffuse one, and the lunar one.
const LAWS: readonly Law[] = ["orenNayar", "hapke"];

import { createMoonRenderer, inverseViewProjection, type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { createTiles, tileFrame } from "./tiles";

const DEG = Math.PI / 180;
// A Moon every this many degrees of phase angle, from 0 to 180.
const STRIP_STEP = 15;
const COUNT = 180 / STRIP_STEP + 1;
// The curves' step in degrees, finer towards 180° where they bend fastest, the size of the disc each point is read
// from, in pixels, and the samples per pixel it is drawn with: a thin crescent is a sliver a fraction of a pixel wide.
const STEP = 2.5;
const FINEST_STEP = 0.25;
const MEASURE_PX = 128;
const MEASURE_SAMPLES = 16;
// Discs measured a frame.
const MEASURE_BATCH = 12;
const MEASURE_EV100 = 10;
// The column left of the strips that names the rows, in CSS pixels.
const NAMES_PX = 64;
// A plain daytime sky behind the discs, in cd/m²: a clear blue some way from the Sun.
const DAY_SKY: readonly [number, number, number] = [2600, 4000, 6500];
// The figure follows no moment and no place: the Moon of January 1, 2000, from Earth's center, its face as it is then.
const FIXED = { jd: 2_451_545, place: { latitude: 0, longitude: 0, heightM: 0 } };

const angles: number[] = [];
for (let a = 0; a < 180; a += Math.max(FINEST_STEP, Math.min(STEP, (180 - a) / 8))) angles.push(a);
angles.push(180);
const measuredCurve = angles.map((a) => phaseLaw(a));
const stops = (value: number) => Math.log2(Math.max(value, 1e-9));
// A curve's stops at any phase angle, between the two angles it was read at either side.
function stopsAt(values: number[], deg: number) {
    let i = 1;
    while (i < angles.length - 1 && (angles[i] ?? 180) < deg) i++;
    const [a0, a1] = [angles[i - 1] ?? 0, angles[i] ?? 180];
    const t = Math.max(0, Math.min(1, (deg - a0) / (a1 - a0 || 1)));
    return stops(values[i - 1] ?? 1) * (1 - t) + stops(values[i] ?? 1) * t;
}
// The plot, phase angle across under the strips' discs and stops down to this many below a full Moon.
const BOTTOM = -14;
const MARGIN = { top: 18, bottom: 22 };
const NAMES: Record<Law | "measured", string> = {
    lambert: "Lambert",
    orenNayar: "Oren-Nayar",
    metallicRoughness: "PBR",
    hapke: "Hapke",
    measured: "measured",
};
const f = (n: number) => n.toFixed(1);

/** A half float's value, from its 16 bits: the readback's format. */
function halfFloat(bits = 0) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const mantissa = bits & 0x3ff;
    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 31) return mantissa ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * The light the whole disc sends towards the viewer at each phase angle, under each law, as the pass renders it: a
 * plain disc of the geometric albedo, no map, drawn linear into a small texture at every angle, read back once and
 * summed over the disc, relative to a flat disc of that albedo seen and lit straight on, which a Lambert sphere
 * gives two thirds of at full and Hapke's law one. Measured once per page from the shader itself, not from a copy of
 * its laws; empty until the passes are made and the readback is in, then `requestRender` is called.
 */
const curves: Partial<Record<Law, number[]>> = {};
let measuring = false;
function measureCurves(
    real: MoonAt,
    luts: AtmosphereLUTs,
    renderer: ReturnType<typeof createMoonRenderer>,
    requestRender: () => void,
) {
    if (curves.hapke || measuring || shared.error) return;
    const device = gpuDevice();
    const n = angles.length;
    // Half floats: the readback of every angle and law at once stays under 50 MB.
    const bytesPerTile = MEASURE_PX * MEASURE_PX * 8;
    const target = device.createTexture({
        label: "sternwarte:phaseMeasure",
        size: [MEASURE_PX, MEASURE_PX],
        format: "rgba16float",
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    });
    const buffer = device.createBuffer({
        label: "sternwarte:phaseMeasure",
        size: bytesPerTile * n * LAWS.length,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const degreesAcross = real.geocentricDiameter * 1.1;
    const { right, up, toward } = tileFrame(real);
    const half = Math.tan((degreesAcross * DEG) / 2);
    const view = inverseViewProjection(
        toward.map((t) => -t),
        right,
        up,
        half,
        half,
    );
    const radiusPx = ((real.geocentricDiameter / degreesAcross) * MEASURE_PX) / 2;
    // A few discs a frame, each batch after the GPU has finished the last, so the page keeps scrolling while it measures.
    measuring = true;
    let next = 0;
    const total = LAWS.length * n;
    const step = () => {
        const until = Math.min(next + MEASURE_BATCH, total);
        while (next < until) {
            const [l, i] = [Math.floor(next / n), next % n];
            const law = LAWS[l] ?? "hapke";
            const drawn = renderer.draw(target, {
                moon: orbited(real, 0, 0, (angles[i] ?? 0) * DEG),
                luts,
                toneMap: "linear",
                format: "rgba16float",
                headroom: 1,
                samples: MEASURE_SAMPLES,
                terminatorSamples: MEASURE_SAMPLES,
                width: MEASURE_PX,
                height: MEASURE_PX,
                inverseViewProjection: view,
                projectionDistance: 0,
                pixelRatio: 1,
                discPixels: radiusPx * 2,
                maps: "small",
                air: false,
                ev100: MEASURE_EV100,
                albedo: false,
                relief: false,
                shadows: false,
                // The curves are the laws' alone.
                earthshine: false,
                eclipse: false,
                law,
                nightVision: false,
            });
            // A pass still being made: the same disc again next frame.
            if (!drawn) break;
            const encoder = device.createCommandEncoder({ label: "sternwarte:phaseMeasureCopy" });
            encoder.copyTextureToBuffer(
                { texture: target },
                { buffer, offset: (l * n + i) * bytesPerTile, bytesPerRow: MEASURE_PX * 8 },
                [MEASURE_PX, MEASURE_PX],
            );
            device.queue.submit([encoder.finish()]);
            next++;
        }
        if (next < total) device.queue.onSubmittedWorkDone().then(() => requestAnimationFrame(step));
        else readBack();
    };
    step();
    function readBack() {
        buffer.mapAsync(GPUMapMode.READ).then(() => {
            const data = new Uint16Array(buffer.getMappedRange());
            // Luminance over the disc's area, undone of the exposure, against the flat disc's.
            const exposure = 1 / (1.2 * 2 ** MEASURE_EV100);
            const flat = (MOON_GEOMETRIC_ALBEDO * SUN_ILLUMINANCE) / Math.PI;
            const area = Math.PI * radiusPx * radiusPx;
            for (const [l, law] of LAWS.entries()) {
                curves[law] = angles.map((_, i) => {
                    const from = (l * n + i) * MEASURE_PX * MEASURE_PX * 4;
                    let sum = 0;
                    for (let p = 0; p < MEASURE_PX * MEASURE_PX; p++) {
                        const at = from + p * 4;
                        sum +=
                            0.2126 * halfFloat(data[at]) +
                            0.7152 * halfFloat(data[at + 1]) +
                            0.0722 * halfFloat(data[at + 2]);
                    }
                    return sum / exposure / (area * flat);
                });
            }
            buffer.unmap();
            buffer.destroy();
            target.destroy();
            measuring = false;
            requestRender();
        });
    }
}

/**
 * The phases figure on `root`: a strip of Moons from full to new for each law, plain discs of the law alone, small as
 * the Moon is seen, over the night sky or a plain daytime one, and under them each law's light over the phase angle,
 * as rendered, against the Moon's measured one, every disc above its own phase angle.
 */
export function phasesFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const plot = find<SVGSVGElement>(".tiles-plot > svg", root);
    const day = find("[data-field=day]", root);
    const metered = find("[data-field=metered]", root);
    const mapped = find("[data-field=map]", root);
    const overlay = find<SVGSVGElement>(".strips-overlay", root);
    const panel = find(".tiles-panel", root);
    // The phase angle under the pointer, over the strips or the plot, or none; and the tiles' width, for drawing it.
    let cursor: number | null = null;
    let lastTileCss = 0;
    const requestRender = onDemand(render, root);
    // The strips as drawn, their names and marks, and the plot under them, in one PNG.
    find("[data-field=download]", root).addEventListener("click", () =>
        saveFigure(root, canvas, render, {
            grounds: [panel],
            svgs: [overlay, plot],
            texts: root.querySelectorAll<HTMLElement>(".strip-names > li"),
        }),
    );
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    // The curves' own renderer, linear and unmapped, apart from the strips'.
    const measurer = shared.error ? null : createMoonRenderer(gpuDevice(), requestRender);

    function render() {
        const table = tables();
        if (!table) return;
        const real = moonAt(FIXED.jd, FIXED.place, table.luts.model);
        if (measurer) measureCurves(real, table.luts, measurer, requestRender);
        const width = root.clientWidth || 600;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const tileCss = (width - NAMES_PX) / COUNT;
        const tilePx = Math.round(tileCss * dpr);
        const byDay = day.getAttribute("aria-pressed") === "true";
        const perDisc = metered.getAttribute("aria-pressed") === "true";
        const withMap = mapped.getAttribute("aria-pressed") === "true";
        root.toggleAttribute("data-day", byDay);
        // By night at the full Moon's exposure, so the light seen is the light each law gives, or each disc metered on
        // its lit part; by day the sky sets it.
        const ev100 = perDisc ? null : byDay ? moonEV100(0, 1) + 1.5 : moonEV100(0, 1);
        // The column under the pointer at the pointer's own angle, the others on their 15° steps.
        const column = cursor === null ? -1 : Math.round(cursor / STRIP_STEP);
        const moons = Array.from({ length: COUNT }, (_, i) =>
            orbited(real, 0, 0, (i === column && cursor !== null ? cursor : i * STRIP_STEP) * DEG),
        );
        tiles?.draw(
            {
                count: COUNT,
                rows: LAWS.length,
                width: tilePx,
                degreesAcross: real.geocentricDiameter * 1.5,
                // By day the sky as drawn becomes the strips' ground.
                ...(byDay
                    ? {
                          probe: ([r, g, b]: readonly [number, number, number]) => {
                              root.style.setProperty("--sky-bg", `color(srgb ${r} ${g} ${b})`);
                              // A light ink on a dark sky, a dark one on a light sky.
                              root.toggleAttribute("data-sky-dark", 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45);
                          },
                      }
                    : {}),
            },
            (i) => ({
                moon: moons[i % COUNT] ?? real,
                luts: table.luts,
                toneMap: display.toneCurve as ToneCurveName,
                maps: "small",
                ev100,
                albedo: withMap,
                relief: withMap,
                shadows: withMap,
                earthshine: true,
                eclipse: false,
                law: LAWS[Math.floor(i / COUNT)] ?? "hapke",
                nightVision: false,
                ...(byDay ? { background: DAY_SKY } : {}),
            }),
        );
        lastTileCss = tileCss;
        renderPlot(tileCss);
    }

    // The Moon's phase angle at the page's moment: the figure's own Moon stays fixed, this marks where the real one is.
    const nowAngle = () => moon.phaseAngle(julianEphemerisDay(fromJulianDay(state.jd)));

    function renderPlot(tileCss: number) {
        const width = plot.clientWidth || 600;
        const height = plot.clientHeight || 180;
        plot.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const x = (deg: number) => NAMES_PX + tileCss / 2 + (deg / 180) * (width - NAMES_PX - tileCss);
        const y = (s: number) => MARGIN.top + (Math.max(s, BOTTOM) / BOTTOM) * (height - MARGIN.top - MARGIN.bottom);
        const points = (values: number[]) => values.map((v, i) => `${f(x(angles[i] ?? 180))},${f(y(stops(v)))}`);
        // A curve ends where it falls through the plot's floor, rather than running along it.
        const above = (values: number[]) => values.filter((v) => stops(v) >= BOTTOM);
        let svg = "";
        for (let s = 0; s >= BOTTOM; s -= 2) {
            svg += `<line x1="${f(x(0))}" y1="${f(y(s))}" x2="${f(x(180))}" y2="${f(y(s))}" class="figure-grid"/>`;
            svg += svgText(x(0) - 6, y(s), s === 0 ? "0" : `${s}`, "figure-grid-label figure-anchor-end");
        }
        for (let deg = 0; deg <= 180; deg += STRIP_STEP * 2) {
            // Not under the cursor's own angle.
            if (cursor !== null && Math.abs(deg - cursor) < 8) continue;
            svg += svgText(x(deg), height - 6, `${deg}°`, "figure-label");
        }
        const drawn = LAWS.filter((law) => curves[law] !== undefined);
        svg += `<polyline points="${points(measuredCurve).join(" ")}" class="plot-line plot-line-measured"/>`;
        for (const law of drawn) {
            svg += `<polyline points="${points(above(curves[law] ?? [])).join(" ")}" class="plot-line plot-line-${law}"/>`;
        }
        const series = (law: Law | "measured") => (law === "measured" ? measuredCurve : curves[law]);
        // A dim line at each column's angle.
        for (let deg = 0; deg <= 180; deg += STRIP_STEP) {
            svg += `<line x1="${f(x(deg))}" y1="${f(MARGIN.top)}" x2="${f(x(deg))}" y2="${f(y(BOTTOM))}" class="plot-column"/>`;
        }
        // Now: where the real Moon is in its phases at the page's moment.
        const now = nowAngle();
        svg += `<line x1="${f(x(now))}" y1="${f(MARGIN.top)}" x2="${f(x(now))}" y2="${f(y(BOTTOM))}" class="plot-now"/>`;
        svg += svgText(x(now), MARGIN.top - 4, `now ${now.toFixed(0)}°`, "figure-note plot-now-label");
        // The readouts at the cursor, or at now while nothing is pointed at: a dot on each curve, and each curve's stops
        // beside the line, in a fixed order, one to each row between the grid lines, the lowest rows where there is
        // more room below the curves, else the highest; left of the line near the plot's right end.
        const at = cursor ?? now;
        if (cursor !== null) {
            svg += `<line x1="${f(x(cursor))}" y1="${f(MARGIN.top)}" x2="${f(x(cursor))}" y2="${f(y(BOTTOM))}" class="plot-cursor"/>`;
            svg += svgText(x(cursor), height - 6, `${cursor.toFixed(0)}°`, "figure-label plot-cursor-label");
        }
        const order = [...LAWS.filter((law) => curves[law] !== undefined), "measured" as const];
        const values = order.map((law) => stopsAt(series(law) ?? [], at));
        for (const value of values) {
            if (value >= BOTTOM) svg += `<circle cx="${f(x(at))}" cy="${f(y(value))}" r="2.5" class="plot-dot"/>`;
        }
        const left = at > 140;
        const over = Math.min(...values.map(y)) - MARGIN.top;
        const under = y(BOTTOM) - Math.max(...values.map(y));
        const first = under >= over ? BOTTOM + 2 * order.length - 1 : -1;
        for (const [i, law] of order.entries()) {
            svg += svgText(
                x(at) + (left ? -6 : 6),
                y(first - 2 * i),
                `${NAMES[law]} ${(values[i] ?? 0).toFixed(1)}`,
                `figure-note ${left ? "figure-anchor-end" : "figure-anchor-start"} plot-label-${law}`,
            );
        }
        drawSvg(plot, svg, 1);
        renderOverlay(tileCss, now);
    }

    // Over the strips, the panel's full height: now as a line with its tick at the top, the cursor as a line.
    function renderOverlay(tileCss: number, now: number) {
        const width = panel.clientWidth || 600;
        const height = panel.clientHeight || canvas.clientHeight || 0;
        overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const x = (deg: number) => NAMES_PX + tileCss / 2 + (deg / STRIP_STEP) * tileCss;
        let svg = `<line x1="${f(x(now))}" y1="0" x2="${f(x(now))}" y2="${f(height)}" class="strips-now-line"/>`;
        svg += `<path d="M${f(x(now) - 5)} 0h10l-5 7z" class="strips-now"/>`;
        if (cursor !== null) {
            svg += `<line x1="${f(x(cursor))}" y1="0" x2="${f(x(cursor))}" y2="${f(height)}" class="strips-cursor"/>`;
        }
        drawSvg(overlay, svg, 1);
    }

    // The pointer's phase angle, over the strips or the plot, clamped to the strips' span.
    function angleAt(clientX: number) {
        const box = root.getBoundingClientRect();
        const tileCss = lastTileCss || 1;
        const deg = ((clientX - box.left - NAMES_PX - tileCss / 2) / tileCss) * STRIP_STEP;
        return Math.max(0, Math.min(180, deg));
    }
    for (const target of [panel, plot] as HTMLElement[]) {
        // The hovered column's Moons follow the pointer's angle, so the whole span is drawn: the strips are redrawn.
        target.addEventListener("pointermove", (event: PointerEvent) => {
            // Over the switches and the download, no column: they are not the strips.
            const over = (event.target as Element | null)?.closest(".view-buttons");
            cursor = over ? null : angleAt(event.clientX);
            requestRender();
        });
        target.addEventListener("pointerleave", () => {
            cursor = null;
            requestRender();
        });
    }
    onChange(() => {
        if (lastTileCss) renderPlot(lastTileCss);
    });

    for (const button of [day, metered, mapped]) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
            requestRender();
        });
    }
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
