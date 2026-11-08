import { moonEV100 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { onChange, state } from "../sternzeit/state";
import { noGpu, orbited } from "./laws";
import { moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { createTiles } from "./tiles";

const DEG = Math.PI / 180;
// How far the view zooms in, from the whole disc with a margin round it.
// How far the view zooms out; in, no further than a texel of the map to a pixel at the disc's middle.
const ZOOM_MIN = 0.2;
// Rays per pixel, the same whether the Moon turns or rests, so the picture never changes when it is let go: as many as
// a budget of rays a frame allows the canvas, a power of two from 8 to 64, twice as many along the terminator.
const RAY_BUDGET = 80e6;
function raysFor(pixels: number) {
    const samples = 2 ** Math.max(3, Math.min(6, Math.floor(Math.log2(RAY_BUDGET / Math.max(pixels, 1)))));
    return { samples, terminatorSamples: Math.min(64, samples * 2) };
}

/**
 * The globe figure on `root`: the Moon at the chosen moment, large and square, from Earth's center at first; dragging
 * carries the viewer around it, the Sun and Earth staying where they are, so the far side and the phases come round,
 * and earthshine stays on the half turned to Earth. Scrolling zooms in where the cursor is.
 */
export function globeFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    // The zoom, and where the middle of the view is off the disc's center, right and up, in disc radii.
    const view = { yaw: 0, pitch: 0, zoom: 1, x: 0, y: 0 };
    const panel = find(".tiles-panel", root);
    const fullscreen = find("[data-field=fullscreen]", root);
    // The view's width and height in disc radii: the disc fits the shorter side with a margin.
    const across = () => {
        const [w, h] = [panel.clientWidth || 1, panel.clientHeight || 1];
        const x = ((1.15 * 2) / view.zoom) * Math.max(1, w / h);
        return [x, (x * h) / w] as const;
    };
    const moved = requestRender;
    // The most zoom: a texel of the 16K maps to a pixel at the disc's middle, whichever maps are loaded; the map shows
    // π times its width across.
    const zoomMax = () => {
        const texels = 16384 / Math.PI;
        const px =
            Math.min(panel.clientWidth, panel.clientHeight || panel.clientWidth) *
            Math.min(window.devicePixelRatio || 1, 2);
        return Math.max(1, (texels * 1.15) / Math.max(px, 1));
    };
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const resolution = mapResolutions(root, "large", requestRender);

    function render() {
        const table = tables();
        if (!table) return;
        const real = moonAt(state.jd, state, table.luts.model);
        view.zoom = Math.min(view.zoom, zoomMax());
        const m = view.yaw === 0 && view.pitch === 0 ? real : orbited(real, view.yaw, view.pitch);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const full = document.fullscreenElement === panel;
        const width = Math.round((full ? panel.clientWidth : root.clientWidth || 600) * ratio);
        const height = full ? Math.round(panel.clientHeight * ratio) : width;
        const radius = m.geocentricDiameter / 2;
        tiles?.draw({ count: 1, width, height, degreesAcross: across()[0] * radius }, () => ({
            ...raysFor(width * height),
            offset: [view.x * radius, view.y * radius] as const,
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: resolution(),
            // Set by the phase as the eye sees it lit, not metered from the image: no meter to lag a frame behind.
            ev100: moonEV100(m.phaseAngle, m.lit),
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: false,
            law: "hapke",
            nightVision: false,
        }));
        const where =
            view.yaw === 0 && view.pitch === 0
                ? "from Earth"
                : `${(Math.abs(view.yaw) / DEG).toFixed(0)}° ${view.yaw > 0 ? "east" : "west"} and ${(Math.abs(view.pitch) / DEG).toFixed(0)}° ${view.pitch > 0 ? "over" : "under"} Earth's line of sight`;
        note.textContent = `seen ${where}, ${view.zoom.toFixed(1)}× zoom: phase angle ${m.phaseAngle.toFixed(1)}°, ${(m.lit * 100).toFixed(0)}% lit, the ${RESOLUTION_NAMES[resolution()]}, exposed for the lit part`;
    }

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
        // A radian per disc radius on screen: the ground under the cursor follows it, whatever the zoom and the screen.
        const perPx = 1 / ((panel.clientWidth || 1) / across()[0]);
        view.yaw += (event.clientX - dragging.x) * perPx;
        view.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, view.pitch + (event.clientY - dragging.y) * perPx));
        dragging = { x: event.clientX, y: event.clientY };
        moved();
    });
    const release = () => {
        dragging = null;
        canvas.classList.remove("dragging");
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            // The point under the cursor stays under it: the middle moves towards it by what the view shrinks.
            const box = canvas.getBoundingClientRect();
            const cx = (event.clientX - box.left) / box.width - 0.5;
            const cy = 0.5 - (event.clientY - box.top) / box.height;
            const before = across();
            view.zoom = Math.max(ZOOM_MIN, Math.min(zoomMax(), view.zoom * Math.exp(-event.deltaY * 0.0015)));
            const after = across();
            // Back to the middle as it zooms out, and never further off than the limb.
            const limit = 1.1 * Math.max(0, Math.min(1, view.zoom - 1));
            view.x = Math.max(-limit, Math.min(limit, view.x + cx * (before[0] - after[0])));
            view.y = Math.max(-limit, Math.min(limit, view.y + cy * (before[1] - after[1])));
            moved();
        },
        { passive: false },
    );
    canvas.addEventListener("dblclick", () => {
        Object.assign(view, { yaw: 0, pitch: 0, zoom: 1, x: 0, y: 0 });
        requestRender();
    });
    fullscreen.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : panel.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () => {
        fullscreen.setAttribute("aria-pressed", String(document.fullscreenElement === panel));
        requestRender();
    });
    onChange(moved);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
