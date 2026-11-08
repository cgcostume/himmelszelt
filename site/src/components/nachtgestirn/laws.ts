import { moonEV100, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { onChange, state } from "../sternzeit/state";
import { lobeLight, onLobeLight } from "./lobes";
import { moonAt, type ToneCurveName } from "./renderer";
import { createTiles, tileFrame } from "./tiles";

const PI = Math.PI;
const DEG = PI / 180;
export type Law = "lambert" | "orenNayar" | "metallicRoughness" | "hapke";
/** The laws in the order the figures show them: by their distance from the measured Moon, the farthest first. */
export const LAWS: readonly Law[] = ["lambert", "metallicRoughness", "orenNayar", "hapke"];

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
    const note = find("[data-field=note]", root);
    const metered = find("[data-field=metered]", root);
    const mapped = find("[data-field=map]", root);
    const deviation = find("[data-field=deviation]", root);
    const outline = find<SVGSVGElement>("[data-field=outline]", root);
    const pressed = (button: HTMLElement) => button.getAttribute("aria-pressed") === "true";
    const requestRender = onDemand(render, root);
    // How far the viewer has been dragged around the Moon: about its north axis, and up or down over it, in radians.
    const orbit = { yaw: 0, pitch: 0 };
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);

    function render() {
        const table = tables();
        if (!table) return;
        const real = moonAt(state.jd, state, table.luts.model);
        const m = orbit.yaw === 0 && orbit.pitch === 0 ? real : orbited(real, orbit.yaw, orbit.pitch);
        const width = root.clientWidth || 600;
        const tilePx = Math.round((width / LAWS.length) * Math.min(window.devicePixelRatio || 1, 2));
        // All at the full Moon's exposure whatever the phase, so the light seen is the light each law gives: a quarter
        // Moon darker than a full one, and Lambert's disc darker than Hapke's.
        const perDisc = pressed(metered);
        const withMap = pressed(mapped);
        // Held against Hapke's law, which follows the measured Moon within a quarter of a stop over the month.
        const compare = pressed(deviation) ? ("hapke" as const) : null;
        const ev100 = perDisc ? null : moonEV100(0, 1);
        tiles?.draw({ count: LAWS.length, width: tilePx, degreesAcross: m.geocentricDiameter * 1.4 }, (i) => ({
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
            law: LAWS[i] ?? "hapke",
            nightVision: false,
        }));
        drawOutline(m, width);
        const where =
            orbit.yaw === 0 && orbit.pitch === 0
                ? "from Earth"
                : `${(Math.abs(orbit.yaw) / DEG).toFixed(0)}° ${orbit.yaw > 0 ? "east" : "west"} and ${(Math.abs(orbit.pitch) / DEG).toFixed(0)}° ${orbit.pitch > 0 ? "over" : "under"} Earth's line of sight`;
        note.textContent = `seen ${where}: phase angle ${m.phaseAngle.toFixed(1)}°, ${(m.lit * 100).toFixed(0)}% lit, ${perDisc ? "each disc metered on its lit part" : "all four at the full Moon's exposure"}`;
    }

    // Where on the disc the Sun stands at the lobes' angle from the normal: a small circle about the point under the
    // Sun, its near half, the same on all four discs.
    let last: { m: ReturnType<typeof moonAt>; width: number } | null = null;
    function drawOutline(m: ReturnType<typeof moonAt>, width: number) {
        last = { m, width };
        const tile = width / LAWS.length;
        const height = outline.parentElement?.clientHeight || tile;
        outline.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const { right, up, toward } = tileFrame(m);
        const sun = m.moonSunDirection;
        const helper: Vec3 = Math.abs(sun[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const a = normalize(cross(sun, helper));
        const b = cross(sun, a);
        const angle = Math.abs(lobeLight.angle);
        const radius = tile / 2.8;
        // The view frame's toward points back at the viewer.
        const toViewer = toward;
        let svg = "";
        for (let i = 0; i < LAWS.length; i++) {
            const [cx, cy] = [tile * (i + 0.5), height / 2];
            let path = "";
            let pen = false;
            for (let k = 0; k <= 180; k++) {
                const t = (k / 180) * 2 * PI;
                const p = [0, 1, 2].map(
                    (c) =>
                        (sun[c] ?? 0) * Math.cos(angle) +
                        ((a[c] ?? 0) * Math.cos(t) + (b[c] ?? 0) * Math.sin(t)) * Math.sin(angle),
                );
                const seen = p.reduce((sum, v, c) => sum + v * (toViewer[c] ?? 0), 0) > 0;
                if (!seen) {
                    pen = false;
                    continue;
                }
                const x = cx + p.reduce((sum, v, c) => sum + v * (right[c] ?? 0), 0) * radius;
                const y = cy - p.reduce((sum, v, c) => sum + v * (up[c] ?? 0), 0) * radius;
                path += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
                pen = true;
            }
            if (path) svg += `<path d="${path}" class="laws-outline-under"/><path d="${path}" class="laws-outline"/>`;
        }
        outline.innerHTML = svg;
    }
    onLobeLight(() => {
        if (last) drawOutline(last.m, last.width);
    });

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
    for (const button of [metered, mapped, deviation]) {
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
