import { type Vec3, viewFrame } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import {
    configureCanvas,
    display,
    gpuDevice,
    onDisplay,
    onTables,
    SDR,
    gpu as shared,
    tables,
} from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { type MoonViewFrame, moonView } from "../sternzeit/moonview";
import { state } from "../sternzeit/state";
import { createMoonRenderer, inverseViewProjection, moonAt, type ToneCurveName } from "./renderer";

const DEG = Math.PI / 180;

/**
 * The textured Moon view on `root`, a `figure[data-moon-face]`: sternzeit's overlay redrawn as ever, and behind it the
 * Moon as nachtgestirn renders it, at the overlay's scale and turn. Without WebGPU, the overlay draws its own disc.
 */
export function moonFace(root: HTMLElement) {
    const view = find(".moon-view", root);
    const canvas = find<HTMLCanvasElement>("canvas", view);
    const context = shared.error ? null : canvas.getContext("webgpu");
    if (!context) {
        canvas.remove();
        moonView(view);
        return;
    }
    configureCanvas(context, SDR);
    const device = gpuDevice();
    let frame: MoonViewFrame | null = null;
    const requestRender = onDemand(render, root);
    const renderer = createMoonRenderer(device, requestRender);

    function render() {
        const table = tables();
        if (!table || !frame || !context) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(frame.widthPx * dpr));
        const height = Math.max(1, Math.round(frame.heightPx * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        const m = moonAt(state.jd, state, table.luts.model, frame.libration);
        // Locked, the Moon from Earth's center, where there is no air; else where it shows from the place.
        const air = !frame.locked;
        const center: Vec3 = air ? m.direction : m.trueDirection;
        // The screen's up turned from the zenith by the overlay's turn, counterclockwise.
        const { right, up, toward } = viewFrame(center);
        const [c, s] = [Math.cos(frame.turn * DEG), Math.sin(frame.turn * DEG)];
        const turnedUp = up.map((u, i) => u * c - (right[i] ?? 0) * s);
        const turnedRight = right.map((r, i) => r * c + (up[i] ?? 0) * s);
        const radiansPerPx = frame.unitsPerPx / frame.unitsPerRadian;
        const forward = toward.map((t) => -t);
        renderer.draw(context.getCurrentTexture(), {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            width,
            height,
            inverseViewProjection: inverseViewProjection(
                forward,
                turnedRight,
                turnedUp,
                Math.tan((frame.widthPx / 2) * radiansPerPx),
                Math.tan((frame.heightPx / 2) * radiansPerPx),
            ),
            projectionDistance: 0,
            pixelRatio: dpr,
            discPixels: ((m.angularDiameter * DEG) / radiansPerPx) * dpr,
            maps: "auto",
            air,
            ev100: null,
            albedo: true,
            relief: true,
            shadows: true,
            nightVision: false,
            earthshine: true,
            eclipse: true,
            law: "hapke",
        });
    }

    moonView(view, {
        behind: (next) => {
            frame = next;
            render();
        },
    });
    onTables(requestRender);
    onDisplay(requestRender);
    // The overlay hidden or shown; the Moon behind it stays as it is.
    const annotations = find('[data-field="annotations"]', view);
    annotations.addEventListener("click", () => {
        const shown = annotations.getAttribute("aria-pressed") !== "true";
        annotations.setAttribute("aria-pressed", String(shown));
        view.classList.toggle("without-annotations", !shown);
    });
}
