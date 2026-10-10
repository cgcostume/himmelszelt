import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
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
} from "./figure";
import { arrowAround, offPanelArrowSvg } from "./offpanel";
import { ephemerisDay, onChange, state, update } from "./state";
import "./export";

const DEG = precise.DEG_TO_RAD;
// The Moon's disc at perigee gets this radius in the 200 x 200 viewBox; smaller at any other distance.
const PERIGEE_RADIUS = 72;
const PERIGEE_KM = 356_500;
const APOGEE_KM = 406_700;
const radiusAt = (km: number) => Math.asin(precise.moon.MEAN_RADIUS_KM / km);
const UNITS_PER_RADIAN = PERIGEE_RADIUS / radiusAt(PERIGEE_KM);
// Selenographic grid spacing, in degrees.
const GRID_STEP = 30;
// The Sun's normal is this long where it stands on the limb, at first and last quarter, and its head this long.
const SUN_NORMAL_LENGTH = 19;
const SUN_HEAD_LENGTH = 4;
// Past the quarters, the common arrow (see offpanel.ts) on this fixed circle, outside the disc at perigee.
const SUN_CIRCLE = PERIGEE_RADIUS + 9;

const view = find(".moon-view");
const svgEl = find<SVGSVGElement>(".moon-panel > svg", view);
const lockButton = find('[data-field="lockMoon"]', view);
// Locked to the Moon: its north up rather than the zenith, and no horizon, so only the librations still move.
let locked = true;
const opticalButton = find('[data-field="opticalLibration"]', view);
// Off leaves only the physical libration, the Moon's own wobble, well below a pixel here.
let optical = true;
const lunationInput = find<HTMLInputElement>('[data-field="lunation"]');
const lunationValue = find('[data-field="lunationValue"]');
const phasesEl = find('[data-field="phases"]');

// The slider runs through the lunation the moment is in, from one true full moon to the next: the moments the Moon's
// apparent longitude stands 180° from the Sun's. The last quarter is at 270°, the new moon at 0°, the first at 90°.
const { MEAN_NEW_MOON, MEAN_SYNODIC_MONTH } = precise.moon;
const HOUR = 1 / 24;
const SECOND = 1 / 86_400;
const elongation = (jd: number) => {
    const t = ephemerisDay(jd);
    return precise.moon.position(t).longitude + precise.earth.longitudeNutation(t) - precise.sun.apparentLongitude(t);
};
/** When, near `guess`, the elongation reaches `target` degrees: Newton's method on the mean rate, to a second. */
function phaseTime(guess: number, target: number) {
    let jd = guess;
    for (let i = 0; i < 10; i++) {
        const step = ((((((elongation(jd) - target + 180) % 360) + 360) % 360) - 180) / 360) * MEAN_SYNODIC_MONTH;
        jd -= step;
        if (Math.abs(step) < SECOND) break;
    }
    return jd;
}
interface Lunation {
    start: number;
    end: number;
    /** Each phase's moment and elongation, full moon to full moon. */
    phases: [number, number][];
}
function lunationAt(jd: number): Lunation {
    const k = Math.floor((jd - MEAN_NEW_MOON) / MEAN_SYNODIC_MONTH - 0.5);
    let start = phaseTime(MEAN_NEW_MOON + (k + 0.5) * MEAN_SYNODIC_MONTH, 180);
    if (start > jd) start = phaseTime(start - MEAN_SYNODIC_MONTH, 180);
    let end = phaseTime(start + MEAN_SYNODIC_MONTH, 180);
    if (end <= jd) [start, end] = [end, phaseTime(end + MEAN_SYNODIC_MONTH, 180)];
    const between = [270, 0, 90].map((target, i): [number, number] => [
        phaseTime(start + ((i + 1) / 4) * MEAN_SYNODIC_MONTH, target),
        target,
    ]);
    return { start, end, phases: [[start, 180], ...between, [end, 180]] };
}
let lunation = lunationAt(state.jd);

/** A phase as a small disc, lit on the side the Sun is on: the right while waxing, seen from the north. */
function phaseIcon(target: number, north: boolean) {
    const half = (right: boolean) => `<path d="M0,-4A4,4 0 0 ${right ? 1 : 0} 0,4Z"/>`;
    const lit = target === 180 ? '<circle r="4"/>' : target === 0 ? "" : half((target === 90) === north);
    return `<svg viewBox="-5 -5 10 10"><circle r="4" class="phase-outline"/>${lit}</svg>`;
}
const PHASE_NAMES: Record<number, string> = {
    180: "full moon",
    270: "last quarter",
    0: "new moon",
    90: "first quarter",
};

function renderLunation(jd: number) {
    if (jd < lunation.start || jd >= lunation.end) lunation = lunationAt(jd);
    const { start, end, phases } = lunation;
    lunationInput.max = String(Math.floor((end - start) / HOUR));
    lunationInput.value = String(Math.floor((jd - start) / HOUR));
    paintRange(lunationInput);
    lunationValue.textContent = `${(jd - start).toFixed(1)} d`;
    const north = state.latitude >= 0;
    phasesEl.innerHTML = phases
        .map(([at, target]) => {
            const left = (((at - start) / (end - start)) * 100).toFixed(2);
            return `<span class="figure-slider-mark" style="left: ${left}%" title="${PHASE_NAMES[target]}">${phaseIcon(target, north)}</span>`;
        })
        .join("");
}

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
// The Sun's arrows reach this far at most; the readouts stay beyond them, whichever way they point.
const REACH = PERIGEE_RADIUS + SUN_NORMAL_LENGTH;
const SIDE = REACH + 6;

const f = (n: number) => n.toFixed(2);
// A one-line readout, its name muted and its value in full, anchored at `x` by `anchor`.
const readout = (x: number, y: number, name: string, value: string, anchor: string) =>
    `<text x="${f(x)}" y="${f(y)}" dy="0.35em" class="figure-note figure-readout figure-anchor-${anchor}"><tspan class="figure-readout-name">${escapeText(name)}</tspan> ${escapeText(value)}</text>`;
const polyline = (points: (readonly [number, number])[], cls: string) =>
    `<polyline points="${points.map(([x, y]) => `${f(x)},${f(y)}`).join(" ")}" class="${cls}"/>`;

function render() {
    const { jd } = state;
    renderLunation(jd);
    const width = svgEl.parentElement?.clientWidth || 416;
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
    const litScreen = lit.map(([x, y]): [number, number] => [(x * ls - y * lc) * radius, -(x * lc + y * ls) * radius]);
    svg += polyline([...litScreen, ...litScreen.slice(0, 1)], "moon-day");

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

    // The disc's center, the point we look at: the libration is how far the grid's own center has moved from it.
    svg += `<circle r="1.2" class="moon-center"/>`;

    // The Sun: while the point under it faces us, the normal there, towards the Sun and foreshortened as the sphere
    // turns it away, down to a dot at full moon; once that point is on the far side, the common arrow around the disc.
    const [ux, uy] = [ls, -lc];
    const across = Math.hypot(sunFrame.right, sunFrame.up) / Math.hypot(sunFrame.right, sunFrame.up, sunFrame.toward);
    if (sunFrame.toward > 0) {
        const [px, py] = [ux * radius * across, uy * radius * across];
        const length = SUN_NORMAL_LENGTH * across;
        let normal = `<circle cx="${f(px)}" cy="${f(py)}" r="1.8"/>`;
        if (length > SUN_HEAD_LENGTH) {
            const [tx, ty] = [px + ux * length, py + uy * length];
            const [hx, hy] = [tx - ux * SUN_HEAD_LENGTH, ty - uy * SUN_HEAD_LENGTH];
            const shaft = `x1="${f(px)}" y1="${f(py)}" x2="${f(hx)}" y2="${f(hy)}"`;
            normal = `<line ${shaft}/>${normal}`;
            normal += `<polygon points="${f(tx)},${f(ty)} ${f(hx - uy * 2.4)},${f(hy + ux * 2.4)} ${f(hx + uy * 2.4)},${f(hy - ux * 2.4)}"/>`;
        }
        svg += `<g class="moon-sun-normal">${normal}</g>`;
    } else {
        const arrow = arrowAround({ x: 0, y: 0 }, { x: ux, y: uy }, SUN_CIRCLE, unitsPerPx);
        svg += offPanelArrowSvg(arrow, true);
    }

    // The visible horizon, below the Moon by its apparent altitude over it, at the disc's own scale (so it only shows
    // within a few tenths of a degree); the ground beneath veils what it hides.
    if (!locked) {
        const horizon =
            precise.earth.apparentAltitude(horizontal.altitude, { observerHeightM: state.heightM }) *
            DEG *
            UNITS_PER_RADIAN;
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
    const stacked: [string, string][] = [["size", `${(diameter * 60).toFixed(1)}′`]];
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

// The slider moves the moment through the lunation by whole hours and keeps its minutes; never quite to the next full
// moon, where the next lunation begins.
lunationInput.addEventListener("input", () => {
    const { start, end } = lunation;
    const within = (state.jd - start) / HOUR;
    const jd = start + (Number(lunationInput.value) + within - Math.floor(within)) * HOUR;
    const kept = Math.min(Math.max(jd, start + SECOND), end - 60 * SECOND);
    update({ jd: Number(kept.toFixed(7)), live: false, animate: false });
});

const requestRender = onDemand(render, view);
onChange(requestRender);
// Its text keeps the page's small size in screen pixels, so a resized panel redraws.
new ResizeObserver(requestRender).observe(svgEl);
render();
