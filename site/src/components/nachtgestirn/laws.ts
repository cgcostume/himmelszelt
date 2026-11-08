import { moonEV100, phaseLaw, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { drawSvg, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { moonAt, type ToneCurveName } from "./renderer";
import { createTiles } from "./tiles";

// Hapke's lunar law as surface.wgsl has it, for the disc's total light, and Lambert's.
const PI = Math.PI;
function retrodirective(g: number) {
    const h = 0.6;
    if (g < 1e-4) return 2;
    if (g >= PI / 2) return 1;
    const t = Math.tan(g);
    const e = Math.exp(-h / t);
    return 2 - (t / (2 * h)) * (1 - e) * (3 - e);
}
function scattering(g: number) {
    const c = Math.cos(g);
    return (Math.sin(g) + (PI - g) * c) / PI + 0.1 * (1 - c / 2) ** 2;
}
const hapke = (mu0: number, mu: number, g: number) =>
    (((2 * mu0) / Math.max(mu0 + mu, 1e-4)) * ((retrodirective(g) * scattering(g)) / (2 * scattering(0)))) / PI;
const lambert = (mu0: number) => mu0 / PI;

/**
 * The light the whole disc sends towards the viewer at a phase angle in radians, relative to a flat disc of the same
 * normal albedo seen and lit straight on: the reflectance summed over the disc's projected area, where a Lambert
 * sphere gives two thirds at full and Hapke's law one.
 */
function discLight(law: "hapke" | "lambert", g: number) {
    const N = 120;
    const s = [Math.sin(g), 0, Math.cos(g)];
    let sum = 0;
    for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
            const x = ((i + 0.5) / N) * 2 - 1;
            const y = ((j + 0.5) / N) * 2 - 1;
            const rr = x * x + y * y;
            if (rr >= 1) continue;
            const z = Math.sqrt(1 - rr);
            const mu0 = x * (s[0] ?? 0) + z * (s[2] ?? 0);
            if (mu0 <= 0) continue;
            sum += law === "hapke" ? hapke(mu0, z, g) : lambert(mu0);
        }
    }
    return (sum * 4) / (N * N);
}

const DEG = PI / 180;
const STEP = 2;

// A rotation about `axis` by `angle` radians, as a column major 3 x 3 matrix, and its use.
function rotation(axis: Vec3, angle: number): Float32Array {
    const [x, y, z] = axis;
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    const t = 1 - c;
    return new Float32Array([
        t * x * x + c,
        t * x * y + s * z,
        t * x * z - s * y,
        t * x * y - s * z,
        t * y * y + c,
        t * y * z + s * x,
        t * x * z + s * y,
        t * y * z - s * x,
        t * z * z + c,
    ]);
}
const apply = (m: Float32Array, v: Vec3): Vec3 => [
    (m[0] ?? 0) * v[0] + (m[3] ?? 0) * v[1] + (m[6] ?? 0) * v[2],
    (m[1] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[7] ?? 0) * v[2],
    (m[2] ?? 0) * v[0] + (m[5] ?? 0) * v[1] + (m[8] ?? 0) * v[2],
];
/** a times b, both column major. */
function multiply(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(9);
    for (let col = 0; col < 3; col++) {
        for (let row = 0; row < 3; row++) {
            let sum = 0;
            for (let k = 0; k < 3; k++) sum += (a[k * 3 + row] ?? 0) * (b[col * 3 + k] ?? 0);
            out[col * 3 + row] = sum;
        }
    }
    return out;
}
function transpose(m: Float32Array): Float32Array {
    return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]].map((v) => v ?? 0));
}
const normalize = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const curves = {
    hapke: Array.from({ length: 180 / STEP + 1 }, (_, i) => discLight("hapke", i * STEP * DEG)),
    lambert: Array.from({ length: 180 / STEP + 1 }, (_, i) => discLight("lambert", i * STEP * DEG)),
    measured: Array.from({ length: 180 / STEP + 1 }, (_, i) => phaseLaw(i * STEP)),
};
const stops = (value: number) => Math.log2(Math.max(value, 1e-9));
// The plot, phase angle across and stops down to this many below a full Moon.
const BOTTOM = -12;
const MARGIN = { top: 10, bottom: 22, left: 34, right: 8 };
const f = (n: number) => n.toFixed(1);

/**
 * The reflectance laws figure on `root`: Hapke's and Lambert's Moon side by side, and the light of each over the phase
 * angle. Dragging carries the viewer around the Moon, the Sun staying where it is: towards it, into the crescent, or
 * behind it, where the Sun stands at the viewer's back and the surge is at its fullest.
 */
export function lawsFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const plot = find<SVGSVGElement>(".tiles-plot > svg", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    // How far the viewer has been dragged around the Moon: about its north axis, and up or down over it, in radians.
    const orbit = { yaw: 0, pitch: 0 };
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) {
        const error = document.createElement("p");
        error.className = "tiles-empty";
        error.textContent = shared.error ?? "WebGPU is not available here.";
        canvas.replaceWith(error);
    }

    function render() {
        const table = tables();
        if (!table) return;
        const real = moonAt(state.jd, state, table.luts.model);
        const m = orbited(real);
        const width = root.clientWidth || 600;
        const tilePx = Math.round((Math.min(width, 640) / 2) * Math.min(window.devicePixelRatio || 1, 2));
        // Both at the full Moon's exposure whatever the phase, so the light the curves count is the light seen: a quarter
        // Moon darker than a full one, and Lambert's disc darker than Hapke's.
        const ev100 = moonEV100(0, 1);
        tiles?.draw(2, tilePx, m.geocentricDiameter * 1.15, (i) => ({
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: false,
            eclipse: false,
            law: i === 0 ? "hapke" : "lambert",
            nightVision: false,
        }));
        renderPlot(m.phaseAngle);
        const at = (c: number[]) => stops(c[Math.round(m.phaseAngle / STEP)] ?? 1);
        note.textContent =
            `phase angle ${m.phaseAngle.toFixed(1)}°: Hapke ${at(curves.hapke).toFixed(1)}, ` +
            `Lambert ${at(curves.lambert).toFixed(1)}, measured ${at(curves.measured).toFixed(1)} stops below a full Moon`;
    }

    /**
     * The Moon as seen from where the viewer was dragged to: the viewer orbits, so the Moon and the Sun turn together
     * the other way, about the Moon's north axis and about the screen's right, the line of sight staying as it is.
     */
    function orbited(m: ReturnType<typeof moonAt>) {
        if (orbit.yaw === 0 && orbit.pitch === 0) return m;
        const o = m.orientation;
        // The Moon's north pole in the viewer's frame: the row of the orientation that maps to the body's z.
        const north = normalize([o[2] ?? 0, o[5] ?? 0, o[8] ?? 1]);
        const right = normalize(cross(m.trueDirection, north));
        const r = multiply(rotation(right, orbit.pitch), rotation(north, orbit.yaw));
        const moonSunDirection = apply(r, m.moonSunDirection);
        const toViewer: Vec3 = [-m.trueDirection[0], -m.trueDirection[1], -m.trueDirection[2]];
        const cosG = Math.max(
            -1,
            Math.min(
                1,
                moonSunDirection[0] * toViewer[0] +
                    moonSunDirection[1] * toViewer[1] +
                    moonSunDirection[2] * toViewer[2],
            ),
        );
        const phaseAngle = Math.acos(cosG) / DEG;
        return {
            ...m,
            moonSunDirection,
            orientation: multiply(o, transpose(r)),
            phaseAngle,
            lit: (1 + cosG) / 2,
        };
    }

    function renderPlot(phaseAngle: number) {
        const width = plot.clientWidth || 600;
        const height = plot.clientHeight || 180;
        plot.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const x = (deg: number) => MARGIN.left + (deg / 180) * (width - MARGIN.left - MARGIN.right);
        const y = (s: number) => MARGIN.top + (Math.max(s, BOTTOM) / BOTTOM) * (height - MARGIN.top - MARGIN.bottom);
        let svg = "";
        for (let s = 0; s >= BOTTOM; s -= 2) {
            svg += `<line x1="${f(MARGIN.left)}" y1="${f(y(s))}" x2="${f(width - MARGIN.right)}" y2="${f(y(s))}" class="figure-grid"/>`;
            svg += svgText(MARGIN.left - 6, y(s), s === 0 ? "0" : `${s}`, "figure-grid-label figure-anchor-end");
        }
        for (const deg of [0, 45, 90, 135, 180]) {
            svg += svgText(x(deg), height - 6, `${deg}°`, `figure-label${deg === 180 ? " figure-anchor-end" : ""}`);
        }
        const line = (values: number[], cls: string) =>
            `<polyline points="${values.map((v, i) => `${f(x(i * STEP))},${f(y(stops(v)))}`).join(" ")}" class="plot-line ${cls}"/>`;
        svg += line(curves.measured, "plot-line-measured");
        svg += line(curves.lambert, "plot-line-lambert");
        svg += line(curves.hapke, "");
        svg += svgText(x(100), y(stops(curves.hapke[50] ?? 1)) + 14, "Hapke", "figure-note figure-anchor-start");
        svg += svgText(x(100), y(stops(curves.lambert[50] ?? 1)) - 8, "Lambert", "figure-note figure-anchor-start");
        svg += svgText(x(150), y(stops(curves.measured[75] ?? 1)) + 14, "measured", "figure-note figure-anchor-end");
        // The chosen moment's phase angle, and each law's light there.
        const px = x(phaseAngle);
        svg += `<line x1="${f(px)}" y1="${f(MARGIN.top)}" x2="${f(px)}" y2="${f(y(BOTTOM))}" class="plot-now"/>`;
        const i = Math.round(phaseAngle / STEP);
        for (const c of [curves.hapke, curves.lambert, curves.measured]) {
            svg += `<circle cx="${f(px)}" cy="${f(y(stops(c[i] ?? 1)))}" r="3" class="plot-dot"/>`;
        }
        drawSvg(plot, svg, 1);
    }

    // Dragging carries the viewer around the Moon; a double click brings it back to Earth.
    let dragging: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging = { x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        const perPx = DEG * 0.4;
        orbit.yaw += (event.clientX - dragging.x) * perPx;
        // The point under the cursor follows it: a drag down turns the front of the Moon down.
        orbit.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, orbit.pitch + (event.clientY - dragging.y) * perPx));
        dragging = { x: event.clientX, y: event.clientY };
        requestRender();
    });
    const release = () => {
        dragging = null;
        canvas.classList.remove("dragging");
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("dblclick", () => {
        orbit.yaw = 0;
        orbit.pitch = 0;
        requestRender();
    });
    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
