import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { drawSvg, svgText } from "../sternzeit/figure";
import { APOGEE_KM, PERIGEE_KM, radiusAt } from "../sternzeit/moonview";
import { onChange, state } from "../sternzeit/state";
import { noGpu } from "./laws";
import { moonAt, type ToneCurveName } from "./renderer";
import { createTiles } from "./tiles";

const DEG = Math.PI / 180;
const diameterAt = (km: number) => (2 * radiusAt(km)) / DEG;
const f = (n: number) => n.toFixed(1);

/** The distance figure on `root`: the Moon at apogee, at the chosen moment and at perigee, small to large, at one scale. */
export function distanceFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const lines = find<SVGSVGElement>("[data-field=lines]", root);
    const labels = root.querySelectorAll<HTMLElement>(".tiles-labels .tiles-value");
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(state.jd, state, table.luts.model);
        const width = root.clientWidth || 600;
        const tileCss = width / 3;
        const tilePx = Math.round(tileCss * Math.min(window.devicePixelRatio || 1, 2));
        const distances = [APOGEE_KM, m.distanceKm, PERIGEE_KM];
        const across = diameterAt(PERIGEE_KM) * 1.35;
        tiles?.draw({ count: 3, width: tilePx, degreesAcross: across }, (i) => ({
            moon: { ...m, geocentricDiameter: diameterAt(distances[i] ?? m.distanceKm) },
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100: null,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: true,
            law: "hapke2012",
            nightVision: false,
        }));
        labels.forEach((label, i) => {
            const km = distances[i] ?? m.distanceKm;
            label.textContent = `${Math.round(km).toLocaleString("en-US")} km · ${(diameterAt(km) * 60).toFixed(1)}′`;
        });
        // The apogee disc's and the perigee disc's upper and lower edges carried across all three, to compare by.
        lines.setAttribute("viewBox", `0 0 ${width} ${tileCss}`);
        let svg = "";
        // A double arrow across each disc's diameter, beside the disc it belongs to: the apogee's left of the first,
        // the perigee's right of the last, each with its name and its angular diameter.
        const arrow = (x: number, top: number, bottom: number) => {
            const head = 5;
            return (
                `<line x1="${f(x)}" y1="${f(top + 1)}" x2="${f(x)}" y2="${f(bottom - 1)}" class="distance-arrow"/>` +
                `<path d="M${f(x)} ${f(top)}l${-head / 2} ${head}h${head}z M${f(x)} ${f(bottom)}l${-head / 2} ${-head}h${head}z" class="distance-arrow-head"/>`
            );
        };
        // The labels in the margin below the perigee disc's bottom line, clear of every disc and of the switches above.
        const margin = tileCss / 2 - ((diameterAt(PERIGEE_KM) / across) * tileCss) / 2;
        for (const [km, name, x, anchor] of [
            [APOGEE_KM, "apogee", tileCss * 0.05, "figure-anchor-start"],
            [PERIGEE_KM, "perigee", width - tileCss * 0.05, "figure-anchor-end"],
        ] as const) {
            const r = ((diameterAt(km) / across) * tileCss) / 2;
            const [top, bottom] = [tileCss / 2 - r, tileCss / 2 + r];
            for (const edge of [top, bottom]) {
                svg += `<line x1="0" y1="${f(edge)}" x2="${f(width)}" y2="${f(edge)}" class="figure-outline"/>`;
            }
            svg += arrow(x, top, bottom);
            svg += svgText(
                x,
                tileCss - margin / 2,
                `${name} ${(diameterAt(km) * 60).toFixed(1)}′`,
                `figure-note ${anchor}`,
            );
        }
        drawSvg(lines, svg, 1);
    }

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
