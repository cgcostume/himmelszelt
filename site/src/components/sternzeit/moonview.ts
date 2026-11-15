import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import {
    APOGEE_KM,
    drawSvg,
    EARTHSHINE_MAX,
    escapeText,
    PERIGEE_KM,
    selenographic,
    sunInViewFrame,
    svgText,
    toScreen,
    veiledHorizon,
    visibleRuns,
} from "./figure";
import { arrowAround, offPanelArrowSvg } from "./offpanel";
import { drawParallax } from "./parallax";
import { ephemerisDay, onChange, state } from "./state";
import "./export";

const DEG = precise.DEG_TO_RAD;
// The Moon's disc at perigee gets this radius in the 200 x 200 viewBox; smaller at any other distance.
const PERIGEE_RADIUS = 72;
/** The disc's angular radius at a distance in km, in radians. */
export const radiusAt = (km: number) => Math.asin(precise.moon.MEAN_RADIUS_KM / km);
const UNITS_PER_RADIAN = PERIGEE_RADIUS / radiusAt(PERIGEE_KM);
// Selenographic grid spacing, in degrees.
const GRID_STEP = 30;
// The Sun's normal is this long where it stands on the limb, at first and last quarter, and its head this long.
const SUN_NORMAL_LENGTH = 19;
const SUN_HEAD_LENGTH = 4;
// Past the quarters, the common arrow (see offpanel.ts) on this fixed circle, outside the disc at perigee.
const SUN_CIRCLE = PERIGEE_RADIUS + 9;
// The reference circles' names at the lower left, counterclockwise from up as the position angles, along their circles
// with their tops towards the center: clear of the pole, the readouts and, mostly, the Sun's arrow.
const REFERENCE_LABEL_ANGLE = 135;

/**
 * What the view shows, for a renderer that draws the Moon itself behind it: the panel's size in CSS pixels and in the
 * viewBox' units, the angle a unit stands for, how far the view is turned and the libration it shows.
 */
export interface MoonViewFrame {
    widthPx: number;
    heightPx: number;
    unitsPerPx: number;
    unitsPerRadian: number;
    /** Locked to the Moon: its north up, seen from Earth's center; else the zenith up, from the place. */
    locked: boolean;
    /** How far the screen's up is turned from the zenith, counterclockwise in degrees: the axis' tilt when locked. */
    turn: number;
    libration: { longitude: number; latitude: number };
}

/** A renderer that draws the Moon behind the overlay, which then leaves out its own disc, phase and veiled horizon. */
export type MoonViewBehind = (frame: MoonViewFrame) => void;

export interface MoonViewOptions {
    /** Draws the Moon behind the overlay from the start; `setBehind` switches it later. */
    behind?: MoonViewBehind;
}

// The panel is wider than the Moon needs: the readouts sit beside it. Its height keeps the disc at the size a 416 px
// square would give it, unless the panel is too narrow for the readouts, when the disc shrinks to make room for them.
const BASE_UNITS_PER_PX = 200 / 416;
// Room a one-line readout beside the disc needs; where the panel lacks it, the readouts move under the disc instead.
const READOUT_WIDTH_PX = 100;
const READOUT_LINE_PX = 16;
// Never lower than this, so a shrunk disc still leaves room above and below it for the tilt and the buttons.
const MIN_HEIGHT_PX = 300;
// The corners' inset, the switches' own (see .view-toggle), and the middle of their row, as tall as a switch.
const CORNER_PX = 6;

// The north tick and the tilt arc reach this far from the center; the readouts start just beyond.
const OUTSIDE = PERIGEE_RADIUS + 3;
// The Sun's arrows reach this far at most; the readouts stay beyond them, whichever way they point.
const REACH = PERIGEE_RADIUS + SUN_NORMAL_LENGTH;
const SIDE = REACH + 6;

const f = (n: number) => n.toFixed(2);
// A one-line readout, its name muted and its value in full, anchored at `x` by `anchor`.
const readout = (x: number, y: number, name: string, value: string, anchor: string) =>
    `<text x="${f(x)}" y="${f(y)}" dy="0.35em" class="figure-note figure-readout figure-anchor-${anchor}"><tspan class="figure-readout-name">${escapeText(name)}</tspan> ${escapeText(value)}</text>`;
const polyline = (points: (readonly [number, number])[], cls: string) =>
    `<polyline points="${points.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" class="${cls}"/>`;

/** A normal on the disc: a dot where it stands (unless hidden behind the limb), a shaft and a head along (ux, uy). */
function normalVector(px: number, py: number, ux: number, uy: number, length: number, dot = true) {
    let svg = dot ? `<circle cx="${f(px)}" cy="${f(py)}" r="1.8"/>` : "";
    if (length <= SUN_HEAD_LENGTH) return svg;
    const [tx, ty] = [px + ux * length, py + uy * length];
    const [hx, hy] = [tx - ux * SUN_HEAD_LENGTH, ty - uy * SUN_HEAD_LENGTH];
    svg = `<line x1="${f(px)}" y1="${f(py)}" x2="${f(hx)}" y2="${f(hy)}"/>${svg}`;
    return `${svg}<polygon points="${f(tx)},${f(ty)} ${f(hx - uy * 2.4)},${f(hy + ux * 2.4)} ${f(hx + uy * 2.4)},${f(hy - ux * 2.4)}"/>`;
}

/**
 * The Moon as seen from the chosen place in `view`, a `.moon-view`: its disc, phase, grid, axis, the Sun's direction
 * and the readouts in an SVG, redrawn whenever the moment or the place change.
 */
export function moonView(view: HTMLElement, options: MoonViewOptions = {}) {
    const svgEl = find<SVGSVGElement>(".moon-panel > svg", view);
    const lockButton = find('[data-field="lockMoon"]', view);
    // Locked to the Moon: its north up rather than the zenith, and no horizon, so only the librations still move.
    let locked = lockButton.getAttribute("aria-pressed") !== "false";
    const opticalButton = find('[data-field="opticalLibration"]', view);
    // Off leaves only the physical libration, the Moon's own wobble, well below a pixel here.
    let optical = opticalButton.getAttribute("aria-pressed") !== "false";
    const cornerRowPx = () => CORNER_PX + opticalButton.offsetHeight / 2;
    let behind: MoonViewBehind | null = options.behind ?? null;
    // The parallax sketch beside the view, if its figure has one, and its switch between Earth's center and the place.
    const sketch = view.closest("figure")?.querySelector<SVGSVGElement>(".parallax-sketch") ?? null;
    const sides = [...(view.closest("figure")?.querySelectorAll<HTMLElement>("[data-parallax-from]") ?? [])];
    // From the place, but still north up and out of the air: the size, the libration and the axis as seen from there.
    let fromPlace = false;
    const showLocked = () => {
        lockButton.setAttribute("aria-pressed", String(locked));
        for (const side of sides) {
            side.setAttribute("aria-pressed", String((side.dataset.parallaxFrom === "place") === fromPlace));
        }
    };

    function render() {
        const topocentric = !locked || fromPlace;
        const { jd } = state;
        const width = svgEl.parentElement?.clientWidth || 416;
        const besides = (width * BASE_UNITS_PER_PX) / 2 >= SIDE + READOUT_WIDTH_PX * BASE_UNITS_PER_PX;
        const firstRow = REACH + 10;
        // Where they do not fit beside it, the panel is square and the readouts go to the right corners, two rows each: the
        // size in the top one and the tilt under it, the earthshine level with the switch in the bottom one and the
        // libration over it. The disc is as large as leaves both rows clear of it.
        const square = REACH / (width / 2 - 3 * READOUT_LINE_PX);
        const unitsPerPx = besides ? BASE_UNITS_PER_PX : Math.max(BASE_UNITS_PER_PX, square > 0 ? square : Infinity);
        const line = READOUT_LINE_PX * unitsPerPx;
        const halfWidth = (width * unitsPerPx) / 2;
        // Beside the disc, the size under it and below that the corners' row, with the switch and the note that the Moon is
        // below the horizon.
        const halfHeight = besides ? Math.max(100, firstRow + 2 * line, (MIN_HEIGHT_PX / 2) * unitsPerPx) : halfWidth;
        svgEl.style.height = `${f((2 * halfHeight) / unitsPerPx)}px`;
        svgEl.setAttribute("viewBox", `${f(-halfWidth)} ${f(-halfHeight)} ${f(2 * halfWidth)} ${f(2 * halfHeight)}`);
        if (sketch) {
            sketch.parentElement?.style.setProperty("--moon-height", svgEl.style.height);
            drawParallax(sketch, !fromPlace);
        }
        const time = precise.fromJulianDay(jd);
        // From Earth's center, or from the place, larger with the Moon high in the sky.
        const diameter = !topocentric
            ? precise.moon.apparentAngularDiameter(ephemerisDay(jd))
            : precise.moon.topocentricAngularDiameter(time, state);
        const radius = (diameter / 2) * DEG * UNITS_PER_RADIAN;
        // From the place: the diurnal libration too, the Moon seen from an Earth radius off its center, which
        // turns its face by up to a degree over the day.
        const total =
            !topocentric || !optical
                ? precise.moon.librations(ephemerisDay(jd))
                : precise.moon.topocentricLibrations(time, state);
        const opticalPart = optical ? { longitude: 0, latitude: 0 } : precise.moon.opticalLibrations(ephemerisDay(jd));
        const l = total.longitude - opticalPart.longitude;
        const b = total.latitude - opticalPart.latitude;
        const axis = !topocentric
            ? precise.moon.positionAngleOfAxis(ephemerisDay(jd))
            : precise.moon.topocentricPositionAngleOfAxis(time, state);
        const parallactic = precise.moon.parallacticAngle(time, state);
        const horizontal = precise.moon.horizontalPosition(time, state);
        const earthshine = precise.moon.earthshine(ephemerisDay(jd));
        // On the sky, position angles run from north through east, counterclockwise with east to the left. The zenith is at
        // the parallactic angle, so with the zenith up, the Moon's north pole sits at axis - parallactic, counterclockwise.
        const twist = axis - parallactic;
        const tilt = locked ? 0 : twist;

        // The bright limb's direction on screen, clockwise from up, and how far the terminator bulges. Turning the pole
        // up turns the whole view with it, the Sun's direction on screen included.
        const sunFrame = sunInViewFrame(time, state);
        const limb = Math.atan2(sunFrame.right, sunFrame.up) + (twist - tilt) * DEG;
        const bulge = sunFrame.toward / Math.hypot(sunFrame.right, sunFrame.up, sunFrame.toward);

        let svg = "";
        // The night side in the earthshine, bluer the stronger it is, as on the moon calendar's discs.
        const glow = Math.min(earthshine, EARTHSHINE_MAX) / EARTHSHINE_MAX;
        if (!behind) svg += `<circle r="${f(radius)}" class="moon-night" style="--earthshine: ${glow.toFixed(3)}"/>`;

        // The lit part: the half disc towards the Sun, closed by the terminator, an ellipse across it.
        const lit: [number, number][] = [];
        for (let i = 0; i <= 32; i++) {
            const a = Math.PI / 2 - (i / 32) * Math.PI;
            lit.push([Math.cos(a), Math.sin(a)]);
        }
        // Sampled by the same angles as the limb, so at new moon the two coincide exactly and nothing is left lit.
        for (let i = 0; i <= 32; i++) {
            const a = -Math.PI / 2 + (i / 32) * Math.PI;
            lit.push([-bulge * Math.cos(a), Math.sin(a)]);
        }
        const [lc, ls] = [Math.cos(limb), Math.sin(limb)];
        // Local frame: +x towards the bright limb. Screen: clockwise from up by `limb`, y down.
        const litScreen = lit.map(([x, y]): [number, number] => [
            (x * ls - y * lc) * radius,
            -(x * lc + y * ls) * radius,
        ]);
        if (!behind) svg += polyline([...litScreen, ...litScreen.slice(0, 1)], "moon-day");

        svg += `<circle r="${f(radius)}" class="moon-limb"/>`;
        // The annotations, which the figure's switch hides: the grid, the reference sizes, the tilt, the center, the Sun.
        svg += `<g class="moon-annotations">`;
        // The selenographic grid, only its near side.
        for (let lon = -180; lon < 180; lon += GRID_STEP) {
            const meridian = Array.from({ length: 37 }, (_, i) => selenographic(lon, -90 + i * 5, l, b));
            const cls = lon === 0 ? "moon-grid moon-grid-main" : "moon-grid";
            for (const run of visibleRuns(meridian, tilt, radius)) svg += polyline(run, cls);
        }
        for (let lat = -60; lat <= 60; lat += GRID_STEP) {
            const parallel = Array.from({ length: 73 }, (_, i) => selenographic(-180 + i * 5, lat, l, b));
            const cls = lat === 0 ? "moon-grid moon-grid-main" : "moon-grid";
            for (const run of visibleRuns(parallel, tilt, radius)) svg += polyline(run, cls);
        }
        // Apogee and perigee sizes on top of the disc: the smaller one mostly falls inside it. Named between the two
        // circles and just outside the larger one, the text along the circle.
        const [apogee, perigee] = [APOGEE_KM, PERIGEE_KM].map((km) => radiusAt(km) * UNITS_PER_RADIAN);
        for (const r of [apogee, perigee]) svg += `<circle r="${f(r)}" class="moon-reference"/>`;
        const [lx, ly] = toScreen([0, 1], REFERENCE_LABEL_ANGLE, 1);
        for (const [name, r] of [
            ["apogee", (apogee + perigee) / 2],
            ["perigee", perigee + 2.2 * unitsPerPx + 2],
        ] as const) {
            const [x, y] = [lx * r, ly * r];
            svg += `<text x="${f(x)}" y="${f(y)}" transform="rotate(${180 - REFERENCE_LABEL_ANGLE} ${f(x)} ${f(y)})" class="figure-label">${name}</text>`;
        }

        // The lunar north pole: the axis as a vector out of the pole, foreshortened as the libration tilts it, with the N at
        // its tip; with the pole turned away, out from behind the limb. Unlocked, a dashed tick up and an arc between.
        const [nx, ny] = toScreen([0, 1], tilt, 1);
        const northPole = selenographic(0, 90, l, b);
        const facing = northPole[2] > 0;
        const [sx, sy] = facing ? toScreen(northPole, tilt, radius) : [nx * radius, ny * radius];
        // Up to where the tick stood, clear of the perigee circle, so the N keeps its place over the largest disc too.
        const axisLength = (OUTSIDE + 7 - radius) * Math.hypot(northPole[0], northPole[1]);
        svg += `<g class="moon-sun-normal">${normalVector(sx, sy, nx, ny, axisLength, facing)}</g>`;
        svg += svgText(sx + nx * (axisLength + 6), sy + ny * (axisLength + 6), "N", "figure-note");
        const tiltDeg = ((((twist + 180) % 360) + 360) % 360) - 180;
        if (!locked) {
            svg += `<line x1="0" y1="${f(-OUTSIDE)}" x2="0" y2="${f(-(OUTSIDE + 7))}" class="moon-zenith"/>`;
            const arc = Array.from({ length: 25 }, (_, i) => toScreen([0, 1], (tiltDeg * i) / 24, OUTSIDE + 4));
            svg += polyline(arc, "moon-tilt");
        }

        // The disc's center, the point we look at: the libration is how far the grid's own center has moved from it.
        svg += `<circle r="1.2" class="moon-center"/>`;

        // The Sun: while the point under it faces us, the normal there, towards the Sun and foreshortened as the sphere
        // turns it away, down to a dot at full moon; once that point is on the far side, the common arrow around the disc.
        const [ux, uy] = [ls, -lc];
        const across =
            Math.hypot(sunFrame.right, sunFrame.up) / Math.hypot(sunFrame.right, sunFrame.up, sunFrame.toward);
        if (sunFrame.toward > 0) {
            const normal = normalVector(ux * radius * across, uy * radius * across, ux, uy, SUN_NORMAL_LENGTH * across);
            svg += `<g class="moon-sun-normal">${normal}</g>`;
        } else {
            const arrow = arrowAround({ x: 0, y: 0 }, { x: ux, y: uy }, SUN_CIRCLE, unitsPerPx);
            svg += offPanelArrowSvg(arrow, true);
        }
        svg += "</g>";

        // The visible horizon, below the Moon by its apparent altitude over it, at the disc's own scale (so it only shows
        // within a few tenths of a degree); the ground beneath veils what it hides.
        // In the bottom right corner, level with the switch in the bottom left one, or over the readouts there.
        const corner = {
            x: halfWidth - CORNER_PX * unitsPerPx,
            y: halfHeight - cornerRowPx() * unitsPerPx - (besides ? 0 : 2.5 * line),
        };
        const cornerCls = "figure-note figure-anchor-end";
        const altitude = precise.earth.apparentAltitude(horizontal.altitude, state);
        if (!locked) {
            const horizon = altitude * DEG * UNITS_PER_RADIAN;
            // Drawn behind, the ground is the renderer's: only the note that the whole view is below the horizon.
            if (!behind)
                svg += veiledHorizon(horizon, halfHeight, unitsPerPx, halfWidth, { ...corner, cls: cornerCls });
            else if (horizon <= -halfHeight) svg += svgText(corner.x, corner.y, "below the horizon", cornerCls);
        } else {
            // Locked, there is no horizon to draw: only whether the Moon is up at the place.
            svg += svgText(corner.x, corner.y, altitude > 0 ? "above the horizon" : "below the horizon", cornerCls);
        }

        svg += `<g class="moon-annotations">`;
        // The readouts, each beside what it measures: the tilt by its arc, the size under the disc, the libration and the
        // earthshine to either side.
        const ew = l >= 0 ? "E" : "W";
        const ns = b >= 0 ? "N" : "S";
        const libration = `${Math.abs(l).toFixed(1)}° ${ew}, ${Math.abs(b).toFixed(1)}° ${ns}`;
        const shine = `${(earthshine * 100).toFixed(1)}%`;
        const parts = `axis ${axis.toFixed(1)}°, parallactic ${parallactic.toFixed(1)}°`;
        const tiltText = `${tiltDeg.toFixed(1)}° (${parts})`;
        const size = `${(diameter * 60).toFixed(1)}′`;
        if (besides) {
            // Beside the disc, name over value, so they stay narrow.
            const half = line / 2;
            svg += svgText(-SIDE, -half, "libration", "figure-label figure-anchor-end");
            svg += svgText(-SIDE, half, libration, "figure-note figure-anchor-end");
            svg += svgText(SIDE, -half, "earthshine", "figure-label figure-anchor-start");
            svg += svgText(SIDE, half, shine, "figure-note figure-anchor-start");
            // Centered above the tick and the arc, as far up as the size is down.
            if (!locked) svg += readout(0, -firstRow, "tilt", tiltText, "middle");
            svg += readout(0, firstRow, "size", size, "middle");
        } else {
            const corner = halfHeight - cornerRowPx() * unitsPerPx;
            const right = halfWidth - CORNER_PX * unitsPerPx;
            // Both stop short of the download in the corner.
            const beforeDownload = right - 48 * unitsPerPx;
            svg += readout(beforeDownload, -corner, "size", size, "end");
            if (!locked) svg += readout(beforeDownload, -corner + line * 1.25, "tilt", tiltText, "end");
            svg += readout(right, corner - line * 1.25, "libration", libration, "end");
            svg += readout(right, corner, "earthshine", shine, "end");
        }
        svg += "</g>";
        drawSvg(svgEl, svg, unitsPerPx);
        behind?.({
            widthPx: (2 * halfWidth) / unitsPerPx,
            heightPx: (2 * halfHeight) / unitsPerPx,
            unitsPerPx,
            unitsPerRadian: UNITS_PER_RADIAN,
            locked,
            turn: twist - tilt,
            libration: { longitude: l, latitude: b },
        });
    }

    lockButton.addEventListener("click", () => {
        locked = !locked;
        showLocked();
        render();
    });
    for (const side of sides) {
        side.addEventListener("click", () => {
            fromPlace = side.dataset.parallaxFrom === "place";
            showLocked();
            render();
        });
    }
    showLocked();

    opticalButton.addEventListener("click", () => {
        optical = !optical;
        opticalButton.setAttribute("aria-pressed", String(optical));
        render();
    });

    const requestRender = onDemand(render, view);
    onChange(requestRender);
    // Its text keeps the page's small size in screen pixels, so a resized panel redraws.
    new ResizeObserver(requestRender).observe(svgEl);
    if (sketch) new ResizeObserver(requestRender).observe(sketch);
    render();
    return {
        requestRender,
        /** Hands the Moon itself to `renderer`, or takes it back with null: the overlay redraws either way. */
        setBehind(renderer: MoonViewBehind | null) {
            behind = renderer;
            render();
        },
    };
}
