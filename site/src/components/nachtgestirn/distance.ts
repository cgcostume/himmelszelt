import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { APOGEE_KM, PERIGEE_KM, radiusAt } from "../sternzeit/moonview";
import { onChange, state } from "../sternzeit/state";
import { moonAt, type ToneCurveName } from "./renderer";
import { createTiles } from "./tiles";

const DEG = Math.PI / 180;
const diameterAt = (km: number) => (2 * radiusAt(km)) / DEG;

/** The distance figure on `root`: the Moon at perigee, at the chosen moment and at apogee, at one scale. */
export function distanceFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const labels = root.querySelectorAll<HTMLElement>(".tiles-labels .tiles-value");
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) {
        const error = document.createElement("p");
        error.className = "tiles-empty";
        error.textContent = shared.error ?? "WebGPU is not available here.";
        canvas.replaceWith(error);
    }

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(state.jd, state, table.luts.model);
        const width = root.clientWidth || 600;
        const tilePx = Math.round((width / 3) * Math.min(window.devicePixelRatio || 1, 2));
        const distances = [PERIGEE_KM, m.distanceKm, APOGEE_KM];
        tiles?.draw(3, tilePx, diameterAt(PERIGEE_KM) * 1.12, (i) => ({
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
            law: "hapke",
            nightVision: false,
        }));
        labels.forEach((label, i) => {
            const km = distances[i] ?? m.distanceKm;
            label.textContent = `${Math.round(km).toLocaleString("en-US")} km · ${(diameterAt(km) * 60).toFixed(1)}′`;
        });
    }

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
