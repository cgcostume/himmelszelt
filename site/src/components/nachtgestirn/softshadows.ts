import { moonEV100 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, gpu, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, splitLine } from "../sternzeit/figure";
import { ownMoment } from "../sternzeit/lunation";
import { noGpu } from "./laws";
import { ANY_PLACE, julianDayOf } from "./place";
import { moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { CLOSEUP_LATITUDE, closeupOffset } from "./surface";
import { createTiles, type TileFrame } from "./tiles";

// The close-up: this share of the disc across, on the terminator, this many degrees of longitude into the light.
const SHARE = 1 / 16;
const INTO_THE_LIGHT = 1.5;
const NEVER = Number.POSITIVE_INFINITY;
const f = (n: number) => n.toFixed(1);

// Five days after new moon, the terminator across the southern highlands.
const START = julianDayOf("2026-11-14T18:00Z");

/** The soft shadows figure on `root`: the disc with the close-up marked, and the close-up split by a line: a point Sun's
 *  hard shadows on the relief as it lies on the sphere left of it, as the pass draws it right of it, the real Sun's soft
 *  ones on the displaced relief. */
export function softShadowsFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>(".tiles-panel > canvas", root);
    const fullCanvas = find<HTMLCanvasElement>("[data-field=full]", root);
    const slider = find<HTMLInputElement>("[data-field=split]", root);
    const marker = find<SVGSVGElement>("[data-field=marker]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const moment = ownMoment(root, START, requestRender);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const fullTiles = createTiles(fullCanvas, requestRender);
    // The 8K strip where the GPU takes textures that wide, else the 4K.
    const finest = (gpu.device?.limits.maxTextureDimension2D ?? 0) >= 8192 ? "8k-strip" : "4k";
    const resolution = mapResolutions(root, finest, requestRender);

    // The color map, or a uniform albedo for the relief alone.
    const albedo = find("[data-field=albedo]", root);
    albedo.addEventListener("click", () => {
        albedo.setAttribute("aria-pressed", String(albedo.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });

    // The full close-up shown right of the line, over the cheap one, the line drawn with the marker.
    let marks = "";
    function split() {
        const at = Number(slider.value) / 100;
        fullCanvas.style.clipPath = `inset(0 0 0 ${at * 100}%)`;
        const width = root.clientWidth || 600;
        const x = width / 2 + (at * width) / 2;
        const line = at > 0 && at < 1 ? splitLine(x, 0, width / 2, width / 4, "detail-split-line") : "";
        drawSvg(marker, marks + line, 1);
        paintRange(slider);
    }

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(moment.jd(), ANY_PLACE, table.luts.model);
        const width = root.clientWidth || 600;
        const tileCss = width / 2;
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
        // A point Sun on the relief undisplaced beside the disc, and over it the pass' soft shadows on it displaced.
        const point: TileFrame = { ...close, softShadowsFrom: NEVER, displacementFrom: NEVER };
        tiles?.draw({ count: 2, width: tilePx, degreesAcross: overview }, (i) => (i === 0 ? common : point));
        fullTiles?.draw({ count: 1, width: tilePx, degreesAcross: closeup }, () => ({
            ...close,
            softShadowsFrom: 0,
            displacementFrom: 0,
        }));
        marker.setAttribute("viewBox", `0 0 ${width} ${tileCss}`);
        const scale = tileCss / overview;
        const side = closeup * scale;
        const [cx, cy] = [tileCss / 2 + offset[0] * scale, tileCss / 2 - offset[1] * scale];
        marks = `<rect x="${f(cx - side / 2)}" y="${f(cy - side / 2)}" width="${f(side)}" height="${f(side)}" class="surface-marker"/>`;
        split();
        const disc = Math.round(tilePx / SHARE).toLocaleString("en-US");
        note.textContent = `the close-up ${(closeup * 60).toFixed(1)}′ across, as from a disc of ${disc} pixels, on the terminator at ${Math.abs(CLOSEUP_LATITUDE).toFixed(1)}° south, from the ${RESOLUTION_NAMES[resolution()]}`;
    }

    slider.addEventListener("input", split);
    // The line dragged on the close-up itself.
    const drag = (event: PointerEvent) => {
        const box = fullCanvas.getBoundingClientRect();
        slider.value = String(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
        split();
    };
    const panel = canvas.parentElement as HTMLElement;
    panel.addEventListener("pointerdown", (event) => {
        if (event.clientX < fullCanvas.getBoundingClientRect().left || (event.target as Element).closest("button"))
            return;
        event.preventDefault();
        panel.setPointerCapture(event.pointerId);
        drag(event);
    });
    panel.addEventListener("pointermove", (event) => {
        if (panel.hasPointerCapture(event.pointerId)) drag(event);
    });
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
