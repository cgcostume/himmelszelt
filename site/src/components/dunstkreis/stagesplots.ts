import { drawSvg, svgText } from "../sternzeit/figure";

// The transfer plot under the stages, drawn from what the GPU read back along the slice: light in cd/m² across, the
// code value it is written as up. Drawn in screen pixels, one SVG unit to a pixel.

/** One direction after the stages the plot needs: linear RGB in gamut, in cd/m², and the code values over 1. */
export type Stage = { rgb: number[]; pixel: number[] };

/** The slice from the horizon to the zenith below the Sun, the Sun, and the chain for a gray light, as read back. */
export type Readout = {
    slice: Stage[];
    sun: Stage;
    /** Whether any of the Sun's disc shows above the horizon. */
    sunShows: boolean;
    /** A gray light `stops` from white: linear and encoded both cut off at white, and the pixel. */
    curve: { stops: number; linear: number; encoded: number; pixel: number }[];
    /** The luminance that saturates, in cd/m². */
    white: number;
    ev: number;
    levels: number;
    toneCurve: string;
};

const LUMINANCE = [0.2126, 0.7152, 0.0722];
const luminance = (c: number[]) => LUMINANCE.reduce((sum, w, i) => sum + w * (c[i] ?? 0), 0);
const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const decode = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/**
 * A pixel's code value as one number on the gray curve's scale: its channels decoded to light, their luminance, and
 * that encoded again. A gray pixel keeps its code value; the luma of the encoded channels would put a saturated color
 * well below a gray of the same luminance.
 */
const codeOf = (pixel: number[]) => 255 * encode(luminance(pixel.map(decode)));
// The histograms' bars: 8 pixels wide, 2 apart.
const BAR_PITCH = 10;
const BAR_GAP = 2;
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const power = (n: number) =>
    `10${n < 0 ? "⁻" : ""}${[...String(Math.abs(n))].map((d) => SUPERSCRIPT[Number(d)]).join("")}`;
const f = (n: number) => n.toFixed(1);
const polyline = (points: [number, number][], cls: string) =>
    `<polyline class="${cls}" points="${points.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}"/>`;

/**
 * The slice's luminance in cd/m² across on a logarithmic scale and its code value up: the chain for a gray light as
 * curves, the slice as dots in its own colors, and how its points fall, counted along both axes.
 */
export function plot(svg: SVGSVGElement, r: Readout) {
    const width = svg.clientWidth;
    if (width <= 0) return;
    const narrow = width < 560;
    const parts: string[] = [];

    // The key above the plot, in one row where it fits.
    const key = [
        ["stages-curve stages-curve-tone", `${r.toneCurve}, ${Math.log2(r.levels)} bits`],
        ["stages-curve stages-curve-encoded", "sRGB encoded only"],
        ["stages-curve stages-curve-linear", "linear only"],
    ];
    const keyWidths = key.map(([, text]) => 34 + (text?.length ?? 0) * 6.6 + 16);
    const oneRow = keyWidths.reduce((a, b) => a + b, 0) < width - 44;
    const [x0, x1, y0] = [44, width - 12, (oneRow ? 1 : key.length) * 18 + 22];
    const y1 = y0 + (narrow ? 200 : 240);
    const height = y1 + 26;
    let kx = x0;
    key.forEach(([cls, text], i) => {
        const ky = 8 + (oneRow ? 0 : i * 18);
        parts.push(`<line class="${cls}" x1="${f(kx)}" x2="${f(kx + 26)}" y1="${ky}" y2="${ky}"/>`);
        parts.push(svgText(kx + 32, ky, text ?? "", "figure-label figure-anchor-start"));
        if (oneRow) kx += keyWidths[i] ?? 0;
    });

    // Across in stops, wide enough for the slice, the Sun, and ten stops below white to four above.
    const white = Math.log2(r.white);
    const stopsOf = (s: Stage) => Math.log2(Math.max(luminance(s.rgb), 1e-9));
    const lights = r.slice.map(stopsOf);
    const sun = stopsOf(r.sun);
    const lo = Math.floor(Math.min(white - 10, ...lights) - 1);
    const hi = Math.ceil(Math.max(white + 4, ...lights, ...(r.sunShows ? [sun] : [])) + 1);
    const x = (stops: number) => x0 + ((stops - lo) / (hi - lo)) * (x1 - x0);
    const y = (code: number) => y1 - (code / 255) * (y1 - y0);

    // How the slice's points fall along each axis, in bars a fixed number of pixels apart, however many fill it:
    // translucent, behind the curves and the dots, on one scale, since a bar covers the same pixels on either axis.
    const countIn = (length: number) => Math.max(1, Math.round(length / BAR_PITCH));
    const [nAcross, nUp] = [countIn(x1 - x0), countIn(y1 - y0)];
    const across = new Array(nAcross).fill(0);
    for (const l of lights)
        across[Math.min(nAcross - 1, Math.max(0, Math.floor(((l - lo) / (hi - lo)) * nAcross)))] += 1;
    const up = new Array(nUp).fill(0);
    for (const s of r.slice) up[Math.min(nUp - 1, Math.floor((codeOf(s.pixel) / 256) * nUp))] += 1;
    const most = Math.max(...across, ...up, 1);
    const [tall, long] = [(y1 - y0) * 0.22, (x1 - x0) * 0.16];
    const [pitchAcross, pitchUp] = [(x1 - x0) / nAcross, (y1 - y0) / nUp];
    across.forEach((count, b) => {
        if (!count) return;
        const h = (tall * count) / most;
        parts.push(
            `<rect class="stages-bar" x="${f(x0 + b * pitchAcross + BAR_GAP / 2)}" y="${f(y1 - h)}" width="${f(pitchAcross - BAR_GAP)}" height="${f(h)}"/>`,
        );
    });
    up.forEach((count, b) => {
        if (!count) return;
        const w = (long * count) / most;
        parts.push(
            `<rect class="stages-bar" x="${f(x1 - w)}" y="${f(y1 - (b + 1) * pitchUp + BAR_GAP / 2)}" width="${f(w)}" height="${f(pitchUp - BAR_GAP)}"/>`,
        );
    });

    for (const code of [0, 64, 128, 192, 255]) {
        parts.push(`<line class="stages-grid" x1="${x0}" x2="${x1}" y1="${f(y(code))}" y2="${f(y(code))}"/>`);
        parts.push(svgText(x0 - 5, y(code), code, "figure-label figure-anchor-end stages-tick"));
    }
    parts.push(`<text class="figure-label" transform="translate(8 ${f((y0 + y1) / 2)}) rotate(-90)">code value</text>`);
    // Decades of cd/m², labeled as often as they fit.
    const decade = Math.log2(10);
    const every = Math.ceil(36 / ((x1 - x0) / ((hi - lo) / decade)));
    for (let n = Math.ceil(lo / decade); n * decade <= hi; n++) {
        const dx = x(n * decade);
        parts.push(`<line class="stages-grid" x1="${f(dx)}" x2="${f(dx)}" y1="${y0}" y2="${y1}"/>`);
        if (n % every === 0 && dx < x1 - 40) parts.push(svgText(dx, height - 8, power(n), "figure-label stages-tick"));
    }
    parts.push(svgText(x1, height - 8, "cd/m²", "figure-label figure-anchor-end stages-tick"));
    parts.push(`<line class="stages-axis" x1="${x0}" x2="${x1}" y1="${y1}" y2="${y1}"/>`);

    // White, where the exposure puts it: every curve moves with it.
    parts.push(`<line class="stages-white" x1="${f(x(white))}" x2="${f(x(white))}" y1="${y0}" y2="${y1}"/>`);
    parts.push(svgText(x(white), y0 - 9, `white at EV ${r.ev.toFixed(1)}`, "figure-label"));

    // The chain for a gray light, held flat beyond the stops it was computed for.
    const curve = (value: (p: Readout["curve"][number]) => number, cls: string, steps = false) => {
        const inRange = r.curve.filter((p) => white + p.stops >= lo && white + p.stops <= hi);
        const firstPoint = inRange[0];
        const lastPoint = inRange[inRange.length - 1];
        if (!firstPoint || !lastPoint) return;
        const points: [number, number][] = [[x0, y(value(firstPoint) * 255)]];
        for (const p of inRange) {
            const [px, py] = [x(white + p.stops), y(value(p) * 255)];
            if (steps) points.push([px, points[points.length - 1]?.[1] ?? py]);
            points.push([px, py]);
        }
        points.push([x1, y(value(lastPoint) * 255)]);
        parts.push(polyline(points, cls));
    };
    curve((p) => p.linear, "stages-curve stages-curve-linear");
    curve((p) => p.encoded, "stages-curve stages-curve-encoded");
    curve((p) => p.pixel, "stages-curve stages-curve-tone", r.levels <= 16);

    // The slice, every other point, in the colors it is written as; horizon, zenith and Sun larger and named.
    const color = (s: Stage) => `rgb(${s.pixel.map((c) => Math.round(c * 255)).join(" ")})`;
    const point = (s: Stage) => [x(stopsOf(s)), y(codeOf(s.pixel))] as const;
    r.slice.forEach((s, i) => {
        if (i % 2) return;
        const [px, py] = point(s);
        parts.push(`<circle cx="${f(px)}" cy="${f(py)}" r="2.5" style="fill: ${color(s)}"/>`);
    });
    const named: [Stage | undefined, string][] = [
        [r.slice[0], "horizon"],
        [r.slice[r.slice.length - 1], "zenith"],
        [r.sunShows ? r.sun : undefined, "Sun"],
    ];
    for (const [s, name] of named) {
        if (!s) continue;
        const [px, py] = point(s);
        // The zenith, usually the darkest, named on its left, the others on their right unless they are at the edge.
        const left = name === "zenith" ? px > x0 + 60 : px > x1 - 60;
        const ly = py - 10 < y0 + 4 ? py + 13 : py - 11;
        const anchor = left ? "figure-anchor-end" : "figure-anchor-start";
        parts.push(`<circle cx="${f(px)}" cy="${f(py)}" r="5" style="fill: ${color(s)}"/>`);
        parts.push(svgText(px + (left ? -7 : 7), ly, name, `figure-note ${anchor}`));
    }

    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", String(height));
    drawSvg(svg, parts.join(""), 1);
}
