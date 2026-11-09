import { phaseLaw } from "@himmelszelt/nachtgestirn";
import { fromJulianDay, julianEphemerisDay, moon } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { discLight, LAWS, type Law } from "./lobes";
import { rolo, roloHolds } from "./measured";

const DEG = Math.PI / 180;
// The curves' step in degrees, finer towards 180° where they bend fastest.
const STEP = 2.5;
const FINEST_STEP = 0.25;
const angles: number[] = [];
for (let a = 0; a < 180; a += Math.max(FINEST_STEP, Math.min(STEP, (180 - a) / 8))) angles.push(a);
angles.push(97, 180);
angles.sort((a, b) => a - b);
const stops = (value: number) => Math.log2(Math.max(value, 1e-9));
// Each law's light over the phase angle, and the Moon's as measured, ROLO's and Allen's, in stops below a full Moon:
// computed on first use, ROLO's only up to 97°.
type Curve = Law | "rolo" | "allen";
let curves: Record<Curve, number[]> | null = null;
function allCurves() {
    curves ??= {
        ...(Object.fromEntries(LAWS.map((law) => [law, angles.map((a) => stops(discLight(law, a * DEG)))])) as Record<
            Law,
            number[]
        >),
        rolo: angles.map((a) => (roloHolds(a) ? stops(rolo(a)) : Number.NaN)),
        allen: angles.map((a) => stops(phaseLaw(a))),
    };
    return curves;
}
// A curve's stops at any phase angle, between the two angles it was computed at either side.
function stopsAt(values: number[], deg: number) {
    let i = 1;
    while (i < angles.length - 1 && (angles[i] ?? 180) < deg) i++;
    const [a0, a1] = [angles[i - 1] ?? 0, angles[i] ?? 180];
    const t = Math.max(0, Math.min(1, (deg - a0) / (a1 - a0 || 1)));
    return (values[i - 1] ?? 0) * (1 - t) + (values[i] ?? 0) * t;
}
// Stops down to this many below a full Moon, the plot's margins, in CSS pixels.
const BOTTOM = -14;
const MARGIN = { top: 18, bottom: 22, left: 30, right: 12 };
const NAMES: Record<Curve, string> = {
    lambert: "Lambert",
    orenNayar: "Oren-Nayar",
    hapke: "Hapke 1963",
    hapke2012: "Hapke 2012",
    rolo: "ROLO",
    allen: "Allen",
};
const f = (n: number) => n.toFixed(1);

/**
 * The phase law figure on `root`: the light a plain disc sends to the viewer over the phase angle under each law, against
 * the Moon's measured one, in stops below a full Moon; the readouts at the pointer, else at the real Moon's phase angle.
 */
export function phasesFigure(root: HTMLElement) {
    const plot = find<SVGSVGElement>(".tiles-plot > svg", root);
    let cursor: number | null = null;
    const requestRender = onDemand(render, root);
    const x = (deg: number, width: number) => MARGIN.left + (deg / 180) * (width - MARGIN.left - MARGIN.right);

    function render() {
        const series = allCurves();
        const width = plot.clientWidth || 600;
        const height = plot.clientHeight || 220;
        plot.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const px = (deg: number) => x(deg, width);
        const y = (s: number) => MARGIN.top + (Math.max(s, BOTTOM) / BOTTOM) * (height - MARGIN.top - MARGIN.bottom);
        // A curve ends where it falls through the plot's floor, rather than running along it.
        const points = (values: number[]) =>
            values.flatMap((v, i) => (v >= BOTTOM ? [`${f(px(angles[i] ?? 180))},${f(y(v))}`] : [])).join(" ");
        let svg = "";
        for (let s = 0; s >= BOTTOM; s -= 2) {
            svg += `<line x1="${f(px(0))}" y1="${f(y(s))}" x2="${f(px(180))}" y2="${f(y(s))}" class="figure-grid"/>`;
            svg += svgText(px(0) - 6, y(s), `${s}`, "figure-grid-label figure-anchor-end");
        }
        for (let deg = 0; deg <= 180; deg += 30) {
            if (cursor !== null && Math.abs(deg - cursor) < 8) continue;
            svg += svgText(px(deg), height - 6, `${deg}°`, "figure-label");
        }
        svg += `<polyline points="${points(series.allen)}" class="plot-line plot-line-allen"/>`;
        svg += `<polyline points="${points(series.rolo)}" class="plot-line plot-line-measured"/>`;
        for (const law of LAWS) svg += `<polyline points="${points(series[law])}" class="plot-line plot-line-${law}"/>`;
        // Now: where the real Moon is in its phases at the page's moment.
        const now = moon.phaseAngle(julianEphemerisDay(fromJulianDay(state.jd)));
        svg += `<line x1="${f(px(now))}" y1="${f(MARGIN.top)}" x2="${f(px(now))}" y2="${f(y(BOTTOM))}" class="plot-now"/>`;
        svg += svgText(px(now), MARGIN.top - 4, `now ${now.toFixed(0)}°`, "figure-note plot-now-label");
        const at = cursor ?? now;
        if (cursor !== null) {
            svg += `<line x1="${f(px(cursor))}" y1="${f(MARGIN.top)}" x2="${f(px(cursor))}" y2="${f(y(BOTTOM))}" class="plot-cursor"/>`;
            svg += svgText(px(cursor), height - 6, `${cursor.toFixed(0)}°`, "figure-label plot-cursor-label");
        }
        // A dot on each curve, and each curve's stops beside the line in a fixed order, one to each row between the grid
        // lines, the lowest rows where there is more room below the curves, else the highest; left of the line near the
        // plot's right end.
        // ROLO's readout only where it holds.
        const order: Curve[] = [...LAWS, ...(roloHolds(at) ? (["rolo"] as const) : []), "allen"];
        const values = order.map((law) =>
            law === "rolo" ? stops(rolo(at)) : law === "allen" ? stops(phaseLaw(at)) : stopsAt(series[law], at),
        );
        for (const [i, value] of values.entries()) {
            if (value >= BOTTOM)
                svg += `<circle cx="${f(px(at))}" cy="${f(y(value))}" r="2.5" class="plot-dot plot-dot-${order[i]}"/>`;
        }
        const left = at > 120;
        const over = Math.min(...values.map(y)) - MARGIN.top;
        const under = y(BOTTOM) - Math.max(...values.map(y));
        const first = under >= over ? BOTTOM + 2 * order.length - 1 : -1;
        for (const [i, law] of order.entries()) {
            svg += svgText(
                px(at) + (left ? -6 : 6),
                y(first - 2 * i),
                `${NAMES[law]} ${(values[i] ?? 0).toFixed(1)}`,
                `figure-note ${left ? "figure-anchor-end" : "figure-anchor-start"} plot-label-${law}`,
            );
        }
        drawSvg(plot, svg, 1);
    }

    plot.addEventListener("pointermove", (event) => {
        const box = plot.getBoundingClientRect();
        const deg = ((event.clientX - box.left - MARGIN.left) / (box.width - MARGIN.left - MARGIN.right)) * 180;
        cursor = Math.max(0, Math.min(180, deg));
        requestRender();
    });
    plot.addEventListener("pointerleave", () => {
        cursor = null;
        requestRender();
    });
    onChange(requestRender);
    new ResizeObserver(requestRender).observe(plot);
    requestRender();
}
