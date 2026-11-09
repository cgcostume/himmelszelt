import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { onChange, state } from "../sternzeit/state";
import { noGpu } from "./laws";
import { moonAt, type ToneCurveName } from "./renderer";
import { createTiles } from "./tiles";

const MODES = ["gray", "untinted", "tinted"] as const;

/** The color figure on `root`: the Moon from the color map as gray, as NASA published it, and tinted to the Moon's color. */
export function colorFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(state.jd, state, table.luts.model);
        const width = root.clientWidth || 600;
        const tilePx = Math.round((width / 3) * Math.min(window.devicePixelRatio || 1, 2));
        tiles?.draw({ count: 3, width: tilePx, degreesAcross: m.geocentricDiameter * 1.35 }, (i) => ({
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100: null,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: false,
            law: "hapke2012",
            mapColor: MODES[i] ?? "tinted",
            nightVision: false,
        }));
    }

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
