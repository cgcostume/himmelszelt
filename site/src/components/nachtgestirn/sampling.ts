import type { MapFilter } from "@himmelszelt/nachtgestirn";
import { moonEV100 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { onChange, state } from "../sternzeit/state";
import { noGpu } from "./laws";
import { moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { CLOSEUP_LATITUDE, CLOSEUP_SHARE, closeupOffset } from "./surface";
import { createTiles, type TileFrame } from "./tiles";

/** Samples per pixel in each tile, the terminator's extra ones included, so the count is the count. */
export const SAMPLES = [1, 4, 16, 64] as const;

const FILTER_NAMES: Record<MapFilter, string> = {
    nearest: "the nearest texel",
    bilinear: "bilinear",
    trilinear: "trilinear",
    anisotropic: "trilinear, anisotropic",
    bspline: "anisotropic, and the B-spline where magnified",
};

/** The sampling figure on `root`: the close-up of the terminator at one, 4, 16 and 64 samples per pixel. */
export function samplingFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const resolution = mapResolutions(root, "large", requestRender);
    // The filter chosen, and whether trilinear takes sixteen taps along the footprint; the B-spline always does.
    let mode = "bspline";
    const anisotropy = find("[data-field=anisotropy]", root);
    const modes = [...root.querySelectorAll<HTMLElement>("[data-filter]")];
    const filter = (): MapFilter =>
        mode === "trilinear" && anisotropy.getAttribute("aria-pressed") === "true"
            ? "anisotropic"
            : (mode as MapFilter);
    function showFilter() {
        for (const button of modes) button.setAttribute("aria-pressed", String(button.dataset.filter === mode));
        const takes = mode === "trilinear" || mode === "bspline";
        anisotropy.toggleAttribute("disabled", !takes);
        if (mode === "bspline") anisotropy.setAttribute("aria-pressed", "true");
        if (!takes) anisotropy.setAttribute("aria-pressed", "false");
    }
    for (const button of modes) {
        button.addEventListener("click", () => {
            mode = button.dataset.filter ?? "bspline";
            if (mode === "trilinear") anisotropy.setAttribute("aria-pressed", "true");
            showFilter();
            requestRender();
        });
    }
    anisotropy.addEventListener("click", () => {
        if (mode !== "trilinear") return;
        anisotropy.setAttribute("aria-pressed", String(anisotropy.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });
    showFilter();

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(state.jd, state, table.luts.model);
        const width = root.clientWidth || 600;
        const tilePx = Math.round((width / SAMPLES.length) * Math.min(window.devicePixelRatio || 1, 2));
        const closeup = m.geocentricDiameter * CLOSEUP_SHARE;
        const frame: Omit<TileFrame, "samples" | "terminatorSamples"> = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: resolution(),
            filter: filter(),
            // Two stops more open than the disc's meter, for the low Sun at the terminator.
            ev100: moonEV100(m.phaseAngle, m.lit) - 2,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: false,
            law: "hapke",
            nightVision: false,
            offset: closeupOffset(m),
        };
        tiles?.draw({ count: SAMPLES.length, width: tilePx, degreesAcross: closeup }, (i) => ({
            ...frame,
            samples: SAMPLES[i] ?? 8,
            terminatorSamples: SAMPLES[i] ?? 8,
        }));
        note.textContent = `the close-up of the terminator at ${Math.abs(CLOSEUP_LATITUDE)}° south, ${(closeup * 60).toFixed(1)}′ across, from the ${RESOLUTION_NAMES[resolution()]}; ${FILTER_NAMES[filter()]}; the pass takes 8 samples, and 32 along the terminator`;
    }

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
