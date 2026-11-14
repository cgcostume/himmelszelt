import {
    fromSelenographic,
    MOON_RADIUS_KM,
    moonEV100,
    moonOrientation,
    selenographicPoint,
    type Vec3,
} from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, gpu, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { ownMoment } from "../sternzeit/lunation";
import { noGpu } from "./laws";
import { ANY_PLACE, julianDayOf } from "./place";
import { type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { createTiles, type TileFrame, tileFrame } from "./tiles";

// The basin's middle, from the IAU's Gazetteer, and the sky across the view face on: its outer ring, Montes Cordillera,
// some 960 km across, with room around it, as a share of the Moon's diameter.
const ORIENTALE = { longitude: -94.67, latitude: -19.87 };
const FACE_ON = 1250 / (2 * MOON_RADIUS_KM);
const WHOLE = 1.7;
const ASPECT = 0.75;
const DEG = Math.PI / 180;
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const MIDDLE = selenographicPoint(ORIENTALE.longitude, ORIENTALE.latitude);
// The libration at its farthest west for the year, 7.9°: the basin as far into view as Earth sees it.
const START = julianDayOf("2026-12-18T06:00Z");
// The Sun's height over the basin, from its east: from Earth's view past straight over it, 60° up in the west, so the
// Moon shows a crescent lit at the basin's limb; face on, low in the east, so the rings cast.
const SUN_FROM_EARTH = 120;
const SUN_FACE_ON = 12;

/**
 * The Moon `real` turned `t` of the way from Earth's view of it to face Orientale, its north up, the Sun `elevation`
 * degrees over the basin from its east: the libration's longitude and latitude moved to the basin's, which is how
 * the pass is shown any place on the Moon.
 */
function turned(real: MoonAt, t: number, elevation: number): MoonAt {
    const libration = {
        longitude: mix(real.libration.longitude, ORIENTALE.longitude, t),
        latitude: mix(real.libration.latitude, ORIENTALE.latitude, t),
    };
    // The axis' position angle equal to the parallactic one: the Moon's north up on the screen, as the tiles turn it.
    const positionAngleOfAxis = real.parallacticAngle;
    const orientation = moonOrientation({
        direction: real.trueDirection,
        libration,
        positionAngleOfAxis,
        parallacticAngle: real.parallacticAngle,
    });
    const l = ORIENTALE.longitude * DEG;
    const up = selenographicPoint(ORIENTALE.longitude, ORIENTALE.latitude);
    const east: Vec3 = [-Math.sin(l), Math.cos(l), 0];
    const e = elevation * DEG;
    const sunBody: Vec3 = [
        up[0] * Math.sin(e) + east[0] * Math.cos(e),
        up[1] * Math.sin(e) + east[1] * Math.cos(e),
        up[2] * Math.sin(e) + east[2] * Math.cos(e),
    ];
    const moonSunDirection = fromSelenographic(orientation, sunBody);
    const toViewer: Vec3 = [-real.trueDirection[0], -real.trueDirection[1], -real.trueDirection[2]];
    const cosG = Math.max(-1, Math.min(1, dot(moonSunDirection, toViewer)));
    return {
        ...real,
        libration,
        positionAngleOfAxis,
        orientation,
        moonSunDirection,
        phaseAngle: Math.acos(cosG) / DEG,
        lit: (1 + cosG) / 2,
    };
}

/** The Orientale figure on `root`: the basin turned from the limb to face on, the view closing in on it, the Sun sinking. */
export function orientaleFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const turn = find<HTMLInputElement>("[data-field=turn]", root);
    const requestRender = onDemand(render, root);
    const moment = ownMoment(root, START, requestRender);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    // The 8K maps where the GPU takes textures that wide, else the 4K.
    const maps = (gpu.device?.limits.maxTextureDimension2D ?? 0) >= 8192 ? "8k" : "4k";

    function render() {
        const table = tables();
        if (!table) return;
        const t = Number(turn.value) / 100;
        const real = moonAt(moment.jd(), ANY_PLACE, table.luts.model);
        // Turned, closed in and the Sun lowered together, eased in and out, the zoom on a log scale; the view's middle
        // following the basin as it comes round the limb, so it stays in view while the view narrows.
        const eased = t * t * (3 - 2 * t);
        const elevation = mix(SUN_FROM_EARTH, SUN_FACE_ON, eased);
        paintRange(turn);
        const m = turned(real, eased, elevation);
        const across = m.geocentricDiameter * WHOLE * (FACE_ON / WHOLE) ** eased;
        const view = tileFrame(m);
        const basin = fromSelenographic(m.orientation, MIDDLE);
        const radius = m.geocentricDiameter / 2;
        // Following ahead of the zoom, so the basin nears the middle before the view is narrow.
        const follow = 1 - (1 - eased) ** 2;
        const offset = [dot(basin, view.right) * radius * follow, dot(basin, view.up) * radius * follow] as const;
        // In full screen as tall as the screen leaves, the same height of sky, wider.
        const isFull = document.fullscreenElement === full;
        const panel = canvas.parentElement as HTMLElement;
        const width = (isFull ? panel.clientWidth : root.clientWidth) || 600;
        const height = isFull ? panel.clientHeight || width * ASPECT : width * ASPECT;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const tilePx = Math.round(width * ratio);
        const frame: TileFrame = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps,
            ev100: moonEV100(m.phaseAngle, m.lit),
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: false,
            eclipse: false,
            law: "hapke2012",
            nightVision: false,
            displacementFrom: 0,
            softShadowsFrom: 0,
            filter: "anisotropic",
            offset,
        };
        tiles?.draw(
            {
                count: 1,
                width: tilePx,
                height: Math.round(height * ratio),
                degreesAcross: (across * ASPECT * width) / height,
            },
            () => frame,
        );
    }

    const full = find("[data-field=full]", root);
    const fullscreen = find("[data-field=fullscreen]", root);
    fullscreen.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : full.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () => {
        fullscreen.setAttribute("aria-pressed", String(document.fullscreenElement === full));
        requestRender();
    });
    turn.addEventListener("input", requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
