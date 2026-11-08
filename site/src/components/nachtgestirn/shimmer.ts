import { liftedDirection, shimmerScales, type Vec3, viewFrame } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { morph } from "../dunstkreis/skyframe";
import { onDemand } from "../frame";
import { drawSvg, moonSymbol, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { apply, cross, dot, multiply, noGpu, normalize, rotation, transpose } from "./laws";
import { type MoonAt, moonAt, shimmerThrough, type ToneCurveName } from "./renderer";
import { createTiles } from "./tiles";

const DEG = Math.PI / 180;
const ARCSEC = 206_265;
// The close-up: this share of the disc across, its middle this far down from the disc's center, at the lower limb.
const SHARE = 0.5;
const DOWN = 0.35;
// Where the Moon stands when the moment has it below the horizon, in degrees.
const LOW = 4;
// The lens the air is seen through, in meters: a telephoto's.
const APERTURE = 0.1;
// The side view's box, the observer on the ground near its left edge, the planet's radius and the air's height in its
// own units, the air not to scale: each of its bands holds an equal share of the air, an e-folding a band.
// The close-up's width over its height, and the side view's.
const ASPECT = 4 / 3;
const W = 400;
const H = W / ASPECT;
const OBSERVER = { x: 30, y: 262 };
const PLANET = 300;
const AIR = 150;
const BANDS = 5;
const SCALE_HEIGHT_M = 8500;
const f = (n: number) => n.toFixed(1);

/** `m` moved to `apparent` degrees up at its own azimuth, the Sun and its face turning with it, so it shows the same. */
function atAltitude(m: MoonAt, apparent: number): MoonAt {
    const real = m.trueDirection;
    const altitude = (apparent - (m.bend(apparent) ?? 0)) * DEG;
    const level = Math.hypot(real[0], real[1]) || 1;
    const moved: Vec3 = [
        (real[0] / level) * Math.cos(altitude),
        (real[1] / level) * Math.cos(altitude),
        Math.sin(altitude),
    ];
    const axis = cross(real, moved);
    const sin = Math.hypot(...axis);
    if (sin < 1e-9) return m;
    const r = rotation(normalize(axis), Math.atan2(sin, dot(real, moved)));
    return {
        ...m,
        trueDirection: moved,
        direction: liftedDirection(moved, m.bend),
        moonSunDirection: apply(r, m.moonSunDirection),
        orientation: multiply(m.orientation, transpose(r)),
        earthShadow: null,
    };
}

/** The shimmer figure on `root`: the Moon's lower limb through the air, and the air its light crosses from the side. */
export function shimmerFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const cut = find<SVGSVGElement>("[data-field=cut]", root);
    const note = find("[data-field=note]", root);
    const play = find("[data-field=play]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const pressed = (button: Element) => button.getAttribute("aria-pressed") === "true";
    const parts = [...root.querySelectorAll<HTMLElement>("[data-part]")];
    const r0s = [...root.querySelectorAll<HTMLElement>("[data-r0]")];
    const part = (name: string) => parts.some((button) => button.dataset.part === name && pressed(button));
    const r0 = () => Number(r0s.find(pressed)?.dataset.r0 ?? 10) / 100;
    for (const button of parts) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(!pressed(button)));
            requestRender();
        });
    }
    for (const button of r0s) {
        button.addEventListener("click", () => {
            for (const other of r0s) other.setAttribute("aria-pressed", String(other === button));
            requestRender();
        });
    }
    // The air's own clock, held while paused.
    let clock = 0;
    let last = performance.now();
    const fold = morph(play);
    fold(true);
    play.addEventListener("click", () => {
        const playing = !pressed(play);
        play.setAttribute("aria-pressed", String(playing));
        play.setAttribute("aria-label", playing ? "Pause" : "Play");
        fold(playing);
        last = performance.now();
        requestRender();
    });
    // The Moon's apparent altitude set by a drag in the side view, or null for where it stands at the moment.
    let chosen: number | null = null;

    function render() {
        const table = tables();
        if (!table) return;
        const now = performance.now();
        if (pressed(play)) clock += (now - last) / 1000;
        last = now;
        const real = moonAt(state.jd, state, table.luts.model);
        const realAltitude = Math.asin(Math.max(-1, Math.min(1, real.direction[2]))) / DEG;
        const altitude = chosen ?? (realAltitude > 0.5 ? realAltitude : LOW);
        const m = atAltitude(real, altitude);
        const width = canvas.parentElement?.clientWidth || 400;
        const tilePx = Math.round(width * Math.min(window.devicePixelRatio || 1, 2));
        const across = m.angularDiameter * SHARE;
        const shimmer = {
            r0: r0(),
            aperture: APERTURE,
            time: clock,
            dispersion: part("colors") ? 1 : 0,
            motion: part("motion") ? 1 : 0,
            boiling: part("boiling") ? 1 : 0,
        };
        tiles?.draw({ count: 1, width: tilePx, height: Math.round(tilePx / ASPECT), degreesAcross: across }, () => ({
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
            law: "hapke",
            nightVision: false,
            air: true,
            offset: [0, -m.angularDiameter * DOWN] as const,
            shimmer,
        }));
        const { airColumn, bend } = shimmerThrough(m, shimmer);
        // The Moon's phase on its symbol: lit as much as it is, from where the Sun is on the close-up.
        const { right, up } = viewFrame(m.direction);
        const sun = m.moonSunDirection;
        renderCut(altitude, airColumn, m.heightM, m.lit, dot(sun, right), -dot(sun, up), m.earthshine);
        const { tilt, cell: finest } = shimmerScales(shimmer, airColumn);
        const [rms, cell] = [tilt * ARCSEC, finest * ARCSEC];
        const fringe = bend * 0.0114 * ARCSEC;
        note.textContent =
            `the Moon ${altitude.toFixed(1)}° up${chosen === null && realAltitude > 0.5 ? ", where it stands" : ""}: ` +
            `through ${airColumn.toFixed(1)} zenith columns of air · the image moves ${rms.toFixed(1)}″ rms · ` +
            `cells from ${cell.toFixed(1)}″ · blue over red by ${fringe.toFixed(1)}″`;
        if (pressed(play)) requestRender();
    }

    // The side view: the ground, the air in bands of equal shares, the observer at its height, the zenith's column dashed,
    // the light's path to the Moon through the air drawn strong, the Moon on it to drag. Drawn in the box's units, scaled
    // to the panel's pixels, so the lines and labels come out as fine as the other figures'.
    function renderCut(
        altitude: number,
        column: number,
        heightM: number,
        lit: number,
        dx: number,
        dy: number,
        earthshine: number,
    ) {
        const width = cut.clientWidth || W;
        const k = width / W;
        cut.setAttribute("viewBox", `0 0 ${f(width)} ${f(H * k)}`);
        const center = { x: OBSERVER.x * k, y: (OBSERVER.y + PLANET) * k };
        const arc = (r: number) =>
            `M${f(center.x - r * k)} ${f(center.y)} A${f(r * k)} ${f(r * k)} 0 0 1 ${f(center.x + r * k)} ${f(center.y)}`;
        let svg = "";
        for (let band = BANDS; band >= 1; band--) {
            svg += `<path d="${arc(PLANET + (AIR * band) / BANDS)}Z" class="shimmer-air"/>`;
        }
        for (let band = 1; band <= BANDS; band++) {
            svg += `<path d="${arc(PLANET + (AIR * band) / BANDS)}" class="shimmer-band"/>`;
        }
        svg += `<path d="${arc(PLANET)}Z" class="figure-ground"/>`;
        svg += `<path d="${arc(PLANET)}" class="figure-horizon"/>`;
        // The observer at its height in the bands' measure: an e-folding of the air a band.
        const lift = (AIR / BANDS) * Math.min(heightM / SCALE_HEIGHT_M, BANDS);
        const r0 = PLANET + lift;
        // Where a ray from the observer at `a` degrees up leaves the air: along it, the distance to the outer sphere.
        const out = (a: number) => {
            const s = Math.sin(a * DEG);
            const top = PLANET + AIR;
            return -r0 * s + Math.sqrt(Math.max(r0 * r0 * s * s - r0 * r0 + top * top, 0));
        };
        const along = (a: number, d: number) => ({
            x: (OBSERVER.x + Math.cos(a * DEG) * d) * k,
            y: (OBSERVER.y - lift - Math.sin(a * DEG) * d) * k,
        });
        const o = along(0, 0);
        const zenith = along(90, out(90));
        svg += `<line x1="${f(o.x)}" y1="${f(o.y)}" x2="${f(zenith.x)}" y2="${f(zenith.y)}" class="shimmer-zenith"/>`;
        svg += svgText(o.x + 6, (o.y + zenith.y) / 2, "1 column", "figure-label figure-anchor-start");
        const exit = along(altitude, out(altitude));
        svg += `<line x1="${f(o.x)}" y1="${f(o.y)}" x2="${f(exit.x)}" y2="${f(exit.y)}" class="shimmer-path"/>`;
        // The Moon past the air, inside the box.
        const reach = Math.min(
            out(altitude) + 40,
            (W - 16 - OBSERVER.x) / Math.max(Math.cos(altitude * DEG), 1e-3),
            (OBSERVER.y - lift - 16) / Math.max(Math.sin(altitude * DEG), 1e-3),
        );
        const moon = along(altitude, reach);
        svg += `<line x1="${f(exit.x)}" y1="${f(exit.y)}" x2="${f(moon.x)}" y2="${f(moon.y)}" class="shimmer-space"/>`;
        svg += `<g class="shimmer-moon">${moonSymbol(moon.x, moon.y, 9, lit, dx, dy, earthshine)}</g>`;
        const middle = along(altitude, out(altitude) / 2);
        svg += svgText(middle.x + 6, middle.y - 12, `${column.toFixed(1)} columns`, "figure-note figure-anchor-start");
        svg += `<circle cx="${f(o.x)}" cy="${f(o.y)}" r="2.5" class="shimmer-observer"/>`;
        svg += svgText(width - 4, H * k - 10, "not to scale", "figure-label figure-anchor-end");
        drawSvg(cut, svg, 1);
    }

    // Dragging in the side view sets the Moon's height, from just over the horizon to the zenith.
    const altitudeAt = (event: PointerEvent) => {
        const box = cut.getBoundingClientRect();
        const x = ((event.clientX - box.left) / box.width) * W - OBSERVER.x;
        const y = OBSERVER.y - ((event.clientY - box.top) / box.height) * H;
        return Math.max(0.5, Math.min(90, Math.atan2(y, Math.max(x, 1e-3)) / DEG));
    };
    cut.addEventListener("pointerdown", (event) => {
        cut.setPointerCapture(event.pointerId);
        chosen = altitudeAt(event);
        requestRender();
    });
    cut.addEventListener("pointermove", (event) => {
        if (!cut.hasPointerCapture(event.pointerId)) return;
        chosen = altitudeAt(event);
        requestRender();
    });
    cut.addEventListener("dblclick", () => {
        chosen = null;
        requestRender();
    });

    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
