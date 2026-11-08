import { moonEV100, type Vec3 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { drawSvg } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { FILTERS } from "./filters";
import { apply, noGpu, transpose } from "./laws";
import { type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { saveFigure } from "./snapshot";
import { createTiles, type TileFrame, tileFrame } from "./tiles";

// The close-up: this many disc diameters across, its center this far out to the limb, so the limb runs low in it,
// and this share of the way along the limb from the south pole towards the bright limb's middle, so it is lit.
const SHARE = 1 / 8;
const OUT = 0.94;
const TOWARDS_THE_LIGHT = 0.3;

/**
 * Where the close-up looks off the disc's center, right and up, in degrees of sky: at the limb, near the south pole.
 * The pole stands on the terminator all month, so the close-up leans along the limb towards the Sun.
 */
function poleOffset(m: MoonAt): readonly [number, number] {
    const { right, up } = tileFrame(m);
    const onScreen = (v: readonly number[]) =>
        [right, up].map((axis) => v[0] * (axis[0] ?? 0) + v[1] * (axis[1] ?? 0) + v[2] * (axis[2] ?? 0)) as [
            number,
            number,
        ];
    const pole = onScreen(apply(transpose(m.orientation), [0, 0, -1] as Vec3));
    const sun = onScreen(m.moonSunDirection);
    const from = Math.atan2(pole[1], pole[0]);
    const turn = Math.atan2(sun[1], sun[0]) - from;
    const angle = from + TOWARDS_THE_LIGHT * Math.atan2(Math.sin(turn), Math.cos(turn));
    const radius = (m.geocentricDiameter / 2) * OUT;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
}

/**
 * The sampling figure on `root`: the disc with the close-up marked, and the limb near the south pole under four of the
 * maps' filters, one ray a pixel or four.
 */
export function samplingFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const note = find("[data-field=note]", root);
    const marker = find<SVGSVGElement>("[data-field=marker]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const resolution = mapResolutions(root, "large", requestRender);
    const relief = find("[data-field=relief]", root);
    const shadows = find("[data-field=shadows]", root);
    const displace = find("[data-field=displace]", root);
    const pressed = (button: HTMLElement) => button.getAttribute("aria-pressed") === "true";
    for (const button of [relief, shadows, displace]) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(!pressed(button)));
            // Without the relief there is nothing to cast shadows or to displace.
            shadows.toggleAttribute("disabled", !pressed(relief));
            displace.toggleAttribute("disabled", !pressed(relief));
            requestRender();
        });
    }

    function render() {
        const table = tables();
        if (!table) return;
        const m = moonAt(state.jd, state, table.luts.model);
        const width = root.clientWidth || 600;
        const count = FILTERS.length + 1;
        const tileCss = width / count;
        const tilePx = Math.round(tileCss * Math.min(window.devicePixelRatio || 1, 2));
        const closeup = m.geocentricDiameter * SHARE;
        const overview = m.geocentricDiameter * 1.35;
        const offset = poleOffset(m);
        const frame: TileFrame = {
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: resolution(),
            // A stop more open than the disc's meter, for the low Sun at the pole.
            ev100: moonEV100(m.phaseAngle, m.lit) - 1,
            albedo: true,
            relief: pressed(relief),
            shadows: pressed(relief) && pressed(shadows),
            displacementFrom: pressed(relief) && pressed(displace) ? 0 : Number.POSITIVE_INFINITY,
            earthshine: true,
            eclipse: false,
            law: "hapke",
            nightVision: false,
        };
        // The disc at its size, metered, as the pass reads its maps; the close-ups at theirs.
        tiles?.draw({ count, width: tilePx, degreesAcross: overview }, (i) =>
            i === 0
                ? { ...frame, ev100: null }
                : { ...frame, offset, degreesAcross: closeup, filter: FILTERS[i - 1]?.[0] ?? "bspline" },
        );
        marker.setAttribute("viewBox", `0 0 ${width} ${tileCss}`);
        const scale = tileCss / overview;
        const side = closeup * scale;
        const [cx, cy] = [tileCss / 2 + offset[0] * scale, tileCss / 2 - offset[1] * scale];
        drawSvg(
            marker,
            `<rect x="${(cx - side / 2).toFixed(1)}" y="${(cy - side / 2).toFixed(1)}" width="${side.toFixed(1)}" height="${side.toFixed(1)}" class="surface-marker"/>`,
            1,
        );
        note.textContent = `the limb near the south pole, ${(closeup * 60).toFixed(1)}′ across, from the ${RESOLUTION_NAMES[resolution()]}; ${find("[data-field=rays]", root).getAttribute("aria-pressed") === "true" ? "four rays" : "one ray"} a pixel`;
    }

    // The close-ups as drawn and the names under them, in one PNG.
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
