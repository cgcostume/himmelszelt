import { moonEV100 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, gpu, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { drawSvg } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { noGpu } from "./laws";
import { moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { saveFigure } from "./snapshot";
import { CLOSEUP_LATITUDE, closeupOffset } from "./surface";
import { createTiles, type TileFrame } from "./tiles";

// The close-up: this share of the disc across, on the terminator, this many degrees of longitude into the light.
const SHARE = 1 / 16;
const INTO_THE_LIGHT = 1.5;
// A Sun without size, in degrees, for hard edges: an arcsecond, as the pass casts below `softShadowsFrom`.
const POINT_SUN = 1 / 3600;
const f = (n: number) => n.toFixed(1);

/** The soft shadows figure on `root`: the disc with the close-up marked, and the close-up's shadows of a point Sun and of the real one. */
export function softShadowsFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const marker = find<SVGSVGElement>("[data-field=marker]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    // The 8K strip where the GPU takes textures that wide, else the 4K.
    const finest = (gpu.device?.limits.maxTextureDimension2D ?? 0) >= 8192 ? "8k-strip" : "large";
    const resolution = mapResolutions(root, finest, requestRender);

    // The color map, or a uniform albedo for the relief alone; and the hard shadows striped where they are off the soft.
    const albedo = find("[data-field=albedo]", root);
    const deviation = find("[data-field=deviation]", root);
    for (const button of [albedo, deviation]) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
            requestRender();
        });
    }

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(state.jd, state, table.luts.model);
        const width = root.clientWidth || 600;
        const tileCss = width / 3;
        const tilePx = Math.round(tileCss * Math.min(window.devicePixelRatio || 1, 2));
        const overview = m.geocentricDiameter * 1.35;
        const closeup = m.geocentricDiameter * SHARE;
        const offset = closeupOffset(m, INTO_THE_LIGHT);
        const common: TileFrame = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: resolution(),
            ev100: null,
            albedo: albedo.getAttribute("aria-pressed") === "true",
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: false,
            law: "hapke2012",
            nightVision: false,
        };
        // The close-ups a stop more open than the disc's meter, for the low Sun at the terminator.
        const close = { ...common, ev100: moonEV100(m.phaseAngle, m.lit) - 1, offset, degreesAcross: closeup };
        // The point Sun's from the same march as the soft ones, striped where it is off them, or from a point alone.
        const point: TileFrame =
            deviation.getAttribute("aria-pressed") === "true"
                ? { ...close, compareShadows: true }
                : { ...close, moon: { ...m, sunAngularDiameter: POINT_SUN } };
        const frames: TileFrame[] = [common, point, close];
        tiles?.draw({ count: 3, width: tilePx, degreesAcross: overview }, (i) => frames[i] ?? (frames[0] as TileFrame));
        marker.setAttribute("viewBox", `0 0 ${width} ${tileCss}`);
        const scale = tileCss / overview;
        const side = closeup * scale;
        const [cx, cy] = [tileCss / 2 + offset[0] * scale, tileCss / 2 - offset[1] * scale];
        drawSvg(
            marker,
            `<rect x="${f(cx - side / 2)}" y="${f(cy - side / 2)}" width="${f(side)}" height="${f(side)}" class="surface-marker"/>`,
            1,
        );
        const disc = Math.round(tilePx / SHARE).toLocaleString("en-US");
        note.textContent = `the close-up ${(closeup * 60).toFixed(1)}′ across, as from a disc of ${disc} pixels, on the terminator at ${Math.abs(CLOSEUP_LATITUDE).toFixed(1)}° south, from the ${RESOLUTION_NAMES[resolution()]}`;
    }

    // The tiles as drawn, the marker and the names under them, in one PNG.
    find("[data-field=download]", root).addEventListener("click", () =>
        saveFigure(root, canvas, render, {
            svgs: [marker],
            texts: root.querySelectorAll<HTMLElement>(".tiles-labels :is(.tiles-name, .tiles-value)"),
        }),
    );

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
