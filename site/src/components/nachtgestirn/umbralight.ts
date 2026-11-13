import { MOON_RADIUS_KM, typicalUmbra, umbraLightAt } from "@himmelszelt/nachtgestirn";
import { eclipse, fromJulianDay, julianEphemerisDay, moon, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, svgText } from "../sternzeit/figure";
import { julianDayOf } from "./place";
import { onUmbraTable, umbraTable } from "./renderer";
import { directSunlight } from "./shadow";

// The shadow's size and distance of one eclipse, New Year's Eve 2028's, so the axis stays put whatever else moves.
const JDE = julianEphemerisDay(fromJulianDay(julianDayOf("2028-12-31T16:52Z")));
const SHADOW = eclipse.lunar(JDE);
const DISTANCE_KM = moon.distance(JDE);
const SUN_RADIUS = (sun.apparentAngularDiameter(JDE) / 2) * (Math.PI / 180);
// The axis from the shadow's middle to well past the penumbra's widest edge, in km.
const REACH = 9000;
const BOTTOM = -18;
// The plot, then the strips under it: their exposures in stops over the sunlit Moon's, and their sizes in CSS px.
const PLOT = { height: 196, top: 28, bottom: 22, left: 44, right: 8 };
// The last as open as the deep umbra needs to show its color unclipped, some 14 stops under the sunlit Moon.
const STOPS = [0, 5, 10, 13];
const STRIP = { gap: 10, height: 20, between: 3 };
// A white surface in full sunlight exposed a little under white, so it still shows as a surface.
const SUNLIT = 0.75;

const f = (n: number) => n.toFixed(1);
const encode = (v: number) => {
    const c = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};

/**
 * The umbra light figure on `root`: what of the sunlight reaches the Moon by the distance from the shadow's axis, the
 * Sun's disc Earth leaves plus what its air bends in, as a plot in stops and as strips at four exposures, with the
 * Moon's disc laid across both. Follows no moment: the slider stands for sternzeit's `axisOffsetKm`.
 */
export function umbraLightFigure(root: HTMLElement) {
    const plot = find<SVGSVGElement>("[data-field=plot]", root);
    const strips = find<HTMLCanvasElement>("[data-field=strips]", root);
    const overlay = find<SVGSVGElement>("[data-field=overlay]", root);
    const slider = find<HTMLInputElement>("[data-field=offset]", root);
    const value = find("[data-field=offsetValue]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const stripsHeight = STOPS.length * STRIP.height + (STOPS.length - 1) * STRIP.between;

    function render() {
        const table = tables();
        if (!table) return;
        const width = root.clientWidth || 600;
        const inner = width - PLOT.left - PLOT.right;
        const x = (km: number) => PLOT.left + (km / REACH) * inner;
        const y = (s: number) => PLOT.top + (Math.max(s, BOTTOM) / BOTTOM) * (PLOT.height - PLOT.top - PLOT.bottom);
        const stops = (v: number) => Math.log2(Math.max(v, 1e-9));
        const { umbraRadiusKm: umbra, penumbraRadiusKm: penumbra } = SHADOW;
        // The typical umbra until this eclipse's own is integrated over dunstkreis' air.
        const light = umbraTable(table.luts.model, umbra, penumbra, DISTANCE_KM) ?? typicalUmbra();
        const at = (km: number) => {
            const direct = directSunlight(km, DISTANCE_KM, SUN_RADIUS);
            return umbraLightAt(light, km, penumbra).map((a) => Math.max(direct + a, 0));
        };

        // The plot: the grid in stops, the three channels, the shadow's edges.
        plot.setAttribute("viewBox", `0 0 ${width} ${PLOT.height}`);
        let svg = "";
        for (let s = 0; s >= BOTTOM; s -= 3) {
            svg += `<line x1="${f(PLOT.left)}" y1="${f(y(s))}" x2="${f(width - PLOT.right)}" y2="${f(y(s))}" class="figure-grid"/>`;
            svg += svgText(PLOT.left - 6, y(s), s === BOTTOM ? `≤${s}` : `${s}`, "figure-grid-label figure-anchor-end");
        }
        for (const km of [0, 2000, 4000, 6000, 8000]) {
            svg += svgText(
                x(km),
                PLOT.height - 6,
                km === 0 ? "axis" : `${km.toLocaleString("en-US")} km`,
                "figure-label",
            );
        }
        const samples = Array.from({ length: 361 }, (_, i) => {
            const km = (i / 360) * REACH;
            return { km, light: at(km) };
        });
        for (const [channel, cls] of [
            [2, "plot-line-blue"],
            [1, "plot-line-green"],
            [0, "plot-line-red"],
        ] as const) {
            // Solid above the plot's floor, dashed along it where the channel is darker still or none at all: so red a
            // light has no blue in sRGB, its blue negative and taken as none.
            let run: string[] = [];
            let low: boolean | null = null;
            const flush = () => {
                if (run.length > 1) {
                    const dash = low ? ' stroke-dasharray="2 4"' : "";
                    svg += `<polyline points="${run.join(" ")}" class="plot-line ${cls}"${dash}/>`;
                }
            };
            for (const sample of samples) {
                const s = stops(sample.light[channel] ?? 0);
                const point = `${f(x(sample.km))},${f(y(s))}`;
                if (low !== null && s <= BOTTOM !== low) {
                    run.push(point);
                    flush();
                    run = [];
                }
                low = s <= BOTTOM;
                run.push(point);
            }
            flush();
        }
        drawSvg(plot, svg, 1);

        // The strips: the light on a white surface, a row per exposure, as a linear sRGB image clipped at white.
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(inner * dpr));
        const rowPx = Math.round(STRIP.height * dpr);
        const gapPx = Math.round(STRIP.between * dpr);
        const h = STOPS.length * rowPx + (STOPS.length - 1) * gapPx;
        Object.assign(strips.style, { marginLeft: `${PLOT.left}px`, width: `${inner}px`, height: `${stripsHeight}px` });
        if (strips.width !== w || strips.height !== h) Object.assign(strips, { width: w, height: h });
        const context = strips.getContext("2d");
        if (context) {
            const image = context.createImageData(w, h);
            const column = Array.from({ length: w }, (_, i) => at(((i + 0.5) / w) * REACH));
            STOPS.forEach((s, row) => {
                const gain = SUNLIT * 2 ** s;
                for (let i = 0; i < w; i++) {
                    const c = column[i] ?? [0, 0, 0];
                    const rgb = [encode((c[0] ?? 0) * gain), encode((c[1] ?? 0) * gain), encode((c[2] ?? 0) * gain)];
                    for (let j = row * (rowPx + gapPx); j < row * (rowPx + gapPx) + rowPx; j++) {
                        const k = (j * w + i) * 4;
                        image.data.set([rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, 255], k);
                    }
                }
            });
            context.putImageData(image, 0, 0);
        }

        // Over both: the shadow's edges, the strips' exposures, and the Moon's disc where the slider puts it.
        const height = PLOT.height + STRIP.gap + stripsHeight;
        overlay.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const top = PLOT.top;
        const stripTop = PLOT.height + STRIP.gap;
        let marks = "";
        STOPS.forEach((s, row) => {
            const cy = stripTop + row * (STRIP.height + STRIP.between) + STRIP.height / 2;
            marks += svgText(PLOT.left - 6, cy, s === 0 ? "sunlit" : `+${s}`, "figure-grid-label figure-anchor-end");
        });
        for (const [km, name] of [
            [umbra, "umbra"],
            [penumbra, "penumbra"],
        ] as const) {
            marks += `<line x1="${f(x(km))}" y1="${f(top)}" x2="${f(x(km))}" y2="${f(height)}" class="plot-mark"/>`;
            marks += svgText(x(km) - 6, top + 10, name, "figure-label figure-anchor-end");
        }
        const center = Number(slider.value);
        const [from, to] = [Math.max(center - MOON_RADIUS_KM, 0), Math.min(center + MOON_RADIUS_KM, REACH)];
        marks += `<rect x="${f(x(from))}" y="${f(top)}" width="${f(x(to) - x(from))}" height="${f(height - top)}" class="umbra-light-moon"/>`;
        marks += `<line x1="${f(x(center))}" y1="${f(top)}" x2="${f(x(center))}" y2="${f(height)}" class="umbra-light-center"/>`;
        marks += svgText((x(from) + x(to)) / 2, top - 12, "the Moon", "figure-label");
        drawSvg(overlay, marks, 1);

        value.textContent = `${center.toLocaleString("en-US")} km`;
        paintRange(slider);
        // What the disc spans, its near and far edge, in stops of the sunlight, by luminance.
        const lum = (c: number[]) => 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
        const near = stops(lum(at(Math.abs(center - MOON_RADIUS_KM))));
        const far = stops(lum(at(center + MOON_RADIUS_KM)));
        const depth = (umbra + MOON_RADIUS_KM - center) / (2 * MOON_RADIUS_KM);
        const where =
            depth >= 1
                ? "wholly in the umbra"
                : depth > 0
                  ? `${Math.round(depth * 100)}% in the umbra`
                  : "outside the umbra";
        note.textContent = `the Moon ${where}, its edge nearest the axis ${near.toFixed(1)} stops, its far edge ${far.toFixed(1)} stops`;
    }

    slider.addEventListener("input", requestRender);
    onTables(requestRender);
    onUmbraTable(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
