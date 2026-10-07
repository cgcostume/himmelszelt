import * as precise from "@himmelszelt/sternzeit";
import {
    drawSvg,
    EARTHSHINE_MAX,
    escapeText,
    selenographic,
    sunInViewFrame,
    svgText,
    toScreen,
    veiledHorizon,
    visibleRuns,
} from "./figure.js";
import { aboveVisibleHorizon } from "./horizon.js";
import { ephemerisDay, onChange, state } from "./state.js";
import "./export.js";

const DEG = precise.DEG_TO_RAD;
// The Moon's disc at perigee gets this radius in the 200 x 200 viewBox; smaller at any other distance.
const PERIGEE_RADIUS = 72;
const PERIGEE_KM = 356_500;
const APOGEE_KM = 406_700;
const radiusAt = (km) => Math.asin(precise.moon.MEAN_RADIUS_KM / km);
const UNITS_PER_RADIAN = PERIGEE_RADIUS / radiusAt(PERIGEE_KM);
// Selenographic grid spacing, in degrees.
const GRID_STEP = 30;
const SUN_ARROW_GAP = 5;
const SUN_ARROW_LENGTH = 14;

const view = document.querySelector(".moon-view");
const svgEl = view.querySelector(".moon-panel > svg");
const lockButton = view.querySelector('[data-field="lockMoon"]');
// Locked to the Moon: its north up rather than the zenith, and no horizon, so only the librations still move.
let locked = false;
const opticalButton = view.querySelector('[data-field="opticalLibration"]');
// Off leaves only the physical libration, the Moon's own wobble, well below a pixel here.
let optical = true;

// The panel is wider than the Moon needs: the readouts sit beside it. Its height keeps the disc at the size a 416 px
// square would give it, unless the panel is too narrow for the readouts, when the disc shrinks to make room for them.
const BASE_UNITS_PER_PX = 200 / 416;
// Room a one-line readout beside the disc needs; where the panel lacks it, the readouts move under the disc instead.
const READOUT_WIDTH_PX = 100;
const READOUT_LINE_PX = 16;
// Never lower than this, so a shrunk disc still leaves room above and below it for the tilt and the buttons.
const MIN_HEIGHT_PX = 300;
// The corners' inset and the middle of their row, as for the switches there (see .view-toggle).
const CORNER_PX = 10;
const CORNER_ROW_PX = 20;
// The north tick and the tilt arc reach this far from the center; the readouts start just beyond.
const OUTSIDE = PERIGEE_RADIUS + 3;
// The Sun's arrow reaches this far at most; the readouts stay beyond it, whichever way it points.
const REACH = PERIGEE_RADIUS + SUN_ARROW_GAP + SUN_ARROW_LENGTH;
const SIDE = REACH + 6;

const f = (n) => n.toFixed(2);
// A one-line readout, its name muted and its value in full, anchored at `x` by `anchor`.
const readout = (x, y, name, value, anchor) =>
    `<text x="${f(x)}" y="${f(y)}" dy="0.35em" class="figure-note figure-readout figure-anchor-${anchor}"><tspan class="figure-readout-name">${escapeText(name)}</tspan> ${escapeText(value)}</text>`;
const polyline = (points, cls) =>
    `<polyline points="${points.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" class="${cls}"/>`;

function render() {
    const { jd } = state;
    const width = svgEl.parentElement.clientWidth || 416;
    const besides = (width * BASE_UNITS_PER_PX) / 2 >= SIDE + READOUT_WIDTH_PX * BASE_UNITS_PER_PX;
    const unitsPerPx = Math.max(BASE_UNITS_PER_PX, (2 * (SIDE + 10)) / width);
    const line = READOUT_LINE_PX * unitsPerPx;
    // Under the disc, a row each: its size, then where they do not fit around it the tilt, the libration and the
    // earthshine, and below those the corners' row, with the switch and the note that the Moon is below the horizon.
    const rows = besides ? 1 : locked ? 3 : 4;
    const firstRow = REACH + 10;
    const halfHeight = Math.max(100, firstRow + (rows + (besides ? 1 : 2)) * line, (MIN_HEIGHT_PX / 2) * unitsPerPx);
    const halfWidth = (width * unitsPerPx) / 2;
    svgEl.style.height = `${f((2 * halfHeight) / unitsPerPx)}px`;
    svgEl.setAttribute("viewBox", `${f(-halfWidth)} ${f(-halfHeight)} ${f(2 * halfWidth)} ${f(2 * halfHeight)}`);
    const time = precise.fromJulianDay(jd);
    const diameter = precise.moon.topocentricAngularDiameter(time, state);
    const radius = (diameter / 2) * DEG * UNITS_PER_RADIAN;
    const total = precise.moon.librations(ephemerisDay(jd));
    const opticalPart = optical ? { longitude: 0, latitude: 0 } : precise.moon.opticalLibrations(ephemerisDay(jd));
    const l = total.longitude - opticalPart.longitude;
    const b = total.latitude - opticalPart.latitude;
    const axis = precise.moon.positionAngleOfAxis(ephemerisDay(jd));
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
    svg += `<circle r="${f(radius)}" class="moon-night" style="--earthshine: ${glow.toFixed(3)}"/>`;

    // The lit part: the half disc towards the Sun, closed by the terminator, an ellipse across it.
    const lit = [];
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
    const litScreen = lit.map(([x, y]) => [(x * ls - y * lc) * radius, -(x * lc + y * ls) * radius]);
    svg += polyline([...litScreen, litScreen[0]], "moon-day");

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
    svg += `<circle r="${f(radius)}" class="moon-limb"/>`;
    // Apogee and perigee sizes on top of the disc: the smaller one mostly falls inside it.
    for (const km of [APOGEE_KM, PERIGEE_KM]) {
        svg += `<circle r="${f(radiusAt(km) * UNITS_PER_RADIAN)}" class="moon-reference"/>`;
    }

    // The lunar north pole and the axis' tilt against the zenith, outside the perigee circle so they never overlap it: a
    // tick from the limb along the axis with an N beyond, a dashed tick straight up, and an arc between the two.
    const [nx, ny] = toScreen([0, 1], tilt, 1);
    svg += `<line x1="${f(nx * radius)}" y1="${f(ny * radius)}" x2="${f(nx * (OUTSIDE + 7))}" y2="${f(ny * (OUTSIDE + 7))}" class="moon-axis"/>`;
    svg += svgText(nx * (OUTSIDE + 13), ny * (OUTSIDE + 13), "N", "figure-note");
    const tiltDeg = ((((twist + 180) % 360) + 360) % 360) - 180;
    if (!locked) {
        svg += `<line x1="0" y1="${f(-OUTSIDE)}" x2="0" y2="${f(-(OUTSIDE + 7))}" class="moon-zenith"/>`;
        const arc = Array.from({ length: 25 }, (_, i) => toScreen([0, 1], (tiltDeg * i) / 24, OUTSIDE + 4));
        svg += polyline(arc, "moon-tilt");
    }

    // The libration: an arrow from where the Moon's mean center (0° longitude, 0° latitude) appears to the disc's center,
    // the point we look at; that is how far, and which way, we see around the Moon's edge.
    const mean = toScreen(selenographic(0, 0, l, b), tilt, radius);
    const shift = Math.hypot(mean[0], mean[1]);
    svg += `<circle r="1.2" class="moon-libration-dot"/>`;
    if (shift > 5) {
        // Ends just short of the center's dot, so the head stays visible.
        const [ux, uy] = [-mean[0] / shift, -mean[1] / shift];
        const [tx, ty] = [-ux * 2, -uy * 2];
        const [hx, hy] = [tx - ux * 3, ty - uy * 3];
        svg += `<line x1="${f(mean[0])}" y1="${f(mean[1])}" x2="${f(hx)}" y2="${f(hy)}" class="moon-libration"/>`;
        svg += `<polygon points="${f(tx)},${f(ty)} ${f(hx - uy * 1.6)},${f(hy + ux * 1.6)} ${f(hx + uy * 1.6)},${f(hy - ux * 1.6)}" class="moon-libration-dot"/>`;
    }

    // The Sun: an arrow off the bright limb.
    const [ux, uy] = [ls, -lc];
    const [ax, ay] = [ux * (radius + SUN_ARROW_GAP), uy * (radius + SUN_ARROW_GAP)];
    const [tx, ty] = [
        ux * (radius + SUN_ARROW_GAP + SUN_ARROW_LENGTH),
        uy * (radius + SUN_ARROW_GAP + SUN_ARROW_LENGTH),
    ];
    const [hx, hy] = [tx - ux * 4, ty - uy * 4];
    svg += `<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(hx)}" y2="${f(hy)}" class="moon-sun-arrow"/>`;
    svg += `<polygon points="${f(tx)},${f(ty)} ${f(hx - uy * 2.4)},${f(hy + ux * 2.4)} ${f(hx + uy * 2.4)},${f(hy - ux * 2.4)}" class="moon-sun-head"/>`;

    // The visible horizon, below the Moon by its apparent altitude over it, at the disc's own scale (so it only shows
    // within a few tenths of a degree); the ground beneath veils what it hides.
    if (!locked) {
        const horizon = aboveVisibleHorizon(horizontal.altitude, state.heightM) * DEG * UNITS_PER_RADIAN;
        svg += veiledHorizon(horizon, halfHeight, unitsPerPx, halfWidth, {
            // In the bottom right corner, level with the switch in the bottom left one.
            x: halfWidth - CORNER_PX * unitsPerPx,
            y: halfHeight - CORNER_ROW_PX * unitsPerPx,
            cls: "figure-note figure-anchor-end",
        });
    }

    // The readouts, each beside what it measures: the tilt by its arc, the size under the disc, the libration and the
    // earthshine to either side.
    const ew = l >= 0 ? "E" : "W";
    const ns = b >= 0 ? "N" : "S";
    const libration = `${Math.abs(l).toFixed(1)}° ${ew}, ${Math.abs(b).toFixed(1)}° ${ns}`;
    // With its phase factor: how full the Earth looks from the Moon, 1 at new moon, where the earthshine peaks.
    const shine = `${(earthshine * 100).toFixed(1)}% (Earth's phase ${(earthshine / EARTHSHINE_MAX).toFixed(2)})`;
    const parts = `axis ${axis.toFixed(1)}°, parallactic ${parallactic.toFixed(1)}°`;
    const tiltText = `${tiltDeg.toFixed(1)}° (${parts})`;
    const stacked = [["size", `${(diameter * 60).toFixed(1)}′`]];
    if (besides) {
        // Beside the disc, name over value, so they stay narrow.
        const half = line / 2;
        svg += svgText(-SIDE, -half, "libration", "figure-label figure-anchor-end");
        svg += svgText(-SIDE, half, libration, "figure-note figure-anchor-end");
        svg += svgText(SIDE, -half, "earthshine", "figure-label figure-anchor-start");
        svg += svgText(SIDE, half, shine, "figure-note figure-anchor-start");
        // Centered above the tick and the arc, as far up as the size is down.
        if (!locked) svg += readout(0, -firstRow, "tilt", tiltText, "middle");
    } else {
        if (!locked) stacked.push(["tilt", tiltText]);
        stacked.push(["libration", libration], ["earthshine", shine]);
    }
    stacked.forEach(([name, value], i) => {
        svg += readout(0, firstRow + i * line, name, value, "middle");
    });
    drawSvg(svgEl, svg, unitsPerPx);
}

lockButton.addEventListener("click", () => {
    locked = !locked;
    lockButton.setAttribute("aria-pressed", String(locked));
    render();
});

opticalButton.addEventListener("click", () => {
    optical = !optical;
    opticalButton.setAttribute("aria-pressed", String(optical));
    render();
});

onChange(render);
// Its text keeps the page's small size in screen pixels, so a resized panel redraws.
new ResizeObserver(render).observe(svgEl);
render();
