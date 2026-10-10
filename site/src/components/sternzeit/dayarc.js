import * as precise from "@himmelszelt/sternzeit";
import Zdog from "zdog";
import { onDemand } from "../frame.js";
import {
    alongVerticalCircle,
    COMPASS,
    cssColor,
    drawSvg,
    gridLine,
    labelAboveY,
    SUN_SYMBOL,
    sunRays,
    sunSymbol,
    svgText,
} from "./figure.js";
import { onChange, state } from "./state.js";
import "./export.js";

const { Illustration, Anchor, Shape, Ellipse, Vector } = Zdog;
const DEG = precise.DEG_TO_RAD;

// The sky dome's radius in scene units; the whole scene is zoomed to fit its frame.
const R = 100;
// Paths cover the local mean solar day of the chosen moment, midnight to midnight, sampled every 10 minutes: one dot
// per hour on the Sun's.
const SAMPLES_PER_HOUR = 6;
const HOURS = 24;
// The analemma: the Sun at the same time of day, on every day of the half year before and after the moment.
const ANALEMMA_DAYS = 182;
// Half the analemma panel's width and its height in degrees: some 47 degrees of analemma, with room around it.
const ANALEMMA_HALF_WIDTH = 25;
const ANALEMMA_HEIGHT = 110;
// The dome sits below the frame's middle: seen from high up it reaches as far above the horizon plane as the sky
// grid does, and centered it would be cut off at the top.
const CENTER_SHIFT = 0.04;
// The view is kept above the horizon plane (the ground layer only veils what is below it from above).
const TILT_MIN = -85 * DEG;
const TILT_MAX = -8 * DEG;
const DRAG_RADIANS_PER_PX = 0.008;

const INK = cssColor("--text", "#c5c9d2");
const MUTED = cssColor("--muted", "#808899");
const SURFACE = cssColor("--surface", "#12151c");
const ACCENT = cssColor("--accent", "#5aa9ff");

const frameEl = document.querySelector(".dome-scene");
const compassEl = frameEl.querySelector(".dome-compass");
const analemmaPanel = frameEl.querySelector(".analemma-panel");
const analemmaSvg = analemmaPanel.querySelector(":scope > svg");
const analemmaNote = frameEl.querySelector('[data-field="analemmaNote"]');

// Strokes are in screen pixels (see .zdog in global.css); the dash patterns are classes there too, set on each shape's
// SVG element once it has one.
const dashes = new Map();
const DOTTED = "line-dotted";
const DASHED = "line-dashed";
let zoom = 1;
let stageWidth = 0;
let stageHeight = 0;
let centerShiftPx = 0;
// Seen from the southeast and a little above, so a day arc, a circle tilted towards the south, shows as an ellipse.
const rotation = { x: -20 * DEG, y: 40 * DEG, z: 0 };

function styled(shape, strokePx, dash = null) {
    if (dash) dashes.set(shape, dash);
    shape.stroke = strokePx;
    return shape;
}

// Zdog sorts shapes by their center only, which gets a dome's near and far sides wrong. Three stacked illustrations
// sort by construction instead: whatever is below the horizon, the translucent ground, whatever is above.
function layer(name) {
    return new Illustration({
        element: frameEl.querySelector(`.dome-layer[data-layer="${name}"]`),
        resize: true,
        rotate: rotation,
        onResize: function (width, height) {
            stageWidth = width;
            stageHeight = height;
            zoom = Math.min(width / 2 / (R * 1.2), height / 2 / (R * 1.1));
            centerShiftPx = height * CENTER_SHIFT;
            this.translate.y = centerShiftPx / zoom;
            this.zoom = zoom;
            this.setSize(width, height);
        },
    });
}
const below = layer("below");
const ground = layer("ground");
const above = layer("above");
const layers = [below, ground, above];

// Every altitude here is over the visible horizon, as in the other figures: lifted by refraction, the horizon lowered by
// the observer's height (see earth.apparentAltitude). So rising and setting line up with the horizon ring and line to the second.
function seen(body, time, latitude, longitude) {
    const horizontal = body.horizontalPosition(time, { latitude, longitude, heightM: state.heightM });
    return {
        ...horizontal,
        altitude: precise.earth.apparentAltitude(horizontal.altitude, { observerHeightM: state.heightM }),
    };
}

// ENU to Zdog, which is y down and z towards the viewer: x east, y up (negated), z north (negated, away from the viewer).
function skyPoint(horizontal, radius = R) {
    const [e, n, u] = precise.horizontalToDirection(horizontal);
    return { x: e * radius, y: -u * radius, z: -n * radius };
}

// Fixed references: the ground and the horizon, and dotted, two altitude circles, the meridian and the prime vertical.
new Ellipse({ addTo: ground, diameter: 2 * R, rotate: { x: Math.PI / 2 }, color: SURFACE, fill: true, stroke: false });
styled(new Ellipse({ addTo: ground, diameter: 2 * R, rotate: { x: Math.PI / 2 }, color: ACCENT }), 1);
for (const altitude of [30, 60]) {
    const ring = new Ellipse({
        addTo: above,
        diameter: 2 * R * Math.cos(altitude * DEG),
        translate: { y: -R * Math.sin(altitude * DEG) },
        rotate: { x: Math.PI / 2 },
        color: MUTED,
    });
    styled(ring, 1, DOTTED);
}
// Half a great circle from the horizon at `azimuth` over the zenith to the opposite horizon.
const overhead = (azimuth) =>
    Array.from({ length: 37 }, (_, i) =>
        skyPoint(i <= 18 ? { azimuth, altitude: i * 5 } : { azimuth: azimuth + 180, altitude: 180 - i * 5 }),
    );
styled(new Shape({ addTo: above, path: overhead(0), closed: false, color: MUTED }), 1, DOTTED);
styled(new Shape({ addTo: above, path: overhead(90), closed: false, color: MUTED }), 1, DOTTED);
styled(new Shape({ addTo: above, color: INK }), 4);

// The day's paths and the two bodies, rebuilt whenever the moment or place changes.
const dynamic = [new Anchor({ addTo: below }), new Anchor({ addTo: above })];

// The labels sit this far outside the horizon ring, in screen pixels. Pushing them out in scene units instead would
// space them unevenly: the ring projects to a flat ellipse, where a radial step moves east and west much further
// from it than north and south.
const COMPASS_LABEL_GAP_PX = 14;

const compassLabels = COMPASS.map((text, i) => {
    const label = document.createElement("span");
    label.className = "dome-compass-label";
    label.dataset.exportText = "";
    label.textContent = text;
    compassEl.append(label);
    return { label, point: skyPoint({ azimuth: i * 45, altitude: 0 }, R) };
});

/** Julian Day of local mean solar noon on the moment's day: JDs are integers at noon UT, shifted by the longitude. */
const localNoon = (jd, longitude) => Math.round(jd + longitude / 360) - longitude / 360;

function samplePath(body, noon, latitude, longitude) {
    const count = HOURS * SAMPLES_PER_HOUR;
    return Array.from({ length: count + 1 }, (_, i) =>
        seen(body, precise.fromJulianDay(noon + (i - count / 2) / count), latitude, longitude),
    );
}

/** Splits a path into runs above and below the horizon; consecutive runs share their boundary sample. */
function runsByHorizon(samples) {
    const runs = [];
    for (const sample of samples) {
        const up = sample.altitude >= 0;
        const last = runs.at(-1);
        if (last?.up === up) last.samples.push(sample);
        else runs.push({ up, samples: last ? [last.samples.at(-1), sample] : [sample] });
    }
    return runs;
}

const anchorFor = (altitude) => dynamic[altitude >= 0 ? 1 : 0];

function addPath(samples, color, strokePx, dashBelow) {
    for (const run of runsByHorizon(samples)) {
        const path = run.samples.map((s) => skyPoint(s));
        const shape = new Shape({ addTo: dynamic[run.up ? 1 : 0], path, closed: false, color });
        styled(shape, strokePx, run.up ? null : dashBelow);
    }
}

// Arrowheads along each path, pointing forward in time: one every 6 hours, starting at 3 in the morning.
const ARROW_EVERY = 6 * SAMPLES_PER_HOUR;
const ARROW_OFFSET = 3 * SAMPLES_PER_HOUR;
const ARROW_LENGTH = 6;
const ARROW_HALF_WIDTH = 3;

/** A flat arrowhead at sample `i`, lying in the dome's surface and pointing towards sample `i + 1`. */
function addArrow(samples, i, color) {
    const tip = skyPoint(samples[i]);
    const next = skyPoint(samples[i + 1]);
    const d = new Vector(next).subtract(tip);
    d.multiply(1 / d.magnitude());
    // Perpendicular to both the path and the radius: sideways within the dome's surface.
    const side = new Vector({
        x: d.y * tip.z - d.z * tip.y,
        y: d.z * tip.x - d.x * tip.z,
        z: d.x * tip.y - d.y * tip.x,
    });
    side.multiply(ARROW_HALF_WIDTH / side.magnitude());
    const back = new Vector(tip).subtract(new Vector(d).multiply(ARROW_LENGTH));
    const path = [tip, new Vector(back).add(side), new Vector(back).subtract(side)];
    styled(new Shape({ addTo: anchorFor(samples[i].altitude), path, fill: true, color }), 1);
}

function addArrows(samples, color) {
    for (let i = ARROW_OFFSET; i < samples.length - 1; i += ARROW_EVERY) addArrow(samples, i, color);
}

function addDot(horizontal, color, strokePx) {
    styled(new Shape({ addTo: anchorFor(horizontal.altitude), translate: skyPoint(horizontal), color }), strokePx);
}

// The Sun and the Moon are the same size here; the Sun is told apart by the same ring of dotted rays it wears in the
// locked views (SUN_SYMBOL), always square to the viewer (see frame()).
const BODY_DOT_PX = 2 * SUN_SYMBOL.radius;
const billboards = [];

function addSunRays(horizontal) {
    const at = new Anchor({ addTo: anchorFor(horizontal.altitude), translate: skyPoint(horizontal) });
    const yaw = new Anchor({ addTo: at });
    const face = new Anchor({ addTo: yaw });
    billboards.push({ yaw, face });
    for (const path of sunRays()) styled(new Shape({ addTo: face, path, color: INK }), 1, "figure-sun-ray");
}

function rebuildPaths() {
    const { jd, latitude, longitude } = state;
    billboards.length = 0;
    for (const anchor of dynamic) {
        for (const child of [...anchor.children]) {
            dashes.delete(child);
            child.remove();
        }
    }
    const noon = localNoon(jd, longitude);
    const sunSamples = samplePath(precise.sun, noon, latitude, longitude);
    const moonSamples = samplePath(precise.moon, noon, latitude, longitude);
    addPath(moonSamples, MUTED, 1, DASHED);
    addPath(sunSamples, INK, 1.5, DOTTED);
    addArrows(moonSamples, MUTED);
    addArrows(sunSamples, INK);
    sunSamples.forEach((sample, i) => {
        if (i % SAMPLES_PER_HOUR === 0 && sample.altitude >= 0) addDot(sample, INK, 4);
    });
    const time = precise.fromJulianDay(jd);
    addDot(seen(precise.moon, time, latitude, longitude), MUTED, BODY_DOT_PX);
    const sunNow = seen(precise.sun, time, latitude, longitude);
    addDot(sunNow, INK, BODY_DOT_PX);
    addSunRays(sunNow);
}

function renderAnalemma() {
    const { jd, latitude, longitude } = state;
    const today = seen(precise.sun, precise.fromJulianDay(jd), latitude, longitude);
    // Seen along the vertical circle through today's Sun, smooth past the zenith (see alongVerticalCircle).
    const project = (horizontal) => alongVerticalCircle(horizontal, today.azimuth);
    const points = [];
    for (let day = -ANALEMMA_DAYS; day <= ANALEMMA_DAYS; day++) {
        const sun = seen(precise.sun, precise.fromJulianDay(jd + day), latitude, longitude);
        const firstOfMonth = precise.dateFromJulianDay(jd + day).getUTCDate() === 1;
        points.push({ day, firstOfMonth, ...project(sun) });
    }
    // A fixed scale, so analemmas from different places compare directly, always centered on the analemma, so it glides
    // rather than jumps as the moment and place change. The viewBox is fitted into the panel keeping its aspect ratio, so
    // the larger scale applies.
    const unitsPerPx = Math.max(
        (2 * ANALEMMA_HALF_WIDTH) / (analemmaSvg.clientWidth || 1),
        ANALEMMA_HEIGHT / (analemmaSvg.clientHeight || 1),
    );
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const [x0, y0] = [centerX - ANALEMMA_HALF_WIDTH, centerY - ANALEMMA_HEIGHT / 2];
    analemmaSvg.setAttribute("viewBox", `${x0} ${y0} ${2 * ANALEMMA_HALF_WIDTH} ${ANALEMMA_HEIGHT}`);

    const f = (n) => n.toFixed(3);
    // The panel may be wider than the viewBox's aspect ratio, so the ground and lines reach well past it.
    const [left, right] = [centerX - 1000, centerX + 1000];
    let svg = `<rect x="${f(left)}" y="0" width="${f(right - left)}" height="1090" class="figure-ground"/>`;
    // The panel's own left edge, not the far end of the ground rectangle, is where the altitude labels belong.
    const visibleLeft = centerX - ((analemmaSvg.clientWidth || 1) / 2) * unitsPerPx;
    // Past the zenith the altitude falls again, on the far side of the sky, and past the nadir it rises again.
    // A line whose label would be cut by the panel's top or bottom edge is left out.
    const reach = ((analemmaSvg.clientHeight || 1) / 2 - 10) * unitsPerPx;
    for (const angle of [-150, -120, -90, -60, -30, 30, 60, 90, 120, 150]) {
        if (Math.abs(-angle - centerY) > reach) continue;
        const altitude = angle > 90 ? 180 - angle : angle < -90 ? -180 - angle : angle;
        svg += gridLine(-angle, visibleLeft, right, `${altitude}°`, unitsPerPx);
    }
    svg += `<line x1="${f(left)}" y1="0" x2="${f(right)}" y2="0" class="figure-horizon"/>`;
    // The compass directions on the horizon, where the x axis is plain azimuth (cos 0 = 1), relative to today's; only
    // those that fit whole into the panel, which shows its width in pixels times unitsPerPx.
    const labelReach = ((analemmaSvg.clientWidth || 1) / 2 - 12) * unitsPerPx;
    COMPASS.forEach((label, i) => {
        const x = ((i * 45 - today.azimuth + 540) % 360) - 180;
        if (Math.abs(x - centerX) < labelReach) svg += svgText(x, labelAboveY(0, unitsPerPx), label, "figure-label");
    });
    svg += `<polyline points="${points.map((p) => `${f(p.x)},${f(p.y)}`).join(" ")}" class="analemma-line"/>`;
    // A dot on the 1st of every month: fixed on the curve while the Sun moves along it, and their spacing shows its pace.
    for (const p of points) {
        if (!p.firstOfMonth) continue;
        svg += `<circle cx="${f(p.x)}" cy="${f(p.y)}" r="0.9" class="analemma-tick"/>`;
    }
    svg += sunSymbol(0, -today.altitude, unitsPerPx);
    drawSvg(analemmaSvg, svg, unitsPerPx);
    analemmaNote.textContent = points.every((p) => p.y > 0) ? ", below the horizon at this hour" : "";
}

// Where the analemma panel covers the scene, in scene coordinates: the compass labels that fall behind it are left
// out, since the horizon they belong to is hidden there and they would read as floating free. Measured on resize
// only, not per frame.
let panelBox = null;
function measurePanel() {
    const scene = frameEl.getBoundingClientRect();
    const box = analemmaPanel.getBoundingClientRect();
    panelBox = {
        left: box.left - scene.left,
        top: box.top - scene.top,
        right: box.right - scene.left,
        bottom: box.bottom - scene.top,
    };
}

function placeCompass() {
    for (const { label, point } of compassLabels) {
        const p = new Vector(point).rotate(rotation);
        const reach = Math.hypot(p.x, p.y) || 1;
        const [x, y] = [
            stageWidth / 2 + p.x * zoom + (p.x / reach) * COMPASS_LABEL_GAP_PX,
            stageHeight / 2 + centerShiftPx + p.y * zoom + (p.y / reach) * COMPASS_LABEL_GAP_PX,
        ];
        const covered = panelBox && x > panelBox.left && x < panelBox.right && y > panelBox.top && y < panelBox.bottom;
        label.style.left = `${x}px`;
        label.style.top = `${y}px`;
        label.style.visibility = covered ? "hidden" : "visible";
        label.style.opacity = p.z < 0 ? 0.45 : 1;
    }
}

let dragFrom = null;
frameEl.addEventListener("pointerdown", (event) => {
    // Not over the analemma, which floats on top of the dome.
    if (event.target.closest(".analemma-panel")) return;
    dragFrom = { x: event.clientX, y: event.clientY };
    frameEl.setPointerCapture(event.pointerId);
});
frameEl.addEventListener("pointermove", (event) => {
    if (!dragFrom) return;
    rotation.y -= (event.clientX - dragFrom.x) * DRAG_RADIANS_PER_PX;
    rotation.x = Math.min(
        TILT_MAX,
        Math.max(TILT_MIN, rotation.x - (event.clientY - dragFrom.y) * DRAG_RADIANS_PER_PX),
    );
    dragFrom = { x: event.clientX, y: event.clientY };
    requestFrame();
});
frameEl.addEventListener("pointerup", () => {
    dragFrom = null;
});

function frame() {
    // Undoing the scene's rotation, outermost turn first, leaves these anchors facing the viewer; the scale makes
    // their own units screen pixels.
    for (const { yaw, face } of billboards) {
        yaw.rotate.set({ x: 0, y: -rotation.y, z: 0 });
        face.rotate.set({ x: -rotation.x, y: 0, z: 0 });
        face.scale.set({ x: 1 / zoom, y: 1 / zoom, z: 1 / zoom });
    }
    for (const illustration of layers) {
        illustration.rotate.set(rotation);
        illustration.updateRenderGraph();
    }
    for (const [shape, dash] of dashes) shape.svgElement?.classList.add(dash);
    placeCompass();
}

// Drawn only when something changed: a drag, a resize or the moment and place.
const requestFrame = onDemand(frame);

function update() {
    rebuildPaths();
    renderAnalemma();
    requestFrame();
}

onChange(update);
// The analemma's text keeps the page's small size in screen pixels, so a resized panel redraws it, and the compass
// labels find out where the panel now covers the scene.
new ResizeObserver(() => {
    renderAnalemma();
    measurePanel();
    requestFrame();
}).observe(analemmaSvg);
new ResizeObserver(requestFrame).observe(frameEl);
update();
