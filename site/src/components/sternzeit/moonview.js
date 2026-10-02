import * as precise from "@himmelszelt/sternzeit";
import { drawSvg, sunInViewFrame, svgText, veiledHorizon } from "./figure.js";
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
// Earthshine peaks at about this (relative to full sunlight, see moon.earthshine); rays reach full length there.
const EARTHSHINE_MAX = 0.095;
const EARTHSHINE_RAY_COUNT = 11;
const EARTHSHINE_RAY_GAP = 4;
const EARTHSHINE_RAY_MAX = 14;
const SUN_ARROW_GAP = 5;
const SUN_ARROW_LENGTH = 14;

const view = document.querySelector(".moon-view");
const svgEl = view.querySelector(".moon-panel > svg");
const statusEl = view.querySelector('[data-field="status"]');
const lockButton = view.querySelector('[data-field="lockMoon"]');
// Locked to the Moon: its north up rather than the zenith, and no horizon, so only the librations still move.
let locked = false;
const opticalButton = view.querySelector('[data-field="opticalLibration"]');
// Off leaves only the physical libration, the Moon's own wobble, well below a pixel here.
let optical = true;

const f = (n) => n.toFixed(2);
const polyline = (points, cls) =>
    `<polyline points="${points.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" class="${cls}"/>`;

/**
 * A point on the Moon at selenographic longitude `lon` and latitude `lat` (degrees), seen with the sub-observer point at
 * (`l`, `b`), the libration: x right (selenographic east, which is sky west), y up (lunar north), z towards the viewer.
 */
function selenographic(lon, lat, l, b) {
    const [dl, la, bb] = [(lon - l) * DEG, lat * DEG, b * DEG];
    return [
        Math.cos(la) * Math.sin(dl),
        Math.sin(la) * Math.cos(bb) - Math.cos(la) * Math.sin(bb) * Math.cos(dl),
        Math.sin(la) * Math.sin(bb) + Math.cos(la) * Math.cos(bb) * Math.cos(dl),
    ];
}

/** Rotates (x right, y up) counterclockwise by `angle` degrees and flips y for SVG (y down). */
function toScreen([x, y], angle, radius) {
    const [c, s] = [Math.cos(angle * DEG), Math.sin(angle * DEG)];
    return [(x * c - y * s) * radius, -(x * s + y * c) * radius];
}

/** Splits a curve on the Moon into the runs facing the viewer (z > 0), in screen coordinates. */
function visibleRuns(points, angle, radius) {
    const runs = [];
    let run = null;
    for (const p of points) {
        if (p[2] > 0) {
            if (!run) {
                run = [];
                runs.push(run);
            }
            run.push(toScreen(p, angle, radius));
        } else run = null;
    }
    return runs.filter((r) => r.length > 1);
}

function render() {
    const { jd } = state;
    const unitsPerPx = 200 / (svgEl.clientWidth || 200);
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
    svg += `<circle r="${f(radius)}" class="moon-night"/>`;

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
    const outside = PERIGEE_RADIUS + 3;
    const [nx, ny] = toScreen([0, 1], tilt, 1);
    svg += `<line x1="${f(nx * radius)}" y1="${f(ny * radius)}" x2="${f(nx * (outside + 7))}" y2="${f(ny * (outside + 7))}" class="moon-axis"/>`;
    svg += svgText(nx * (outside + 13), ny * (outside + 13), "N", "figure-note");
    const tiltDeg = ((((twist + 180) % 360) + 360) % 360) - 180;
    if (!locked) {
        svg += `<line x1="0" y1="${f(-outside)}" x2="0" y2="${f(-(outside + 7))}" class="moon-zenith"/>`;
        const arc = Array.from({ length: 25 }, (_, i) => toScreen([0, 1], (tiltDeg * i) / 24, outside + 4));
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

    // Earthshine: rays around the night side's limb, their length following its strength.
    const rayLength = (Math.min(earthshine, EARTHSHINE_MAX) / EARTHSHINE_MAX) * EARTHSHINE_RAY_MAX;
    if (rayLength > 0.5) {
        for (let i = 0; i < EARTHSHINE_RAY_COUNT; i++) {
            const a = limb + Math.PI / 2 + ((i + 0.5) / EARTHSHINE_RAY_COUNT) * Math.PI;
            const [rx, ry] = [Math.sin(a), -Math.cos(a)];
            const [r0, r1] = [radius + EARTHSHINE_RAY_GAP, radius + EARTHSHINE_RAY_GAP + rayLength];
            svg += `<line x1="${f(rx * r0)}" y1="${f(ry * r0)}" x2="${f(rx * r1)}" y2="${f(ry * r1)}" class="moon-earthshine"/>`;
        }
    }

    // The visible horizon, below the Moon by its apparent altitude over it, at the disc's own scale (so it only shows
    // within a few tenths of a degree); the ground beneath veils what it hides.
    if (!locked) {
        const horizon = aboveVisibleHorizon(horizontal.altitude, state.heightM) * DEG * UNITS_PER_RADIAN;
        svg += veiledHorizon(horizon, 100, unitsPerPx);
    }
    drawSvg(svgEl, svg, unitsPerPx);

    const minutes = diameter * 60;
    const ew = l >= 0 ? "E" : "W";
    const ns = b >= 0 ? "N" : "S";
    const tiltText = locked
        ? ""
        : `tilt ${tiltDeg.toFixed(1)}° (axis ${axis.toFixed(1)}° − parallactic ${parallactic.toFixed(1)}°); `;
    statusEl.innerHTML =
        `<span class="status-title">lunar libration</span> ${Math.abs(l).toFixed(1)}° ${ew}, ${Math.abs(b).toFixed(1)}° ${ns}; ` +
        tiltText +
        `${minutes.toFixed(1)}′ across; earthshine ${(earthshine * 100).toFixed(1)}%`;
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
