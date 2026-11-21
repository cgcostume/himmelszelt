import type { AirTable } from "@himmelszelt/dunstkreis";
import {
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

// The air table texel by texel, and what it does to the Moon low down: lifted, squeezed, dimmed, its colors spread.

const DEG = Math.PI / 180;
const LAST = AIR_TABLE_WIDTH - 1;
const MOON_RADIUS = 0.259;
// How much more or less than green the air bends red and blue: `DK_AIR_DISPERSION` in `wgsl.air`.
const DISPERSION = [0.9964, 1, 1.0078] as const;
const MOON_ALBEDO = 0.9;
const GUTTER = 132;
const STRIPE = 14;
const BAND_GAP = 8;
const AXIS = 30;
// The close-up's field, in degrees: 2.4 arcminutes high.
const LIMB_FIELD = 0.04;

type Scale = "unit" | "max" | "log";
interface Stripe {
    row: number;
    channel: number;
    name: string;
    scale: Scale;
}
const STRIPES: Stripe[][] = [
    [
        { row: 0, channel: 0, name: "transmittance", scale: "unit" },
        { row: 0, channel: 1, name: "", scale: "unit" },
        { row: 0, channel: 2, name: "", scale: "unit" },
        { row: 0, channel: 3, name: "bend", scale: "max" },
    ],
    [
        { row: 1, channel: 0, name: "airmass", scale: "log" },
        { row: 1, channel: 1, name: "seeing", scale: "log" },
        { row: 1, channel: 2, name: "its distance", scale: "log" },
        { row: 1, channel: 3, name: "its wind", scale: "max" },
    ],
    [
        { row: 2, channel: 0, name: "scintillation", scale: "log" },
        { row: 2, channel: 1, name: "its distance", scale: "log" },
        { row: 2, channel: 2, name: "its wind", scale: "max" },
        { row: 2, channel: 3, name: "dilution", scale: "unit" },
    ],
    [{ row: 3, channel: 0, name: "lift", scale: "max" }],
    [{ row: 4, channel: 0, name: "range", scale: "unit" }],
];
const LETTERS = ["r", "g", "b", "a"];
const OFFSETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 45];

const f = (n: number) => n.toFixed(2);
const encode = (v: number) => {
    const c = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
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

/** One band of the table, a row's four channels as stripes, as a PNG data URL scaled up without smoothing. */
function bandImage(table: AirTable, stripes: Stripe[]): string {
    const rows = stripes.length;
    const small = Object.assign(document.createElement("canvas"), { width: AIR_TABLE_WIDTH, height: rows });
    const image = new ImageData(AIR_TABLE_WIDTH, rows);
    stripes.forEach(({ row, channel, scale }, s) => {
        const at = (i: number) => table.data[(row * AIR_TABLE_WIDTH + i) * 4 + channel] as number;
        let [low, high] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
        const value = (i: number) => (scale === "log" ? Math.log(Math.max(at(i), 1e-9)) : at(i));
        for (let i = 0; i < AIR_TABLE_WIDTH; i++) [low, high] = [Math.min(low, value(i)), Math.max(high, value(i))];
        if (scale === "max") low = Math.min(low, 0);
        for (let i = 0; i < AIR_TABLE_WIDTH; i++) {
            const used = row < 4 || i < (channel === 0 ? 2 : 1);
            let v = scale === "unit" ? at(i) : (value(i) - low) / Math.max(high - low, 1e-12);
            if (row === 4) v = used ? 0.5 : 0;
            const k = (s * AIR_TABLE_WIDTH + i) * 4;
            const c = encode(v);
            // Each channel in its own color, alpha in gray, as a texture viewer shows them.
            const gray = channel === 3 || row === 4;
            image.data[k] = gray || channel === 0 ? c : 0;
            image.data[k + 1] = gray || channel === 1 ? c : 0;
            image.data[k + 2] = gray || channel === 2 ? c : 0;
            image.data[k + 3] = 255;
        }
    });
    small.getContext("2d")?.putImageData(image, 0, 0);
    const big = Object.assign(document.createElement("canvas"), { width: AIR_TABLE_WIDTH * 4, height: rows * 8 });
    const context = big.getContext("2d");
    if (!context) return "";
    context.imageSmoothingEnabled = false;
    context.drawImage(small, 0, 0, big.width, big.height);
    return big.toDataURL("image/png");
}

/** The air table figure on `root`. Follows no moment and no place: the sliders set the Moon's altitude and the air. */
export function airTableFigure(root: HTMLElement) {
    const field = <T extends Element = HTMLElement>(name: string) => find<T>(`[data-field=${name}]`, root);
    const sliders = {
        altitude: field<HTMLInputElement>("altitude"),
        height: field<HTMLInputElement>("height"),
        temperature: field<HTMLInputElement>("temperature"),
    };
    const texels = field<SVGSVGElement>("texels");
    const moonSvg = field<SVGSVGElement>("moon");
    const limbSvg = field<SVGSVGElement>("limb");
    const note = field("note");
    const limbName = field("limbName");
    const requestRender = onDemand(render, root);

    let table: AirTable | null = null;
    let key = "";
    let bands: string[] = [];
    let hover: number | null = null;

    function settings() {
        const heightM = 10 ** Number(sliders.height.value);
        const temperature = Number(sliders.temperature.value);
        if (`${heightM}/${temperature}` !== key) {
            const model = { ...DEFAULT_ATMOSPHERE_MODEL, refractivity: airRefractivity(temperature) };
            table = airTable(model, heightM);
            key = `${heightM}/${temperature}`;
            bands = (STRIPES as Stripe[][]).map((stripes) => bandImage(table as AirTable, stripes));
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
        return [0, 1, 2].map((c) => green + ((DISPERSION[c] as number) - 1) * spread) as [number, number, number];
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
        drawTexels(t, altitude, center[1]);
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
        const value = (row: number, channel: number) => t.data[(row * AIR_TABLE_WIDTH + i) * 4 + channel] as number;
        const apparent = t.horizon + (t.top - t.horizon) * (i / LAST) ** 4;
        const real = t.trueHorizon + (t.trueTop - t.trueHorizon) * (i / LAST) ** 4;
        const transmittance = [0, 1, 2].map((c) => value(0, c).toFixed(3)).join(", ");
        return (
            `entry ${i}: seen at ${angleText(apparent)}, bent by ${angleText(value(0, 3) / DEG)}, transmittance ` +
            `${transmittance}, ${value(1, 0).toFixed(1)} airmasses, dilution ${value(2, 3).toFixed(3)}; ` +
            `a body truly at ${angleText(real)} lifted by ${angleText(value(3, 0) / DEG)}`
        );
    }

    /** The x of an altitude in a row running from `from` to `to`, in the image's span. */
    const texelX = (left: number, width: number, altitude: number, from: number, to: number) =>
        left + (shareOf(altitude, from, to) * LAST + 0.5) * (width / AIR_TABLE_WIDTH);

    function axis(left: number, width: number, y: number, from: number, to: number, words: string, above: boolean) {
        let svg = "";
        svg += svgText(left, y, "horizon", "figure-label figure-anchor-start");
        let lastX = left + 50;
        for (const offset of OFFSETS) {
            if (from + offset >= to) break;
            const x = texelX(left, width, from + offset, from, to);
            if (x - lastX < 32 || left + width - x < 34) continue;
            lastX = x;
            svg += `<line x1="${f(x)}" y1="${f(y + (above ? 8 : -8))}" x2="${f(x)}" y2="${f(y + (above ? 12 : -12))}" class="air-table-tick"/>`;
            svg += svgText(x, y, `${offset}°`, "figure-label");
        }
        svg += svgText(left + width, y, to === 90 ? "zenith" : "top", "figure-label figure-anchor-end");
        svg += svgText(left - 10, y, words, "figure-label figure-anchor-end");
        return svg;
    }

    function drawTexels(t: AirTable, trueAltitude: number, seenAltitude: number) {
        const width = texels.clientWidth || 600;
        const left = GUTTER;
        const inner = width - left - 4;
        let y = AXIS;
        let svg = axis(left, inner, 12, t.horizon, t.top, "apparent", true);
        const marks: string[] = [];
        STRIPES.forEach((stripes, band) => {
            const height = stripes.length * STRIPE;
            const href = bands[band] ?? "";
            svg += `<image href="${href}" x="${left}" y="${y}" width="${f(inner)}" height="${height}" preserveAspectRatio="none" class="air-table-image"/>`;
            svg += svgText(4, y + STRIPE / 2, `${band}`, "figure-label figure-anchor-start air-table-row");
            stripes.forEach(({ channel, name, row }, s) => {
                const yy = y + s * STRIPE + STRIPE / 2;
                if (name) svg += svgText(left - (row === 4 ? 40 : 20), yy, name, "figure-label figure-anchor-end");
                const letters = row === 4 ? "rgba" : (LETTERS[channel] ?? "");
                svg += svgText(left - 6, yy, letters, `figure-label figure-anchor-end air-table-${letters}`);
            });
            if (band === 3) svg += svgText(left + inner - 6, y + STRIPE / 2, "g, b, a unused", "air-table-inside");
            if (band === 4) {
                const words = "texel 0: horizons, tops; 1: height";
                svg += svgText(left + 10, y + STRIPE / 2, words, "air-table-inside air-table-inside-start");
            }
            const x =
                band === 3
                    ? texelX(left, inner, trueAltitude, t.trueHorizon, t.trueTop)
                    : texelX(left, inner, seenAltitude, t.horizon, t.top);
            if (band < 4 && seenAltitude >= t.horizon) {
                marks.push(
                    `<line x1="${f(x)}" y1="${y - 2}" x2="${f(x)}" y2="${y + height + 2}" class="air-table-mark"/>`,
                );
            }
            if (hover !== null && band < 4) {
                const hx = left + (hover + 0.5) * (inner / AIR_TABLE_WIDTH);
                marks.push(`<line x1="${f(hx)}" y1="${y}" x2="${f(hx)}" y2="${y + height}" class="air-table-hover"/>`);
            }
            y += height + (band === 3 ? AXIS : BAND_GAP);
            if (band === 3) svg += axis(left, inner, y - AXIS / 2 - 1, t.trueHorizon, t.trueTop, "true", false);
        });
        const height = y - BAND_GAP + 2;
        texels.setAttribute("viewBox", `0 0 ${width} ${height}`);
        texels.style.height = `${height}px`;
        drawSvg(texels, svg + marks.join(""), 1);
        texels.dataset.left = String(left);
        texels.dataset.inner = String(inner);
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

    texels.addEventListener("pointermove", (event) => {
        const left = Number(texels.dataset.left);
        const inner = Number(texels.dataset.inner);
        const x = event.clientX - texels.getBoundingClientRect().left;
        const i = Math.floor(((x - left) / inner) * AIR_TABLE_WIDTH);
        const next = i >= 0 && i < AIR_TABLE_WIDTH ? i : null;
        if (next !== hover) {
            hover = next;
            requestRender();
        }
    });
    texels.addEventListener("pointerleave", () => {
        hover = null;
        requestRender();
    });
    for (const slider of Object.values(sliders)) slider.addEventListener("input", requestRender);
    new ResizeObserver(() => requestRender()).observe(root);
    requestRender();
}
