import type { AirTable } from "@himmelszelt/dunstkreis";
import {
    AIR_CHANNEL_DISPERSION,
    AIR_TABLE_WIDTH,
    airAt,
    airLift,
    airRefractivity,
    airTable,
    DEFAULT_ATMOSPHERE_MODEL,
} from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, svgText } from "../sternzeit/figure";

// The air table row by row as strips of its texels, the chosen one plotted, and what the table does to the Moon low
// down: lifted, squeezed, dimmed, its colors spread.

const DEG = Math.PI / 180;
const LAST = AIR_TABLE_WIDTH - 1;
const MOON_RADIUS = 0.259;
const MOON_ALBEDO = 0.9;
// The close-up's field, in degrees: 2.4 arcminutes high.
const LIMB_FIELD = 0.04;
const OFFSETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 45];
// The plot: as high whichever strip is chosen, its altitudes along the top, a panel per quantity under a title each.
const PLOT_HEIGHT = 260;
const AXIS = 26;
const TITLE = 18;
const PANEL_GAP = 10;

/**
 * A quantity of the table on a fixed axis, wide enough for every table the sliders make: the extremes over observer
 * heights from 1 m to orbit and air from -30 °C to 40 °C, rounded out. Its strip shows it normalized to the same range.
 */
interface Quantity {
    name: string;
    min: number;
    max: number;
    log?: boolean;
    ticks: number[];
    label: (v: number) => string;
}
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const power = (v: number) => {
    const e = Math.round(Math.log10(v));
    if (e === 0) return "1";
    const digits = [...String(Math.abs(e))].map((d) => SUPERSCRIPT[Number(d)]).join("");
    return `10${e < 0 ? "⁻" : ""}${digits}`;
};
const meters = (v: number) => (v < 1000 ? `${v} m` : `${v / 1000} km`);
const plain = (v: number) => String(v);
const signed = (unit: string) => (v: number) => (v === 0 ? "0" : `${v > 0 ? "+" : "−"}${Math.abs(v)}${unit}`);
const arcminutes = (v: number) => `${v}′`;

// Bend and lift peak at 90.5′, in -30 °C air for the ray grazing the limb from 89 km up; red and blue part by -8.2″
// and +17.8″ at most.
const BEND: Quantity = { name: "bend, arcminutes", min: 0, max: 100, ticks: [0, 50, 100], label: arcminutes };
const LIFT: Quantity = { ...BEND, name: "lift, arcminutes" };
const SPREAD: Quantity = {
    name: "red and blue from green, arcseconds",
    min: -10,
    max: 20,
    ticks: [-10, 0, 10, 20],
    label: signed("″"),
};
const UNIT = { min: 0, max: 1, ticks: [0, 0.5, 1], label: plain };
const TRANSMITTANCE: Quantity = { ...UNIT, name: "transmittance" };
const DILUTION: Quantity = { ...UNIT, name: "dilution" };
// The airmass reaches 80 along that ray, 39 on the ground's horizon.
const AIRMASS: Quantity = { name: "airmass", min: 0, max: 80, ticks: [0, 40, 80], label: plain };
// The turbulence spans decades: 1 straight up from sea level, the seeing's up to 600 along the limb from 13 km up, the
// scintillation's up to 500,000 from orbit, lying 840 m to 2,400 km away. Below the axis, near nothing, it is clamped.
const SEEING: Quantity = { name: "seeing", min: 1e-3, max: 1e3, log: true, ticks: [1e-3, 1, 1e3], label: power };
const SCINTILLATION: Quantity = {
    name: "scintillation",
    min: 1e-3,
    max: 1e6,
    log: true,
    ticks: [1e-3, 1, 1e3, 1e6],
    label: power,
};
const DISTANCE = { min: 100, max: 1e7, log: true, ticks: [100, 1e4, 1e6], label: meters };
const WIND = { min: 0, max: 1.5, ticks: [0, 0.5, 1, 1.5], label: plain };

type Values = (t: AirTable, i: number) => number;
const texel =
    (row: number, channel: number, scale = 1): Values =>
    (t, i) =>
        (t.data[(row * AIR_TABLE_WIDTH + i) * 4 + channel] as number) * scale;
const toArcminutes = 60 / DEG;

/** How far the air shows red and blue apart from green at entry i, in arcseconds, up positive: the bend (row 0, a)
 *  times the dilution (row 2, a) times each channel's share of the bend beyond green's. */
const spread =
    (channel: number): Values =>
    (t, i) =>
        ((AIR_CHANNEL_DISPERSION[channel] as number) - 1) * texel(0, 3, 3600 / DEG)(t, i) * texel(2, 3)(t, i);

interface Panel {
    quantity: Quantity;
    lines: [Values, string][];
}
/** A strip: a row's rgb or its alpha, each channel's values on its quantity's axis, and the panels its plot shows. */
interface Strip {
    row: number;
    alpha: boolean;
    channels: [Quantity, Values][];
    panels: Panel[];
    /** Whether the row runs over the true altitude rather than the apparent one. */
    real?: boolean;
}
const RED = "plot-line-red";
const GREEN = "plot-line-green";
const BLUE = "plot-line-blue";
const ALPHA = "air-table-alpha";
const one = (quantity: Quantity, values: Values, cls: string): Panel => ({ quantity, lines: [[values, cls]] });
const STRIPS: Record<string, Strip> = {
    "0rgb": {
        row: 0,
        alpha: false,
        channels: [0, 1, 2].map((c) => [TRANSMITTANCE, texel(0, c)]),
        panels: [{ quantity: TRANSMITTANCE, lines: [RED, GREEN, BLUE].map((cls, c) => [texel(0, c), cls]) }],
    },
    "0a": {
        row: 0,
        alpha: true,
        channels: [[BEND, texel(0, 3, toArcminutes)]],
        panels: [
            one(BEND, texel(0, 3, toArcminutes), ALPHA),
            {
                quantity: SPREAD,
                lines: [
                    [() => 0, GREEN],
                    [spread(0), RED],
                    [spread(2), BLUE],
                ],
            },
        ],
    },
    "1rgb": {
        row: 1,
        alpha: false,
        channels: [
            [AIRMASS, texel(1, 0)],
            [SEEING, texel(1, 1)],
            [{ ...DISTANCE, name: "the seeing's distance" }, texel(1, 2)],
        ],
        panels: [],
    },
    "1a": { row: 1, alpha: true, channels: [[{ ...WIND, name: "the seeing's wind" }, texel(1, 3)]], panels: [] },
    "2rgb": {
        row: 2,
        alpha: false,
        channels: [
            [SCINTILLATION, texel(2, 0)],
            [{ ...DISTANCE, name: "the scintillation's distance" }, texel(2, 1)],
            [{ ...WIND, name: "the scintillation's wind" }, texel(2, 2)],
        ],
        panels: [],
    },
    "2a": { row: 2, alpha: true, channels: [[DILUTION, texel(2, 3)]], panels: [] },
    "3r": { row: 3, alpha: false, channels: [[LIFT, texel(3, 0, toArcminutes)]], panels: [], real: true },
};
// Where a strip holds one quantity per channel, its plot is a panel per channel, each in the channel's hue.
for (const strip of Object.values(STRIPS)) {
    if (strip.panels.length > 0) continue;
    const hues = strip.alpha ? [ALPHA] : [RED, GREEN, BLUE];
    strip.panels = strip.channels.map(([quantity, values], c) => one(quantity, values, hues[c] ?? ALPHA));
}

const f = (n: number) => n.toFixed(2);
const encode = (v: number) => {
    const c = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};
/** A value as a share of its quantity's axis, clamped to it: linear, or by its logarithm. */
const share = ({ min, max, log }: Quantity, v: number) => {
    const s = log ? Math.log(Math.max(v, 1e-30) / min) / Math.log(max / min) : (v - min) / (max - min);
    return Math.min(Math.max(s, 0), 1);
};
const heightText = (m: number) => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);
const angleText = (deg: number) => {
    const a = Math.abs(deg);
    return a >= 1 ? `${deg.toFixed(2)}°` : a * 60 >= 1 ? `${(deg * 60).toFixed(1)}′` : `${(deg * 3600).toFixed(1)}″`;
};
const percent = (x: number) => `${x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)}%`;
/** Where an altitude falls in a row spaced by the fourth power, as a share of its width. */
const shareOf = (altitude: number, from: number, to: number) =>
    Math.sqrt(Math.sqrt(Math.min(Math.max((altitude - from) / Math.max(to - from, 1e-12), 0), 1)));

/** Paints a strip's canvas, 256 by 1 texels, scaled up by CSS without smoothing: rgb in their colors, alpha in gray,
 *  each value as a share of its quantity's axis, encoded as a texture viewer encodes linear values for the screen. */
function paintStrip(canvas: HTMLCanvasElement, strip: Strip, table: AirTable) {
    const image = new ImageData(AIR_TABLE_WIDTH, 1);
    for (let i = 0; i < AIR_TABLE_WIDTH; i++) {
        const shares = strip.channels.map(([quantity, values]) => encode(share(quantity, values(table, i))));
        const rgb = strip.alpha ? [shares[0], shares[0], shares[0]] : [0, 1, 2].map((c) => shares[c] ?? 0);
        image.data.set([...(rgb as number[]), 255], i * 4);
    }
    canvas.getContext("2d")?.putImageData(image, 0, 0);
}

/** The air table figure on `root`. Follows no moment and no place: the sliders set the Moon's altitude and the air. */
export function airTableFigure(root: HTMLElement) {
    const field = <T extends Element = HTMLElement>(name: string) => find<T>(`[data-field=${name}]`, root);
    const sliders = {
        altitude: field<HTMLInputElement>("altitude"),
        height: field<HTMLInputElement>("height"),
        temperature: field<HTMLInputElement>("temperature"),
    };
    const plotSvg = field<SVGSVGElement>("plot");
    const moonSvg = field<SVGSVGElement>("moon");
    const limbSvg = field<SVGSVGElement>("limb");
    const note = field("note");
    const limbName = field("limbName");
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-strip]")];
    const canvases = buttons.map((button) => find<HTMLCanvasElement>("canvas", button));
    let chosen = buttons.find((button) => button.getAttribute("aria-pressed") === "true")?.dataset.strip ?? "0a";
    const requestRender = onDemand(render, root);

    let table: AirTable | null = null;
    let key = "";
    let hover: number | null = null;

    function settings() {
        const heightM = 10 ** Number(sliders.height.value);
        const temperature = Number(sliders.temperature.value);
        if (`${heightM}/${temperature}` !== key) {
            const model = { ...DEFAULT_ATMOSPHERE_MODEL, refractivity: airRefractivity(temperature) };
            table = airTable(model, heightM);
            key = `${heightM}/${temperature}`;
            buttons.forEach((button, k) => {
                const strip = STRIPS[button.dataset.strip ?? ""];
                const canvas = canvases[k];
                if (strip && canvas) paintStrip(canvas, strip, table as AirTable);
            });
        }
        const t = table as AirTable;
        // A span fixed above the true horizon, not ended at the table's top: that drops from 90° to the air's upper
        // edge as the observer leaves the air, and the Moon would jump with it.
        const low = t.trueHorizon - 2.4 * MOON_RADIUS;
        const share = Number(sliders.altitude.value);
        return { table: t, heightM, temperature, altitude: low + 21 * share * share };
    }

    /** Where a point at a true altitude shows, per channel, in degrees: green lifted by the table, red and blue apart
     *  from it by the bend times the dilution, the air's squeeze. */
    function seen(t: AirTable, trueAltitude: number): [number, number, number] {
        const green = trueAltitude + airLift(t, trueAltitude);
        const air = airAt(t, Math.max(green, t.horizon));
        const spread = air ? air.bend * air.dilution : 0;
        return AIR_CHANNEL_DISPERSION.map((d) => green + (d - 1) * spread) as [number, number, number];
    }

    /** The Moon's outline, true and seen per channel, as points (x across, y up, in degrees), dense at both limbs. */
    function outlines(t: AirTable, center: number) {
        const count = 1024;
        const real: [number, number][] = [];
        const shown: [number, number][][] = [[], [], []];
        for (let k = 0; k < count; k++) {
            // Round from the bottom up the right and down the left, crowded at the bottom and the top, the limbs.
            const u = (2 * k) / count;
            const angle =
                -Math.PI / 2 +
                Math.PI * (u <= 1 ? (1 - Math.cos(Math.PI * u)) / 2 : 1 + (1 - Math.cos(Math.PI * (u - 1))) / 2);
            const [x, y] = [MOON_RADIUS * Math.cos(angle), center + MOON_RADIUS * Math.sin(angle)];
            real.push([x, y]);
            for (const [c, s] of seen(t, y).entries()) shown[c]?.push([x, s]);
        }
        return { real, shown };
    }

    function render() {
        const { table: t, heightM, temperature, altitude } = settings();
        const center = seen(t, altitude);
        const bottom = seen(t, altitude - MOON_RADIUS);
        const top = seen(t, altitude + MOON_RADIUS);
        const air = airAt(t, center[1]);
        // The close-up keeps to what shows: the lower limb, the upper one while the ground hides the lower.
        const limb = bottom[1] >= t.horizon ? "lower" : top[1] >= t.horizon ? "upper" : null;
        const close = limb === "lower" ? bottom[1] : limb === "upper" ? top[1] : t.horizon;
        const light = airAt(t, Math.max(center[1], t.horizon))?.transmittance ?? [0, 0, 0];
        const shape = outlines(t, altitude);
        drawPlot(t, altitude, center[1]);
        const span = Math.max(1.4, Math.abs(center[1] - altitude) + 0.8);
        drawMoon(t, span, altitude, center[1], close, shape, light);
        drawLimb(t, span / LIMB_FIELD, close, shape, light, limb === null);
        limbName.textContent = limb ?? "lower";

        field("altitudeValue").textContent = `${altitude.toFixed(1)}°`;
        field("heightValue").textContent = heightText(heightM);
        field("temperatureValue").textContent = `${temperature.toFixed(0)} °C`;
        for (const slider of Object.values(sliders)) paintRange(slider);

        if (hover !== null) {
            note.textContent = entryText(t, hover);
        } else if (top[1] < t.horizon) {
            note.textContent = "the ground hides the Moon";
        } else if (!air) {
            note.textContent = `the Moon's center below the horizon, lifted by ${angleText(center[1] - altitude)}`;
        } else {
            const squeeze = (top[1] - bottom[1]) / (2 * MOON_RADIUS);
            const [r, g] = air.transmittance;
            note.textContent =
                `seen at ${angleText(center[1])}, lifted by ${angleText(center[1] - altitude)}, squeezed to ` +
                `${squeeze.toFixed(2)} of its height; ${air.airmass.toFixed(1)} airmasses let through ${percent(r)} ` +
                `of its red, ${percent(g)} of its green; red and blue ${angleText(center[2] - center[0])} apart; ` +
                `a star there dimmed to ${air.dilution.toFixed(2)} by the squeeze`;
        }
    }

    function entryText(t: AirTable, i: number) {
        const value = (row: number, channel: number) => texel(row, channel)(t, i);
        const apparent = t.horizon + (t.top - t.horizon) * (i / LAST) ** 4;
        const real = t.trueHorizon + (t.trueTop - t.trueHorizon) * (i / LAST) ** 4;
        const transmittance = [0, 1, 2].map((c) => value(0, c).toFixed(3)).join(", ");
        const [red, blue] = [spread(0)(t, i), spread(2)(t, i)].map((v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}″`);
        return (
            `entry ${i}: seen at ${angleText(apparent)}, bent by ${angleText(value(0, 3) / DEG)}, red ${red} and blue ` +
            `${blue} from green; transmittance ${transmittance}, ${value(1, 0).toFixed(1)} airmasses, dilution ` +
            `${value(2, 3).toFixed(3)}; a body truly at ${angleText(real)} lifted by ${angleText(value(3, 0) / DEG)}`
        );
    }

    /** Where the strips' texels lie across the plot: the plot's x runs entry by entry under the same canvas. */
    function span() {
        const box = plotSvg.getBoundingClientRect();
        const strip = canvases[0]?.getBoundingClientRect();
        const left = strip && strip.width > 0 ? strip.left - box.left : 56;
        return { left, inner: strip && strip.width > 0 ? strip.width : Math.max(box.width - left, 100) };
    }

    /** The x of an altitude in a row running from `from` to `to`. */
    const texelX = (left: number, inner: number, altitude: number, from: number, to: number) =>
        left + (shareOf(altitude, from, to) * LAST + 0.5) * (inner / AIR_TABLE_WIDTH);

    function axis(left: number, inner: number, y: number, from: number, to: number, real: boolean) {
        const first = real ? "true horizon" : "horizon";
        let svg = svgText(left, y, first, "figure-label figure-anchor-start");
        let lastX = left + (real ? 84 : 50);
        for (const offset of OFFSETS) {
            if (from + offset >= to) break;
            const x = texelX(left, inner, from + offset, from, to);
            if (x - lastX < 32 || left + inner - x < 56) continue;
            lastX = x;
            svg += `<line x1="${f(x)}" y1="${f(y + 8)}" x2="${f(x)}" y2="${f(y + 12)}" class="air-table-tick"/>`;
            svg += svgText(x, y, `+${offset}°`, "figure-label");
        }
        svg += svgText(left + inner, y, to === 90 ? "zenith" : "top", "figure-label figure-anchor-end");
        return svg;
    }

    /** The chosen strip's values over its entries, a panel per quantity on its fixed axis, the Moon in the accent. */
    function drawPlot(t: AirTable, trueAltitude: number, seenAltitude: number) {
        const strip = STRIPS[chosen] ?? (STRIPS["0a"] as Strip);
        const width = plotSvg.clientWidth || 600;
        const { left, inner } = span();
        const xOf = (i: number) => left + (i + 0.5) * (inner / AIR_TABLE_WIDTH);
        const [from, to] = strip.real ? [t.trueHorizon, t.trueTop] : [t.horizon, t.top];
        const moon = strip.real ? trueAltitude : seenAltitude;
        const count = strip.panels.length;
        const height = (PLOT_HEIGHT - AXIS - count * TITLE - (count - 1) * PANEL_GAP) / count;
        let svg = axis(left, inner, 10, from, to, strip.real ?? false);
        let marks = "";
        strip.panels.forEach(({ quantity, lines }, p) => {
            const top = AXIS + p * (TITLE + height + PANEL_GAP) + TITLE;
            const yOf = (v: number) => top + height - share(quantity, v) * height;
            svg += svgText(left, top - TITLE / 2 - 1, quantity.name, "figure-label figure-anchor-start");
            for (const v of quantity.ticks) {
                const y = yOf(v);
                svg += `<line x1="${f(left)}" y1="${f(y)}" x2="${f(left + inner)}" y2="${f(y)}" class="figure-grid"/>`;
                svg += svgText(left - 6, y, quantity.label(v), "figure-grid-label");
            }
            for (const [values, cls] of lines) {
                const points = Array.from(
                    { length: AIR_TABLE_WIDTH },
                    (_, i) => `${f(xOf(i))},${f(yOf(values(t, i)))}`,
                );
                svg += `<polyline points="${points.join(" ")}" class="plot-line ${cls}"/>`;
            }
            if (moon >= from) {
                const x = texelX(left, inner, moon, from, to);
                marks += `<line x1="${f(x)}" y1="${f(top - 2)}" x2="${f(x)}" y2="${f(top + height + 2)}" class="air-table-mark"/>`;
            }
            if (hover !== null) {
                const x = xOf(hover);
                marks += `<line x1="${f(x)}" y1="${f(top)}" x2="${f(x)}" y2="${f(top + height)}" class="plot-mark"/>`;
            }
        });
        plotSvg.setAttribute("viewBox", `0 0 ${width} ${PLOT_HEIGHT}`);
        drawSvg(plotSvg, svg + marks, 1);
    }

    /** The Moon's three images, red, green and blue, added on black, each filled by the light that gets through. */
    function discs(shown: [number, number][][], transmittance: number[], toPx: (p: [number, number]) => string) {
        const peak = Math.max(...transmittance, 1e-6);
        return shown
            .map((points, c) => {
                const v = encode((MOON_ALBEDO * (transmittance[c] ?? 0)) / peak);
                const rgb = [0, 1, 2].map((k) => (k === c ? v : 0)).join(",");
                return `<polygon points="${points.map(toPx).join(" ")}" fill="rgb(${rgb})" class="air-table-channel"/>`;
            })
            .join("");
    }

    function ground(width: number, y: number, height: number) {
        if (y >= height) return "";
        const top = Math.max(y, 0);
        return (
            `<rect x="0" y="${f(top)}" width="${width}" height="${f(height - top)}" class="air-table-ground"/>` +
            (y >= 0 ? `<line x1="0" y1="${f(y)}" x2="${width}" y2="${f(y)}" class="figure-horizon"/>` : "")
        );
    }

    function drawMoon(
        t: AirTable,
        span: number,
        trueAltitude: number,
        seenAltitude: number,
        seenBottom: number,
        shape: ReturnType<typeof outlines>,
        transmittance: number[],
    ) {
        const width = moonSvg.clientWidth || 320;
        const height = moonSvg.clientHeight || 240;
        moonSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const middle = (seenAltitude + trueAltitude) / 2;
        const scale = height / span;
        const toPx = ([x, y]: [number, number]) =>
            `${f(width / 2 + x * scale)},${f(height / 2 - (y - middle) * scale)}`;
        const yOf = (altitude: number) => height / 2 - (altitude - middle) * scale;
        let svg = `<rect width="${width}" height="${height}" fill="#000"/>`;
        svg += `<g class="air-table-light">${discs(shape.shown, transmittance, toPx)}</g>`;
        svg += ground(width, yOf(t.horizon), height);
        svg += `<polygon points="${shape.real.map(toPx).join(" ")}" class="air-table-true"/>`;
        const box = LIMB_FIELD * scale;
        svg += `<rect x="${f(width / 2 - (box * 2) / 3)}" y="${f(yOf(seenBottom) - box / 2)}" width="${f((box * 4) / 3)}" height="${f(box)}" class="air-table-box"/>`;
        const trueY = yOf(trueAltitude);
        svg += svgText(width / 2 + MOON_RADIUS * scale + 8, trueY, "true place", "figure-label figure-anchor-start");
        // The altitude along the left edge, every 0.5° or 0.25°.
        const step = span > 1.6 ? 0.5 : 0.25;
        for (let a = Math.ceil((middle - span / 2) / step) * step; a <= middle + span / 2; a += step) {
            const y = yOf(a);
            if (y < 14 || y > height - 8) continue;
            svg += `<line x1="0" y1="${f(y)}" x2="6" y2="${f(y)}" class="air-table-tick air-table-render-tick"/>`;
            svg += svgText(10, y, `${Number(a.toFixed(2))}°`, "figure-label figure-anchor-start");
        }
        drawSvg(moonSvg, svg, 1);
    }

    function drawLimb(
        t: AirTable,
        magnified: number,
        seenBottom: number,
        shape: ReturnType<typeof outlines>,
        transmittance: number[],
        hidden: boolean,
    ) {
        const width = limbSvg.clientWidth || 320;
        const height = limbSvg.clientHeight || 240;
        limbSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const scale = height / LIMB_FIELD;
        const toPx = ([x, y]: [number, number]) =>
            `${f(width / 2 + x * scale)},${f(height / 2 - (y - seenBottom) * scale)}`;
        let svg = `<rect width="${width}" height="${height}" fill="#000"/>`;
        svg += `<g class="air-table-light">${discs(shape.shown, transmittance, toPx)}</g>`;
        svg += ground(width, height / 2 - (t.horizon - seenBottom) * scale, height);
        const bar = 10 / 3600;
        svg += `<line x1="12" y1="${height - 14}" x2="${f(12 + bar * scale)}" y2="${height - 14}" class="air-table-bar"/>`;
        svg += svgText(12 + (bar * scale) / 2, height - 26, "10″", "figure-label");
        svg += svgText(width - 10, height - 14, `${Math.round(magnified)}×`, "figure-label figure-anchor-end");
        if (hidden) svg += svgText(width / 2, height / 4, "behind the ground", "figure-label");
        drawSvg(limbSvg, svg, 1);
    }

    /** The entry under the pointer, by its x across the strips' canvases, which the plot shares. */
    const pointed = (event: PointerEvent) => {
        const strip = canvases[0]?.getBoundingClientRect();
        if (!strip || strip.width === 0) return null;
        const i = Math.floor(((event.clientX - strip.left) / strip.width) * AIR_TABLE_WIDTH);
        return i >= 0 && i < AIR_TABLE_WIDTH ? i : null;
    };
    const strips = find(".air-table-strips", root);
    for (const element of [plotSvg, strips] as HTMLElement[]) {
        element.addEventListener("pointermove", (event) => {
            const next = pointed(event);
            if (next !== hover) {
                hover = next;
                requestRender();
            }
        });
        element.addEventListener("pointerleave", () => {
            hover = null;
            requestRender();
        });
    }
    for (const button of buttons) {
        button.addEventListener("click", () => {
            chosen = button.dataset.strip ?? chosen;
            for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
            requestRender();
        });
    }
    for (const slider of Object.values(sliders)) slider.addEventListener("input", requestRender);
    new ResizeObserver(() => requestRender()).observe(root);
    requestRender();
}
