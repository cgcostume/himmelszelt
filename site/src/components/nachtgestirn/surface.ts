import { moonEV100, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { drawSvg, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { apply, cross, dot, noGpu, transpose } from "./laws";
import { type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { createTiles, type TileFrame, tileFrame } from "./tiles";

const DEG = Math.PI / 180;
// The close-up: this many disc diameters across, and where it looks, on the terminator in the southern highlands,
// this many degrees of longitude into the lit side so the craters there catch the light.
export const CLOSEUP_SHARE = 1 / 6;
export const CLOSEUP_LATITUDE = -30;
const INTO_THE_LIGHT = 5;
const f = (n: number) => n.toFixed(1);

/**
 * Where the close-up looks, off the disc's center, right and up, in degrees of sky: the point of the terminator at
 * `CLOSEUP_LATITUDE` on the side facing the viewer, turned a few degrees towards the Sun. Near full Moon the terminator
 * is at the limb, and so is the close-up.
 */
export function closeupOffset(m: MoonAt): readonly [number, number] {
    const o = m.orientation;
    const sun = apply(o, m.moonSunDirection);
    const toViewer = apply(o, [-m.trueDirection[0], -m.trueDirection[1], -m.trueDirection[2]]);
    // Points at the latitude where the Sun stands on the horizon: cos(lat)(sx cos lon + sy sin lon) = -sz sin(lat).
    const lat = CLOSEUP_LATITUDE * DEG;
    const [a, b, c] = [sun[0] * Math.cos(lat), sun[1] * Math.cos(lat), -sun[2] * Math.sin(lat)];
    const r = Math.hypot(a, b);
    const base = Math.atan2(b, a);
    const spread = Math.acos(Math.max(-1, Math.min(1, c / Math.max(r, 1e-9))));
    const candidates = [base + spread, base - spread].map(
        (lon): Vec3 => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)],
    );
    const point = candidates.reduce((best, p) => (dot(p, toViewer) > dot(best, toViewer) ? p : best));
    // Turned towards the Sun about the pole, into the light.
    const lon = Math.atan2(point[1], point[0]) + Math.sign(dot(cross(point, sun), [0, 0, 1])) * INTO_THE_LIGHT * DEG;
    const lit: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const n = apply(transpose(o), lit);
    const { right, up } = tileFrame(m);
    const radius = m.geocentricDiameter / 2;
    const along = (axis: number[]) => (n[0] * (axis[0] ?? 0) + n[1] * (axis[1] ?? 0) + n[2] * (axis[2] ?? 0)) * radius;
    return [along(right), along(up)];
}

/**
 * The surface figure on `root`: the whole disc with the close-up marked on it, and the close-up three times, the color
 * map alone on a smooth sphere, with the relief shading it, and with the shadows the relief casts.
 */
export function surfaceFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const marker = find<SVGSVGElement>("[data-field=marker]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const resolution = mapResolutions(root, "large", requestRender);

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(state.jd, state, table.luts.model);
        const width = root.clientWidth || 600;
        const tileCss = width / 4;
        const tilePx = Math.round(tileCss * Math.min(window.devicePixelRatio || 1, 2));
        const overview = m.geocentricDiameter * 1.35;
        const closeup = m.geocentricDiameter * CLOSEUP_SHARE;
        const offset = closeupOffset(m);
        // The close-ups two stops more open than the disc's meter, for the low Sun at the terminator.
        const ev100 = moonEV100(m.phaseAngle, m.lit) - 2;
        const common = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            earthshine: true,
            eclipse: false,
            law: "hapke" as const,
            nightVision: false,
            albedo: true,
        };
        // The close-ups at the most samples the sampling figure shows, every pixel of them.
        const close = {
            ...common,
            maps: resolution(),
            ev100,
            offset,
            degreesAcross: closeup,
            samples: 64,
            terminatorSamples: 64,
        };
        const frames: TileFrame[] = [
            { ...common, maps: resolution(), ev100: null, relief: true, shadows: true },
            { ...close, relief: false, shadows: false },
            { ...close, relief: true, shadows: false },
            { ...close, relief: true, shadows: true },
        ];
        // The overview at the disc's size, the close-ups at theirs: one canvas, two scales.
        tiles?.draw({ count: 4, width: tilePx, degreesAcross: overview }, (i) => frames[i] ?? (frames[0] as TileFrame));
        marker.setAttribute("viewBox", `0 0 ${width} ${tileCss}`);
        const scale = tileCss / overview;
        const side = closeup * scale;
        const [cx, cy] = [tileCss / 2 + offset[0] * scale, tileCss / 2 - offset[1] * scale];
        let svg = `<rect x="${f(cx - side / 2)}" y="${f(cy - side / 2)}" width="${f(side)}" height="${f(side)}" class="surface-marker"/>`;
        svg += svgText(cx, cy - side / 2 - 5, "the close-up", "figure-note");
        drawSvg(marker, svg, 1);
        note.textContent = `the close-up ${(closeup * 60).toFixed(1)}′ across, a sixth of the disc, on the terminator at ${Math.abs(CLOSEUP_LATITUDE)}° south, from the ${RESOLUTION_NAMES[resolution()]}`;
    }

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
