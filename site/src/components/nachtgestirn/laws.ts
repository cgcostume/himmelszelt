import { ev100ForLuminance, moonEV100, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { onChange, state } from "../sternzeit/state";
import { discLight, LAWS, type Law } from "./lobes";
import { measured, roloHolds } from "./measured";
import { moonAt, type ToneCurveName } from "./renderer";
import { saveFigure } from "./snapshot";
import { createTiles } from "./tiles";

const PI = Math.PI;
const DEG = PI / 180;
/** A plain daytime sky behind the discs, in cd/m²: a clear blue some way from the Sun. */
export const DAY_SKY: readonly [number, number, number] = [2600, 4000, 6500];
// The tiles a fifth taller than wide, room under each disc for its name and readout; on a phone more, for the switches
// over the top row.
const TILE_ASPECT = 1.2;
const NARROW_TILE_ASPECT = 1.3;

export { LAWS, type Law } from "./lobes";

// A rotation about `axis` by `angle` radians, as a column major 3 x 3 matrix, and its use.
export function rotation(axis: Vec3, angle: number): Float32Array {
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
export const apply = (m: Float32Array, v: Vec3): Vec3 => [
    (m[0] ?? 0) * v[0] + (m[3] ?? 0) * v[1] + (m[6] ?? 0) * v[2],
    (m[1] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[7] ?? 0) * v[2],
    (m[2] ?? 0) * v[0] + (m[5] ?? 0) * v[1] + (m[8] ?? 0) * v[2],
];
/** a times b, both column major. */
export function multiply(a: Float32Array, b: Float32Array): Float32Array {
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
export function transpose(m: Float32Array): Float32Array {
    return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]].map((v) => v ?? 0));
}
export const normalize = (v: Vec3): Vec3 => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
};
export const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The Moon `m` as seen from where a viewer orbited to, by `yaw` about the Moon's north axis and `pitch` over it, in
 * radians, the Sun staying where it is: the Moon and the Sun turn together the other way, the line of sight staying as
 * it is, so the phase changes with the viewer's place. With `sunAt`, the Sun is put at that phase angle instead, in
 * radians, east of the viewer about the Moon's north axis: the terminator a meridian, the lit side on the right.
 */
export function orbited(m: ReturnType<typeof moonAt>, yaw: number, pitch: number, sunAt?: number) {
    const o = m.orientation;
    // The Moon's north pole in the viewer's frame: the row of the orientation that maps to the body's z.
    const north = normalize([o[2] ?? 0, o[5] ?? 0, o[8] ?? 1]);
    const toViewer: Vec3 = [-m.trueDirection[0], -m.trueDirection[1], -m.trueDirection[2]];
    const right = normalize(cross(m.trueDirection, north));
    const r = multiply(rotation(right, pitch), rotation(north, yaw));
    let moonSunDirection = apply(r, m.moonSunDirection);
    if (sunAt !== undefined) {
        // The viewer's direction with the pole's part taken out, turned about the pole by the phase angle.
        const level = normalize(cross(cross(north, toViewer), north));
        moonSunDirection = apply(rotation(north, -sunAt), level);
    }
    const cosG = Math.max(-1, Math.min(1, dot(moonSunDirection, toViewer)));
    return {
        ...m,
        moonSunDirection,
        orientation: multiply(o, transpose(r)),
        // Earth turns with the Moon and the Sun: earthshine stays on the half of the Moon turned to it.
        earthDirection: apply(r, toViewer),
        phaseAngle: Math.acos(cosG) / DEG,
        lit: (1 + cosG) / 2,
    };
}

/** Replaces a figure's canvas by a note that WebGPU is missing. */
export function noGpu(canvas: HTMLCanvasElement) {
    const error = document.createElement("p");
    error.className = "tiles-empty";
    error.textContent = shared.error ?? "WebGPU is not available here.";
    canvas.replaceWith(error);
}

/**
 * The reflectance laws figure on `root`: the Moon under Lambert's law, Oren-Nayar's and Hapke's side by side. Dragging
 * carries the viewer around the Moon, the Sun staying where it is: towards it, into the crescent, or behind it, where
 * the Sun stands at the viewer's back and the surge is at its fullest.
 */
export function lawsFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const metered = find("[data-field=metered]", root);
    const mapped = find("[data-field=map]", root);
    const deviation = find("[data-field=deviation]", root);
    const day = find("[data-field=day]", root);
    const offs = [...root.querySelectorAll<HTMLElement>("[data-off]")];
    const pressed = (button: HTMLElement) => button.getAttribute("aria-pressed") === "true";
    const requestRender = onDemand(render, root);
    const narrow = window.matchMedia("(max-width: 40rem)");
    // How far the viewer has been dragged around the Moon: about its north axis, and up or down over it, in radians.
    const orbit = { yaw: 0, pitch: 0 };
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);

    function render() {
        const table = tables();
        if (!table) return;
        const real = moonAt(state.jd, { ...state, geocentric: true }, table.luts.model);
        const m = orbit.yaw === 0 && orbit.pitch === 0 ? real : orbited(real, orbit.yaw, orbit.pitch);
        const width = root.clientWidth || 600;
        // Two by two on a phone, as the side views under them.
        const columns = narrow.matches ? 2 : LAWS.length;
        const tilePx = Math.round((width / columns) * Math.min(window.devicePixelRatio || 1, 2));
        // One exposure for all four, so the light seen is the light each law gives: Lambert's disc darker than Hapke's.
        // Metered on the measured Moon's lit part, or the full Moon's whatever the phase, a quarter Moon then darker.
        const meter = pressed(metered);
        const withMap = pressed(mapped);
        // Held against Hapke's law, which follows the measured Moon within a quarter of a stop over the month.
        const compare = pressed(deviation) ? ("hapke2012" as const) : null;
        // By day the sky sets the exposure where it is brighter than the Moon, still one for all four.
        const byDay = pressed(day);
        const moonEV = meter ? moonEV100(m.phaseAngle, m.lit) : moonEV100(0, 1);
        const sky = 0.2126 * DAY_SKY[0] + 0.7152 * DAY_SKY[1] + 0.0722 * DAY_SKY[2];
        const ev100 = byDay ? Math.max(moonEV, ev100ForLuminance(sky)) : moonEV;
        canvas.parentElement?.style.setProperty("--count", String(columns));
        canvas.parentElement?.style.setProperty("--rows", String(LAWS.length / columns));
        const layout = {
            count: columns,
            rows: LAWS.length / columns,
            width: tilePx,
            height: Math.round(tilePx * (narrow.matches ? NARROW_TILE_ASPECT : TILE_ASPECT)),
        };
        tiles?.draw({ ...layout, degreesAcross: m.geocentricDiameter * 1.4 }, (i) => ({
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100,
            albedo: withMap,
            relief: withMap,
            shadows: withMap,
            compare,
            earthshine: true,
            eclipse: false,
            law: LAWS[i] ?? "hapke2012",
            nightVision: false,
            ...(byDay ? { background: DAY_SKY } : {}),
        }));
        // Each law's light of the whole disc against the measured Moon's at this phase angle, plain discs, in stops:
        // against ROLO up to 97°, against Allen's law beyond, said so.
        const moon = measured(m.phaseAngle);
        const by = roloHolds(m.phaseAngle) ? "" : ", Allen";
        for (const element of offs) {
            const off = Math.log2(Math.max(discLight(element.dataset.off as Law, m.phaseAngle * DEG), 1e-9) / moon);
            element.textContent = `${off >= 0 ? "+" : ""}${off.toFixed(1)} stops${by}`;
        }
    }

    // The discs as drawn, with their names, in one PNG.
    find("[data-field=download]", root).addEventListener("click", () =>
        saveFigure(root, canvas, render, { texts: root.querySelectorAll<HTMLElement>(".disc-labels .tiles-name") }),
    );

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
    for (const button of [metered, mapped, deviation, day]) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(!pressed(button)));
            requestRender();
        });
    }
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
