import { moonEV100, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import "../sternzeit/export";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { drawSvg } from "../sternzeit/figure";
import { ownMoment } from "../sternzeit/lunation";
import { apply, cross, dot, noGpu, transpose } from "./laws";
import { ANY_PLACE, julianDayOf } from "./place";
import { type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { saveFigure } from "./snapshot";
import { createTiles, type TileFrame, tileFrame } from "./tiles";
import { tychoMark, tychoSlice } from "./tycho";
import { TYCHO } from "./tycho-profile";

const DEG = Math.PI / 180;
// The close-up: this many disc diameters across, and where it looks, on the terminator in the southern highlands, at
// Tycho's latitude so it passes over the crater sliced under the figure, this many degrees of longitude into the lit
// side so the craters there catch the light.
const CLOSEUP_SHARE = 1 / 8;
export const CLOSEUP_LATITUDE = TYCHO.latitude;
const INTO_THE_LIGHT = 5;
// The disc and its four close-ups.
const COUNT = 5;
const f = (n: number) => n.toFixed(1);

// Sunrise over Tycho: the eastern rim's shadow across the floor, the central peak's top in the light.
const START = julianDayOf("2026-11-18T06:00Z");

/**
 * Where the close-up looks, off the disc's center, right and up, in degrees of sky: the point of the terminator at
 * `CLOSEUP_LATITUDE` on the side facing the viewer, turned a few degrees towards the Sun. Near full Moon the terminator
 * is at the limb, and so is the close-up. `into` the degrees towards the Sun.
 */
export function closeupOffset(m: MoonAt, into = INTO_THE_LIGHT): readonly [number, number] {
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
    const lon = Math.atan2(point[1], point[0]) + Math.sign(dot(cross(point, sun), [0, 0, 1])) * into * DEG;
    const lit: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const n = apply(transpose(o), lit);
    const { right, up } = tileFrame(m);
    const radius = m.geocentricDiameter / 2;
    const along = (axis: number[]) => (n[0] * (axis[0] ?? 0) + n[1] * (axis[1] ?? 0) + n[2] * (axis[2] ?? 0)) * radius;
    return [along(right), along(up)];
}

/**
 * The surface figure on `root`: the whole disc with the close-up marked on it, and the close-up four times, the color
 * map alone on a smooth sphere, with the relief shading it, with the shadows the relief casts, and displaced.
 */
export function surfaceFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const marker = find<SVGSVGElement>("[data-field=marker]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const moment = ownMoment(root, START, requestRender);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const resolution = mapResolutions(root, "4k", requestRender);

    // The color map, or a uniform albedo for the relief alone.
    const albedo = find("[data-field=albedo]", root);
    albedo.addEventListener("click", () => {
        albedo.setAttribute("aria-pressed", String(albedo.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });

    // The slice through Tycho, redrawn alone when its point moves or a switch of its own is pressed.
    const on = (button: HTMLElement) => button.getAttribute("aria-pressed") === "true";
    const sliceShadows = find("[data-field=sliceShadows]", root);
    const sliceNormals = find("[data-field=sliceNormals]", root);
    const slice = tychoSlice(
        find<SVGSVGElement & HTMLElement>("[data-field=slice]", root),
        find("[data-field=sliceNote]", root),
        () => slice.redraw(),
        { shadows: () => on(sliceShadows), normals: () => on(sliceNormals) },
    );
    for (const button of [sliceShadows, sliceNormals]) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(!on(button)));
            slice.redraw();
        });
    }

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(moment.jd(), ANY_PLACE, table.luts.model);
        const width = root.clientWidth || 600;
        const tileCss = width / COUNT;
        const tilePx = Math.round(tileCss * Math.min(window.devicePixelRatio || 1, 2));
        const overview = m.geocentricDiameter * 1.35;
        const closeup = m.geocentricDiameter * CLOSEUP_SHARE;
        const offset = closeupOffset(m);
        // The close-ups a stop more open than the disc's meter, for the low Sun at the terminator.
        const ev100 = moonEV100(m.phaseAngle, m.lit) - 1;
        const common = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            earthshine: true,
            eclipse: false,
            law: "hapke2012" as const,
            nightVision: false,
            albedo: albedo.getAttribute("aria-pressed") === "true",
        };
        const close = {
            ...common,
            maps: resolution(),
            ev100,
            offset,
            degreesAcross: closeup,
        };
        const frames: TileFrame[] = [
            { ...common, maps: resolution(), ev100: null, relief: true, shadows: true },
            { ...close, relief: false, shadows: false },
            { ...close, relief: true, shadows: false, displacementFrom: Number.POSITIVE_INFINITY },
            { ...close, relief: true, shadows: true, displacementFrom: Number.POSITIVE_INFINITY },
            { ...close, relief: true, shadows: true, displacementFrom: 0 },
        ];
        // The overview at the disc's size, the close-ups at theirs: one canvas, two scales.
        tiles?.draw(
            { count: COUNT, width: tilePx, degreesAcross: overview },
            (i) => frames[i] ?? (frames[0] as TileFrame),
        );
        marker.setAttribute("viewBox", `0 0 ${width} ${tileCss}`);
        const scale = tileCss / overview;
        const side = closeup * scale;
        const [cx, cy] = [tileCss / 2 + offset[0] * scale, tileCss / 2 - offset[1] * scale];
        let svg = `<rect x="${f(cx - side / 2)}" y="${f(cy - side / 2)}" width="${f(side)}" height="${f(side)}" class="surface-marker"/>`;
        // Tycho and the slice under the figure, on the disc, and on the close-ups where they show it, each clipped to its own.
        const frame = tileFrame(m);
        svg += tychoMark(m, frame, [tileCss / 2, tileCss / 2], (m.geocentricDiameter / 2) * scale, 7);
        const near = tileCss / closeup;
        for (let i = 1; i < COUNT; i++) {
            const center = [tileCss / 2 - offset[0] * near, tileCss / 2 + offset[1] * near] as const;
            const mark = tychoMark(m, frame, center, (m.geocentricDiameter / 2) * near);
            if (mark)
                svg += `<svg x="${f(i * tileCss)}" y="0" width="${f(tileCss)}" height="${f(tileCss)}">${mark}</svg>`;
        }
        drawSvg(marker, svg, 1);
        slice.draw(m);
        note.textContent = `the close-up ${(closeup * 60).toFixed(1)}′ across, an eighth of the disc, on the terminator at Tycho's ${Math.abs(CLOSEUP_LATITUDE).toFixed(1)}° south, from the ${RESOLUTION_NAMES[resolution()]}`;
    }

    // The tiles as drawn, the marker and the names under them, in one PNG.
    find("[data-field=download]", root).addEventListener("click", () =>
        saveFigure(root, canvas, render, {
            svgs: [marker],
            texts: root.querySelectorAll<HTMLElement>(".tiles-labels :is(.tiles-name, .tiles-value)"),
        }),
    );

    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
