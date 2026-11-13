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
import type { MoonViewFrame } from "../sternzeit/moonview";
import { state } from "../sternzeit/state";
import { createMoonRenderer, inverseViewProjection, moonAt, onUmbraTable, type ToneCurveName } from "./renderer";

const DEG = Math.PI / 180;

/** What the overlay hands over: the frame it drew, and a way to take the Moon back. */
export interface MoonViewController {
    setBehind(renderer: ((frame: MoonViewFrame) => void) | null): void;
}

/**
 * The textured Moon behind sternzeit's Moon view on `view`, a `.moon-view` with a canvas in its panel: the Moon as
 * nachtgestirn renders it, at the overlay's scale and turn, over dunstkreis' sky where the air is shown. `show` turns
 * it on, when the overlay leaves its own disc out, and off again. Null without WebGPU, with the reason in `shared.error`.
 */
export function attachMoonFace(view: HTMLElement, controller: MoonViewController) {
    const canvas = find<HTMLCanvasElement>("canvas", view);
    const context = shared.error ? null : canvas.getContext("webgpu");
    if (!context) return null;
    configureCanvas(context, SDR);
    const device = gpuDevice();
    let frame: MoonViewFrame | null = null;
    let shown = false;
    const requestRender = onDemand(render, view);
    const renderer = createMoonRenderer(device, requestRender);

    function render() {
        const table = tables();
        if (!shown || !table || !frame || !context) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(frame.widthPx * dpr));
        const height = Math.max(1, Math.round(frame.heightPx * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        const m = moonAt(state.jd, { ...state, geocentric: true }, table.luts.model, frame.libration);
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
            law: "hapke2012",
        });
    }

    onTables(requestRender);
    onUmbraTable(requestRender);
    onDisplay(requestRender);
    return {
        show(on: boolean) {
            shown = on;
            canvas.hidden = !on;
            controller.setBehind(
                on
                    ? (next) => {
                          frame = next;
                          render();
                      }
                    : null,
            );
        },
    };
}
