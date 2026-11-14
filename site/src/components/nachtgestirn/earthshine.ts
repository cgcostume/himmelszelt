import { MOON_GEOMETRIC_ALBEDO, moonEV100 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { figureInfo } from "../figure-info";
import { onDemand } from "../frame";
import { ownMoment } from "../sternzeit/lunation";
import { noGpu } from "./laws";
import { ANY_PLACE, julianDayOf } from "./place";
import { moonAt, type ToneCurveName } from "./renderer";
import { saveFigure } from "./snapshot";
import { createTiles, type TileFrame } from "./tiles";

// Three days after new moon, a crescent in a nearly full Earth's light.
const START = julianDayOf("2026-11-12T18:00Z");
// The meter: the night side as bright as it shows at `START` with the exposure 8 stops past the sunlit part's, and never
// more than 10 past it, so the glow fades towards full moon as it does in the sky.
const [AT_START, MOST] = [8, 10];

/** The earthshine figure on `root`: the Moon without earthshine and with it, at one exposure, metered on the night side. */
export function earthshineFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const lux = find("[data-field=lux]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const moment = ownMoment(root, START, requestRender);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(moment.jd(), ANY_PLACE, table.luts.model);
        const start = moonAt(START, ANY_PLACE, table.luts.model);
        const fainter = Math.log2(start.earthshine / Math.max(m.earthshine, 1e-6));
        const nightSide = moonEV100(start.phaseAngle, start.lit) - AT_START - fainter;
        const sunlit = moonEV100(m.phaseAngle, m.lit);
        const stops = Math.min(Math.max(sunlit - nightSide, 0), MOST);
        const tilePx = Math.round(((root.clientWidth || 600) / 2) * Math.min(window.devicePixelRatio || 1, 2));
        const common: TileFrame = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100: sunlit - stops,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: false,
            eclipse: false,
            law: "hapke2012",
            nightVision: false,
        };
        const frames: TileFrame[] = [common, { ...common, earthshine: true }];
        tiles?.draw(
            { count: 2, width: tilePx, degreesAcross: m.geocentricDiameter * 1.15 },
            (i) => frames[i] ?? common,
        );
        // The night side lit face on, as a Lambert surface of the Moon's albedo would be: a first measure.
        const night = (MOON_GEOMETRIC_ALBEDO / Math.PI) * m.earthshine;
        lux.textContent = `${m.earthshine.toFixed(1)} lx from Earth`;
        note.textContent = `${(m.lit * 100).toFixed(0)}% lit · Earth about ${(100 - m.lit * 100).toFixed(0)}% full as the Moon sees it · the night side some ${night.toFixed(2)} cd/m² · ${stops.toFixed(1)} stops past the sunlit part's exposure`;
    }

    find("[data-field=download]", root).addEventListener("click", () =>
        saveFigure(root, canvas, render, {
            texts: root.querySelectorAll<HTMLElement>(".tiles-labels :is(.tiles-name, .tiles-value)"),
        }),
    );
    figureInfo(root);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
