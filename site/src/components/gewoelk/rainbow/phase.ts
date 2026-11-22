import {
    bowRadius,
    DEFAULT_RAINBOW,
    type RainbowTable,
    rainbowPhase,
    rainbowTable,
    rainDropRadius,
} from "@himmelszelt/gewoelk";
import { find } from "../../dom";
import { onDemand } from "../../frame";
import { drawSvg, LABEL_GAP as GAP, svgText } from "../../sternzeit/figure";
import { RADII } from "./radii";
import { encode } from "./spectrum";

// What rain sends where: the library's table, computed anew for every drop size and spread, as a curve of its luminance
// and a strip of its colors, over every angle and over the 20 degrees the two bows stand in.

const LUMINANCE = 3;
// Phase per steradian from bottom to top, the same in both panels.
const [LOWEST, HIGHEST] = [1e-3, 3];
const DECADES = [1e-3, 1e-2, 1e-1, 1];
const EVEN = 1 / (4 * Math.PI);
// The strip's exposure: the primary bow's crest, an eighth per steradian in a shower, near white.
const EXPOSURE = 6;
// A table that takes longer than this is computed at fewer texels while a slider is dragged.
const DRAG_BUDGET_MS = 50;
const DRAG_TEXELS = 360;
const MARGIN = { left: 46, right: 10, top: 10 };
const TICKS = 16;

const root = find<HTMLElement>("#rain-phase");
const panels = {
    all: find<SVGSVGElement>('svg[data-panel="all"]', root),
    bows: find<SVGSVGElement>('svg[data-panel="bows"]', root),
};
const radiusSlider = find<HTMLInputElement>('[data-field="radius"]', root);
const spreadSlider = find<HTMLInputElement>('[data-field="spread"]', root);
const radiusValue = find<HTMLElement>('[data-field="radiusValue"]', root);
const spreadValue = find<HTMLElement>('[data-field="spreadValue"]', root);
const readout = find<HTMLElement>('[data-field="readout"]', root);

const f = (n: number) => n.toFixed(1);
const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
    `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" class="${cls}"/>`;

let table: RainbowTable | null = null;
let computed = { key: "", ms: 0 };
let fullMs = 0;
let dragging = false;

const radius = () => RADII[Number(radiusSlider.value)] ?? DEFAULT_RAINBOW.dropRadiusMm;
const spread = () => Number(spreadSlider.value);

function compute() {
    const texels = dragging && fullMs > DRAG_BUDGET_MS ? DRAG_TEXELS : DEFAULT_RAINBOW.texels;
    const key = `${radius()} ${spread()} ${texels}`;
    if (table && computed.key === key) return table;
    const start = performance.now();
    table = rainbowTable({ dropRadiusMm: radius(), spread: spread(), texels });
    computed = { key, ms: performance.now() - start };
    if (texels === DEFAULT_RAINBOW.texels) fullMs = computed.ms;
    return table;
}

const strips = document.createElement("canvas");

/** The table's colors between two angles as an image one texel high, exposed and encoded for the screen. */
function strip(of: RainbowTable, from: number, to: number) {
    const step = (of.to - of.from) / of.width;
    const [first, last] = [Math.round((from - of.from) / step), Math.round((to - of.from) / step)];
    Object.assign(strips, { width: last - first, height: 1 });
    const context = strips.getContext("2d");
    if (!context) return "";
    const image = context.createImageData(last - first, 1);
    for (let k = first; k < last; ++k) {
        for (let c = 0; c < 3; ++c) image.data[(k - first) * 4 + c] = encode((of.data[k * 4 + c] ?? 0) * EXPOSURE);
        image.data[(k - first) * 4 + 3] = 255;
    }
    context.putImageData(image, 0, 0);
    return strips.toDataURL();
}

interface Panel {
    from: number;
    to: number;
    every: number;
    stripHeight: number;
    /** A second scale along the top, the angle from the antisolar point, and the bows' marks. */
    bows: boolean;
}
const PANELS: Record<keyof typeof panels, Panel> = {
    all: { from: 0, to: 180, every: 30, stripHeight: 12, bows: false },
    bows: { from: 125, to: 145, every: 5, stripHeight: 22, bows: true },
};

function draw(name: keyof typeof panels, of: RainbowTable) {
    const svgEl = panels[name];
    const { from, to, every, stripHeight, bows } = PANELS[name];
    const [width, height] = [svgEl.clientWidth || 640, svgEl.clientHeight || 220];
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const top = MARGIN.top + (bows ? 2 * TICKS : 0);
    const bottom = height - 2 * TICKS - stripHeight - 4;
    const [left, right] = [MARGIN.left, width - MARGIN.right];
    const x = (angle: number) => left + ((angle - from) / (to - from)) * (right - left);
    const y = (phase: number) =>
        bottom -
        (Math.log(Math.min(Math.max(phase, LOWEST), HIGHEST) / LOWEST) / Math.log(HIGHEST / LOWEST)) * (bottom - top);

    let svg = "";
    if (!bows) {
        const zoom = PANELS.bows;
        svg += `<rect x="${f(x(zoom.from))}" y="${top}" width="${f(x(zoom.to) - x(zoom.from))}" height="${f(bottom - top)}" class="strip-band"/>`;
    }
    for (const decade of DECADES) {
        svg += line(left, y(decade), right, y(decade), "figure-grid");
        svg += svgText(left - GAP, y(decade), String(decade), "figure-grid-label rainphase-tick");
    }
    svg += line(left, y(EVEN), right, y(EVEN), "plot-mark");
    svg += svgText(x(bows ? 133.5 : 92), y(EVEN) - 9, "evenly to all sides", "figure-label");
    if (bows) svg += svgText(right - GAP, y(LOWEST) - 10, "per steradian", "figure-label figure-anchor-end");
    else svg += svgText(left + GAP, top + 9, "share per steradian", "figure-label figure-anchor-start");

    // The strip under the plot as its axis, the angles under it.
    const stripY = bottom + 4;
    const clip = `rainphase-clip-${name}`;
    svg += `<clipPath id="${clip}"><rect x="${left}" y="${stripY}" width="${f(right - left)}" height="${stripHeight}" rx="3"/></clipPath>`;
    svg += `<image href="${strip(of, from, to)}" x="${left}" y="${stripY}" width="${f(right - left)}" height="${stripHeight}" preserveAspectRatio="none" clip-path="url(#${clip})"/>`;
    const tickY = stripY + stripHeight + TICKS / 2 + 2;
    for (let angle = from; angle <= to; angle += every) {
        const cls =
            angle === from
                ? "figure-label figure-anchor-start"
                : angle === to
                  ? "figure-label figure-anchor-end"
                  : "figure-label";
        svg += svgText(x(angle), tickY, `${angle}°`, cls);
        if (bows) svg += svgText(x(angle), MARGIN.top + TICKS + 4, `${180 - angle}°`, cls);
    }
    svg += svgText((left + right) / 2, tickY + TICKS, "scattering angle", "figure-label");

    if (bows) {
        svg += svgText((left + right) / 2, MARGIN.top + 4, "angle from the antisolar point", "figure-label");
        // Where Descartes' rays stand in green light, the bows named beside them and the band between them.
        const [secondary, primary] = [180 - bowRadius(2), 180 - bowRadius(1)];
        svg += line(x(secondary), top, x(secondary), bottom, "plot-mark");
        svg += line(x(primary), top, x(primary), bottom, "plot-mark");
        svg += svgText(x(secondary) + GAP, top + 9, "secondary", "figure-label figure-anchor-start");
        svg += svgText(x(primary) + GAP, top + 9, "primary", "figure-label figure-anchor-start");
        svg += svgText((x(secondary) + x(primary)) / 2, top + 9 + TICKS, "Alexander’s band", "figure-label");
    }

    const step = (of.to - of.from) / of.width;
    const points: string[] = [];
    for (let k = 0; k < of.width; ++k) {
        const angle = of.from + (k + 0.5) * step;
        if (angle < from - step || angle > to + step) continue;
        points.push(`${f(x(Math.min(Math.max(angle, from), to)))},${f(y(of.data[k * 4 + LUMINANCE] ?? 0))}`);
    }
    svg += `<polyline points="${points.join(" ")}" class="plot-line"/>`;
    drawSvg(svgEl, svg, 1);
}

/** Where the table's luminance is highest between two scattering angles, and how high. */
function crest(of: RainbowTable, from: number, to: number) {
    let [best, value] = [from, 0];
    for (let angle = from; angle <= to; angle += 0.05) {
        const luminance = rainbowPhase(of, angle)[LUMINANCE];
        if (luminance > value) [best, value] = [angle, luminance];
    }
    return { angle: best, value };
}

/** The rain rate in mm/h whose drops have this mean radius by the library's `rainDropRadius`, where that is rain. */
function rainRate(radiusMm: number) {
    let [low, high] = [0.5, 100];
    if (radiusMm < rainDropRadius(low) || radiusMm > rainDropRadius(high)) return null;
    for (let i = 0; i < 40; ++i) {
        const middle = Math.sqrt(low * high);
        if (rainDropRadius(middle) < radiusMm) low = middle;
        else high = middle;
    }
    return Math.sqrt(low * high);
}

function render() {
    const of = compute();
    draw("all", of);
    draw("bows", of);
    radiusValue.textContent = `${radius() < 0.1 ? radius().toFixed(3) : radius().toFixed(2)}\u202fmm`;
    spreadValue.textContent = spread() === 0 ? "none" : `${Math.round(100 * spread())}%`;
    const [primary, secondary] = [crest(of, 134, 146), crest(of, 122, 132)];
    const rate = rainRate(radius());
    const rain =
        rate === null
            ? ""
            : `Drops this size fall in rain of ${rate < 10 ? rate.toFixed(1) : rate.toFixed(0)}\u202fmm/h. `;
    readout.innerHTML =
        `${rain}The primary bow is brightest ` +
        `${(180 - primary.angle).toFixed(1)}° from the antisolar point, ${(primary.value / EVEN).toFixed(1)} times an even share ` +
        `and ${(primary.value / secondary.value).toFixed(1)} times the secondary. ` +
        `<span class="note">${of.width} texels in ${computed.ms.toFixed(0)}\u202fms.</span>`;
}

const requestRender = onDemand(render, root);
for (const slider of [radiusSlider, spreadSlider]) {
    slider.addEventListener("input", () => {
        dragging = true;
        requestRender();
    });
    // Let go, the table in full.
    slider.addEventListener("change", () => {
        dragging = false;
        requestRender();
    });
}
new ResizeObserver(requestRender).observe(panels.all);
