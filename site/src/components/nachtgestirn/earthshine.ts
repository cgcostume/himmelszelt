import { MOON_GEOMETRIC_ALBEDO, moonEV100 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { ownMoment } from "../sternzeit/lunation";
import { noGpu } from "./laws";
import { ANY_PLACE, julianDayOf } from "./place";
import { moonAt, type ToneCurveName } from "./renderer";
import { createTiles, type TileFrame } from "./tiles";

// Three days after new moon, a crescent in a nearly full Earth's light.
const START = julianDayOf("2026-11-12T18:00Z");

/** The earthshine figure on `root`: the Moon without earthshine and with it, at an exposure opened up past the crescent's. */
export function earthshineFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const slider = find<HTMLInputElement>("[data-field=stops]", root);
    const stopsValue = find("[data-field=stopsValue]", root);
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
        const stops = Number(slider.value);
        stopsValue.textContent = `+${stops.toFixed(1)}`;
        paintRange(slider);
        const tilePx = Math.round(((root.clientWidth || 600) / 2) * Math.min(window.devicePixelRatio || 1, 2));
        const common: TileFrame = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100: moonEV100(m.phaseAngle, m.lit) - stops,
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
        note.textContent = `${(m.lit * 100).toFixed(0)}% lit · Earth about ${(100 - m.lit * 100).toFixed(0)}% full as the Moon sees it · the night side some ${night.toFixed(2)} cd/m²`;
    }

    slider.addEventListener("input", requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
