import { WHITE_POINTS } from "@himmelszelt/helldunkel";
import {
    linearSrgbFromChromaticity,
    planckianLocus,
    type Rgb,
    temperatureFromColorIndex,
    temperatureFromColorIndexApprox,
} from "@himmelszelt/sternenheer";
import locus from "../../data/cie1931-locus.json";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { escapeText } from "../sternzeit/figure";
import { starPicker } from "./starpicker";

type Formula = "ballesteros" | "jensen";
type Xy = readonly [number, number];

export const BV_MIN = -0.3;
export const BV_MAX = 2;
const TEMPERATURE: Record<Formula, (bv: number) => number> = {
    ballesteros: temperatureFromColorIndex,
    jensen: temperatureFromColorIndexApprox,
};
// The part of the chromaticity diagram the locus and its labels fill, magnified, and the whole diagram beside it.
const VIEW = { x0: 0.238, x1: 0.582, y0: 0.232, y1: 0.426 };
const WHOLE = { x0: -0.13, x1: 0.82, y0: -0.07, y1: 0.93 };
const SRGB: readonly Xy[] = [
    [0.64, 0.33],
    [0.3, 0.6],
    [0.15, 0.06],
];
const D65: Xy = WHITE_POINTS.D65;
const KELVIN_TICKS = [2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 25000];
const WAVELENGTH_LABELS = [460, 490, 500, 520, 560, 600];
const SPECTRUM = locus.points.map(([, x, y]) => [x, y] as Xy);

const f = (v: number) => v.toFixed(1);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The color of a chromaticity at unit luminance, scaled so its largest channel is 1, as CSS: its hue at full value. */
export function swatch(rgb: Rgb): string {
    const max = Math.max(rgb[0], rgb[1], rgb[2], 1e-6);
    const encode = (c: number) => {
        const v = clamp(c / max, 0, 1);
        return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    };
    return `rgb(${encode(rgb[0])} ${encode(rgb[1])} ${encode(rgb[2])})`;
}

export function starColor(bv: number, formula: Formula) {
    const kelvin = TEMPERATURE[formula](bv);
    const xy = planckianLocus(kelvin);
    return { kelvin, xy, rgb: linearSrgbFromChromaticity(xy) };
}

/** The strip's height in px, wherever the stars' colors are shown over B-V. */
export const BAND_HEIGHT = 6;

/**
 * The colors of stars over B-V as a strip for an SVG, by one formula: a bar with round ends from `x0` to `x1` at `y`,
 * filled by a gradient named `id` whose colors stand where `at` puts their B-V, from `from` to `to`, a stop every 0.05,
 * the end colors held beyond. The gradient goes into the SVG's defs.
 */
export function colorIndexBand(
    id: string,
    formula: Formula,
    span: { x0: number; x1: number; y: number; at: (bv: number) => number; from?: number; to?: number },
) {
    const { x0, x1, y, at, from = BV_MIN, to = BV_MAX } = span;
    const stops = Math.max(1, Math.round((to - from) / 0.05));
    let gradient = `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(at(from))}" x2="${f(at(to))}">`;
    for (let i = 0; i <= stops; i++) {
        const color = swatch(starColor(from + (i / stops) * (to - from), formula).rgb);
        gradient += `<stop offset="${(i / stops).toFixed(4)}" stop-color="${color}"/>`;
    }
    gradient += "</linearGradient>";
    const bar = `<rect x="${f(x0)}" y="${f(y)}" width="${f(x1 - x0)}" height="${BAND_HEIGHT}" rx="${BAND_HEIGHT / 2}" fill="url(#${id})"/>`;
    return { gradient, bar };
}

const number = (v: number, digits: number) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(digits);
const kelvinText = (k: number) => `${(Math.round(k / 10) * 10).toLocaleString("en-US")} K`;

/**
 * The color index figure on `root`: the Planckian locus magnified with the whole CIE 1931 diagram in its corner, the
 * two formulas' colors over B-V, and the marker the slider, a click on the strips or the locus, or a star moves along.
 */
export function colorIndexFigure(root: HTMLElement) {
    const whole = find<SVGSVGElement>("svg[data-field=whole]", root);
    const diagram = find<SVGSVGElement>("svg[data-field=diagram]", root);
    const band = find<SVGSVGElement>("svg[data-field=band]", root);
    const slider = find<HTMLInputElement>("input[data-field=bv]", root);
    const output = find("output[data-field=bvValue]", root);
    const picker = starPicker(find("[data-star-picker]", root));
    const stars = [...root.querySelectorAll<HTMLElement>("[data-star-picker] [data-bv]")];
    const cells = [...root.querySelectorAll<HTMLElement>("[data-cell]")];
    let bv = Number(slider.value);
    const requestRender = onDemand(render, root);
    // Where the last drawing put things, for picking: the diagram's scale and the band's.
    let toDiagram = (xy: Xy): Xy => xy;
    let bandSpan = { left: 0, right: 1 };

    function marker(xy: Xy, formula: Formula, fill: string) {
        const [x, y] = toDiagram(xy);
        return `<circle cx="${f(x)}" cy="${f(y)}" r="6" class="colorindex-marker colorindex-${formula}" style="fill: ${formula === "jensen" ? "none" : fill}"/>`;
    }

    const path = (points: readonly Xy[], map: (xy: Xy) => Xy, close = false) =>
        `M${points.map((p) => map(p).map(f).join(" ")).join("L")}${close ? "Z" : ""}`;
    const kelvins = Array.from({ length: 121 }, (_, i) => 1667 * (25000 / 1667) ** (i / 120));

    // (a) The whole diagram, the magnified part outlined in it.
    function drawWhole() {
        const width = whole.clientWidth || 200;
        const height = Math.round(width / ((WHOLE.x1 - WHOLE.x0) / (WHOLE.y1 - WHOLE.y0)));
        whole.setAttribute("viewBox", `0 0 ${width} ${height}`);
        whole.style.height = `${height}px`;
        const s = width / (WHOLE.x1 - WHOLE.x0);
        const toWhole = ([x, y]: Xy): Xy => [(x - WHOLE.x0) * s, height - (y - WHOLE.y0) * s];
        let svg = `<path d="${path(SPECTRUM, toWhole, true)}" class="colorindex-spectrum"/>`;
        svg += `<path d="${path(SRGB, toWhole, true)}" class="colorindex-gamut"/>`;
        svg += `<path d="${path(kelvins.map(planckianLocus), toWhole)}" class="colorindex-reach"/>`;
        const [vx0, vy0] = toWhole([VIEW.x0, VIEW.y1]);
        const [vx1, vy1] = toWhole([VIEW.x1, VIEW.y0]);
        svg += `<rect x="${f(vx0)}" y="${f(vy0)}" width="${f(vx1 - vx0)}" height="${f(vy1 - vy0)}" class="colorindex-view"/>`;
        // Each wavelength's label off the spectrum along its outward normal, its box a gap clear of the curve.
        if (width > 160) {
            const em = Number.parseFloat(getComputedStyle(whole).fontSize) || 13;
            const white = toWhole(D65);
            for (const nm of WAVELENGTH_LABELS) {
                const i = locus.points.findIndex(([w]) => w === nm);
                const [before, point, after] = [locus.points[i - 1], locus.points[i], locus.points[i + 1]];
                if (!before || !point || !after) continue;
                const [x, y] = toWhole([point[1], point[2]]);
                const a = toWhole([before[1], before[2]]);
                const b = toWhole([after[1], after[2]]);
                const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
                let [nx, ny] = [(b[1] - a[1]) / len, (a[0] - b[0]) / len];
                if (nx * (x - white[0]) + ny * (y - white[1]) < 0) [nx, ny] = [-nx, -ny];
                const reach = 4 + Math.abs(nx) * String(nm).length * em * 0.3 + Math.abs(ny) * em * 0.5;
                svg += `<text x="${f(x + nx * reach)}" y="${f(y + ny * reach)}" class="figure-label">${nm}</text>`;
            }
        }
        whole.innerHTML = svg;
    }

    // (b) The locus magnified, its temperatures, the white point and the gamut's edges.
    function drawDiagram() {
        const width = diagram.clientWidth || 400;
        const height = Math.round(width / ((VIEW.x1 - VIEW.x0) / (VIEW.y1 - VIEW.y0)));
        diagram.setAttribute("viewBox", `0 0 ${width} ${height}`);
        diagram.style.height = `${height}px`;
        const sx = width / (VIEW.x1 - VIEW.x0);
        toDiagram = ([x, y]) => [(x - VIEW.x0) * sx, height - (y - VIEW.y0) * sx];
        let svg = `<defs><clipPath id="colorindex-clip"><rect width="${width}" height="${height}"/></clipPath></defs>`;
        svg += `<g clip-path="url(#colorindex-clip)">`;
        svg += `<path d="${path(SRGB, toDiagram, true)}" class="colorindex-gamut"/>`;
        // The whole locus Kang et al. fit, thin, and the part the slider reaches by either formula over it.
        svg += `<path d="${path(kelvins.map(planckianLocus), toDiagram)}" class="colorindex-locus"/>`;
        const formulas: Formula[] = ["jensen", "ballesteros"];
        for (const formula of formulas) {
            const reach = Array.from(
                { length: 116 },
                (_, i) => starColor(BV_MIN + (i / 115) * (BV_MAX - BV_MIN), formula).xy,
            );
            svg += `<path d="${path(reach, toDiagram)}" class="colorindex-reach colorindex-reach-${formula}"/>`;
        }
        // Each temperature a tick across the locus, its label below and right of it along the normal, its box a gap
        // clear of the tick's end; none under a marker.
        const markers = [
            ...formulas.map((formula) => toDiagram(starColor(bv, formula).xy)),
            ...Object.values(WHITE_POINTS).map((xy) => toDiagram(xy)),
        ];
        const narrow = width < 420;
        const em = Number.parseFloat(getComputedStyle(diagram).fontSize) || 13;
        for (const k of KELVIN_TICKS) {
            if (narrow && (k === 2500 || k === 5000 || k === 15000 || k === 8000)) continue;
            const a = toDiagram(planckianLocus(k * 0.995));
            const b = toDiagram(planckianLocus(k * 1.005));
            const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
            const len = Math.hypot(dx, dy) || 1;
            const side = dx > 0 ? 1 : -1;
            const [nx, ny] = [(-dy / len) * side, (dx / len) * side];
            const [x, y] = toDiagram(planckianLocus(k));
            const label = `${k >= 10000 ? `${k / 1000}k` : k.toLocaleString("en-US")}${k === 25000 ? " K" : ""}`;
            const [halfW, halfH] = [label.length * em * 0.3, em * 0.5];
            const reach = 4 + 5 + Math.abs(nx) * halfW + Math.abs(ny) * halfH;
            const [lx, ly] = [x + nx * reach, y + ny * reach];
            if (markers.some(([mx, my]) => Math.hypot(mx - lx, my - ly) < halfW + 8 || Math.hypot(mx - x, my - y) < 8))
                continue;
            svg += `<line x1="${f(x - nx * 4)}" y1="${f(y - ny * 4)}" x2="${f(x + nx * 4)}" y2="${f(y + ny * 4)}" class="colorindex-tick"/>`;
            svg += `<text x="${f(lx)}" y="${f(ly)}" class="figure-label">${label}</text>`;
        }
        // The CIE's white points, each named above and left of it, off the side the temperatures are named on; E, just
        // under the locus, below and right of it instead.
        for (const [name, xy] of Object.entries(WHITE_POINTS)) {
            const [wx, wy] = toDiagram(xy);
            const [lx, ly, anchor] = name === "E" ? [wx + 6, wy + 9, "start"] : [wx - 7, wy - 9, "end"];
            svg += `<circle cx="${f(wx)}" cy="${f(wy)}" r="2.5" class="colorindex-white"/>`;
            svg += `<text x="${f(lx)}" y="${f(ly)}" class="figure-label figure-anchor-${anchor}">${name}</text>`;
        }
        // The gamut named where its edge from green to blue comes into the view at the top, clear of the inset.
        const edgeY = VIEW.y1 - 0.012;
        const [gx, gy] = toDiagram([0.15 + ((edgeY - 0.06) / (0.6 - 0.06)) * 0.15, edgeY]);
        svg += `<text x="${f(gx + 8)}" y="${f(gy)}" class="figure-label figure-anchor-start">sRGB</text>`;
        const now = starColor(bv, "ballesteros");
        svg += marker(starColor(bv, "jensen").xy, "jensen", "");
        svg += marker(now.xy, "ballesteros", swatch(now.rgb));
        svg += "</g>";
        diagram.innerHTML = svg;
    }

    // The two strips sit in a rail as wide as the slider's: their ends where the thumb's center stops at either end.
    function drawBand() {
        const width = band.clientWidth || 600;
        const rows: Formula[] = ["ballesteros", "jensen"];
        const stripH = BAND_HEIGHT;
        const rowH = 20;
        // The cursor's middle at either end of the slider (global.css).
        const thumb = 3;
        const left = thumb;
        const right = width - thumb;
        const top = 24;
        const height = top + rowH + stripH + 4;
        band.setAttribute("viewBox", `0 0 ${width} ${height}`);
        band.style.height = `${height}px`;
        bandSpan = { left, right };
        const at = (v: number) => left + ((v - BV_MIN) / (BV_MAX - BV_MIN)) * (right - left);
        const mx = at(bv);
        // The strips span the whole track, their colors where the thumb's center stands, the ends held beyond its reach.
        const strips = rows.map((formula, i) =>
            colorIndexBand(`colorindex-${formula}`, formula, { x0: 0, x1: width, y: top + i * rowH, at }),
        );
        let svg = `<defs>${strips.map((strip) => strip.gradient).join("")}</defs>`;
        rows.forEach((formula, i) => {
            const y = top + i * rowH;
            svg += strips[i]?.bar ?? "";
            svg += `<line x1="${f(mx)}" y1="${y - 3}" x2="${f(mx)}" y2="${y + stripH + 3}" class="colorindex-band-marker"/>`;
            const name = root.querySelector<HTMLElement>(`[data-strip=${formula}]`);
            if (name) name.style.top = `${y + stripH / 2}px`;
        });
        const kelvin = kelvinText(starColor(bv, "ballesteros").kelvin);
        // Centered over the tick, out past the strips at their ends, where the row is empty.
        svg += `<text x="${f(mx)}" y="${top - 11}" class="figure-note">${escapeText(kelvin)}</text>`;
        band.innerHTML = svg;
    }

    function drawNumbers() {
        for (const formula of ["ballesteros", "jensen"] as const) {
            const { kelvin, xy, rgb } = starColor(bv, formula);
            const values = [kelvinText(kelvin), xy[0].toFixed(3), xy[1].toFixed(3), ...rgb.map((c) => number(c, 2))];
            for (const cell of cells.filter((c) => c.dataset.cell?.startsWith(formula))) {
                const index = Number(cell.dataset.cell?.split(":")[1]);
                cell.textContent = values[index] ?? "";
            }
        }
        output.textContent = number(bv, 2);
        const step = Math.round(bv * 100);
        const at = (star: HTMLElement) => Math.round(Number(star.dataset.bv) * 100) === step;
        // Stars that share a B-V (Vega and Sirius, Zeta² Reticuli and Polaris): the one picked stays picked.
        const kept = stars.find((star) => star.dataset.value === picker.value && at(star));
        picker.value = (kept ?? stars.find(at))?.dataset.value ?? "";
    }

    function render() {
        drawWhole();
        drawDiagram();
        drawBand();
        drawNumbers();
    }

    function set(value: number) {
        bv = Math.round(clamp(value, BV_MIN, BV_MAX) * 100) / 100;
        slider.value = String(bv);
        paintRange(slider);
        requestRender();
    }

    slider.addEventListener("input", () => set(Number(slider.value)));
    picker.onPick((value) => set(Number(stars.find((star) => star.dataset.value === value)?.dataset.bv ?? bv)));

    // Dragging along the band, or along the locus, moves the marker: on the locus to the B-V whose point is nearest.
    const pick = (svg: SVGSVGElement, choose: (x: number, y: number) => number) => {
        const at = (event: PointerEvent) => {
            const box = svg.getBoundingClientRect();
            set(choose(event.clientX - box.left, event.clientY - box.top));
        };
        svg.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            svg.setPointerCapture(event.pointerId);
            at(event);
        });
        svg.addEventListener("pointermove", (event) => {
            if (svg.hasPointerCapture(event.pointerId)) at(event);
        });
    };
    pick(band, (x) => BV_MIN + ((x - bandSpan.left) / (bandSpan.right - bandSpan.left)) * (BV_MAX - BV_MIN));
    pick(diagram, (x, y) => {
        let best = bv;
        let nearest = Infinity;
        for (let v = BV_MIN; v <= BV_MAX + 1e-9; v += 0.01) {
            const [px, py] = toDiagram(starColor(v, "ballesteros").xy);
            const d = (px - x) ** 2 + (py - y) ** 2;
            if (d < nearest) [nearest, best] = [d, v];
        }
        return best;
    });

    new ResizeObserver(requestRender).observe(root);
    paintRange(slider);
    requestRender();
}
