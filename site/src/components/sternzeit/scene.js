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
    moonSymbol,
    SUN_SYMBOL,
    sunInViewFrame,
    sunSymbol,
    svgText,
} from "./figure.js";
import { aboveVisibleHorizon } from "./horizon.js";
import { arrowAround, offPanelArrowSvg } from "./offpanel.js";
import { ephemerisDay, onChange, state } from "./state.js";
import "./export.js";

const { Illustration, Anchor, Shape, Ellipse, Vector } = Zdog;
const DEG = precise.DEG_TO_RAD;

// Schematic, not to scale: sizes/distances chosen for visibility, not physical proportion. MOON_DIST/
// SUN_DIST aren't simply EARTH_R*2 scaled: the whole scene auto-zooms to fit the viewport (see
// Illustration's onResize below), so a uniform scale-up of every constant would render identically after
// that zoom. Instead these keep the same clearance gaps as before EARTH_R doubled, so Earth reads as
// bigger relative to the sun/moon, not just bigger in an auto-zoom-cancelled absolute sense.
const EARTH_R = 80;
// Narrower gap than a strict distance scale would give (moon:sun is really ~1:390): keeps the sun where
// it was and brings the moon closer to it, still clearly nearer but not as separated as before.
const MOON_DIST = 320;
const SUN_DIST = 460;

// Disc *sizes* (unlike positions/distances above) ARE to real proportion: both discs are drawn from
// apparentAngularDiameter each frame (see frame() below), so unlike everything else in this schematic,
// their ratio matches what an observer would actually see, near 1:1 most of the time, and shifting with
// real perigee/apogee and perihelion/aphelion, exactly as the difference between annular and total solar
// eclipses does in reality. SUN_R is only a reference size, chosen to read well at this scene's scale, that
// APPARENT_SIZE_SCALE is derived from so the sun starts out at roughly its old, hand-picked diameter.
const SUN_R = 32;
const APPARENT_SIZE_SCALE = (SUN_R * 2) / precise.sun.apparentAngularDiameter(precise.J2000);

const KM_TO_SCENE = EARTH_R / precise.earth.MEAN_RADIUS_KM;
const ATMOSPHERE_SHELL_DIAMETER = 2 * (EARTH_R + precise.earth.ATMOSPHERE_THICKNESS_KM * KM_TO_SCENE);
const PAGE_ACCENT = cssColor("--accent", "#5aa9ff");
// Every stroke that was plain black on the old light page: the site's text color, so the scene follows the theme.
const INK = cssColor("--text", "#c5c9d2");
// The Moon's color in every figure except the eclipse panels (which show how it really looks): muted grey.
const MOON_INK = cssColor("--muted", "#808899");

function v(x, y, z) {
    return { x, y, z };
}
function vScale(a, s) {
    return v(a.x * s, a.y * s, a.z * s);
}

// Earth-centered equatorial frame: RA=0/dec=0 is the +X axis, the celestial equator is the XZ plane,
// +dec is -Y (Zdog is screen-convention y-down, so "up"/north is negative y). Used for every body
// (sun/moon apparentPosition) and, via siderealTime + longitude standing in for RA, for points on Earth's
// own surface, so a ground point's position here rotates in sync with the sky exactly as it does in reality.
function sphericalToVector(raDeg, decDeg, radius) {
    const ra = raDeg * DEG;
    const dec = decDeg * DEG;
    return v(radius * Math.cos(dec) * Math.cos(ra), -radius * Math.sin(dec), radius * Math.cos(dec) * Math.sin(ra));
}

// A circle's default normal is its local +Z (see equatorRing's rotate:{x:PI/2} comment above); this finds
// the rotate.x/rotate.y that points that normal at `dir` (any unit vector). Derived by inverting Zdog's own
// rotateY-then-rotateX rotation chain (rotateZ, then rotateY, then rotateX; see Vector.prototype.rotate in
// node_modules/zdog/dist/zdog.dist.js) applied to (0,0,1): the result is (-sin(ry), -cos(ry)*sin(rx),
// cos(ry)*cos(rx)); solved for rx/ry given a target. The twist around the normal (the remaining free
// parameter) doesn't matter since a circle is rotationally symmetric about it.
function rotateToFace(dir) {
    return { x: Math.atan2(-dir.y, dir.z), y: Math.asin(-dir.x), z: 0 };
}

// A camera-facing (billboarded) circle: rather than a fixed world-space normal like rotateToFace targets,
// this one needs to always present +Z in *screen* space, i.e. counter whatever the scene's own rotX/rotY
// currently are. Derived by working out what local normal, once carried through the scene's own
// rotateY(rotY)-then-rotateX(rotX) (illustration.rotate below), lands back on screen-facing (0,0,1): that
// target is (cos(rotX)*sin(rotY), sin(rotX), cos(rotX)*cos(rotY)), fed into rotateToFace like any other
// target direction (a circle's own twist around its normal still doesn't matter, so this reuses it as-is).
function billboardRotate(rotX, rotY) {
    const cx = Math.cos(rotX);
    return rotateToFace(v(cx * Math.sin(rotY), Math.sin(rotX), cx * Math.cos(rotY)));
}

// The stage's size, for the annotations laid over it.
let stageWidth = 0;
let stageHeight = 0;

const illustration = new Illustration({
    element: "#stage",
    zoom: 1,
    resize: true,
    // setSizeSvg() computes the viewBox from `zoom` before this callback runs, so a plain assignment here
    // would leave a stale viewBox until the next resize; setSize() re-derives it with the new zoom. Uses
    // `this` (Zdog calls it as this.onResize(...)) rather than closing over `illustration`: onResize fires
    // synchronously during the `new Illustration(...)` call below, before that const binding exists.
    onResize: function (width, height) {
        stageWidth = width;
        stageHeight = height;
        // Most of the Sun's orbit in view: about as wide as the stage, as tall as a wide stage allows.
        this.zoom = Math.min(width * 0.52, height * 0.8) / (SUN_DIST + SUN_R);
        this.setSize(width, height);
    },
});

// Earth is shown implicitly, not as a drawn sphere/grid: just the two circles that pass through the
// observer (their latitude ring and their meridian), crossing exactly at the observer marker. Both
// orientations are fixed (lat rings always have plane-normal Y, meridians always contain the Y axis, see
// sphericalToVector's comment); only diameter/translate/rotate change per frame to track lat/long.
const earthAnchor = new Anchor({ addTo: illustration });
// Three-tier line-style scheme, tracking how far a line is from "the answer": dotted = fixed reference,
// independent of both JD and location (equator, rotation axis, ecliptic pole below); dashed = construction
// lines derived from the inputs but not themselves the result (the observer's lat/long rings); solid = the
// actual current fact the rest exists to locate (the radius line + observer marker). Zdog has no dashed
// strokes, so the patterns are classes from global.css, set in frame().
const equatorRing = new Ellipse({
    addTo: earthAnchor,
    diameter: 2 * EARTH_R,
    rotate: { x: Math.PI / 2 },
    color: INK,
    stroke: 1,
    fill: false,
});
// The rotation axis reaches past the globe at both poles, the way a globe's spindle does: it is the one line here
// that is a real axis rather than a circle drawn on Earth, and the overhang says so at a glance.
const AXIS_OVERHANG = 1.5;
const axisLine = new Shape({
    addTo: earthAnchor,
    path: [v(0, -AXIS_OVERHANG * EARTH_R, 0), v(0, AXIS_OVERHANG * EARTH_R, 0)],
    stroke: 1,
    color: INK,
});
// Which way Earth turns, as an arrow curving around the axis above the north pole, clear of the globe itself: west
// to east, carrying every point on the surface towards increasing right ascension (+X towards +Z here). Built from
// right ascension 0 and turned to the observer's meridian each frame (see frame), so it tracks the rotation itself. Solid, not
// dotted like the references it circles: it is one mark to be read as a whole, and small enough that dots would
// leave little of it.
const SPIN_RING_RADIUS = 0.25 * EARTH_R;
const SPIN_RING_Y = -1.3 * EARTH_R;
const SPIN_ARC_DEG = 280;
const SPIN_SEGMENTS = 28;
const SPIN_HEAD_DEG = 16;
const SPIN_HEAD_HALF_WIDTH = 0.05 * EARTH_R;
const spinPoint = (deg, radius = SPIN_RING_RADIUS) =>
    v(radius * Math.cos(deg * DEG), SPIN_RING_Y, radius * Math.sin(deg * DEG));
const spinArc = new Shape({
    addTo: earthAnchor,
    path: Array.from({ length: SPIN_SEGMENTS + 1 }, (_, i) => spinPoint((i / SPIN_SEGMENTS) * SPIN_ARC_DEG)),
    closed: false,
    stroke: 1,
    fill: false,
    color: INK,
});
// The head sits at the end of the arc, its tip a little further along it, its base spanning the ring's width.
const spinHead = new Shape({
    addTo: earthAnchor,
    path: [
        spinPoint(SPIN_ARC_DEG + SPIN_HEAD_DEG),
        spinPoint(SPIN_ARC_DEG, SPIN_RING_RADIUS + SPIN_HEAD_HALF_WIDTH),
        spinPoint(SPIN_ARC_DEG, SPIN_RING_RADIUS - SPIN_HEAD_HALF_WIDTH),
    ],
    closed: true,
    fill: true,
    stroke: 0.5,
    color: INK,
});
// The observer's own latitude/meridian rings: where they are right now.
const latitudeRing = new Ellipse({
    addTo: earthAnchor,
    diameter: 2 * EARTH_R,
    rotate: { x: Math.PI / 2 },
    color: INK,
    stroke: 1,
    fill: false,
});
const meridianRing = new Ellipse({ addTo: earthAnchor, diameter: 2 * EARTH_R, color: INK, stroke: 1, fill: false });
// The radius from center to the observer: the concrete result, solid.
const radiusLine = new Shape({ addTo: earthAnchor, path: [v(0, 0, 0), v(0, 0, 0)], stroke: 1, color: INK });
// Earth's center, so the radius line has a visible point of origin to read from.
new Shape({ addTo: earthAnchor, stroke: 3, color: INK });
// The two rings cross at two antipodal points; this marks which one is actually the observer.
const observerMarker = new Shape({ addTo: earthAnchor, stroke: 7, color: INK, translate: { z: 0.1 } });
// Ecliptic pole: the celestial pole (the solid vertical axis) rotated by the true obliquity about the X axis (the
// vernal equinox, our +X axis, is the ascending node of one plane on the other). Only the true one: the mean
// obliquity differs by the nutation, a few arcseconds, and would just draw on top of it.
const trueEclipticAxis = new Shape({ addTo: earthAnchor, path: [v(0, 0, 0), v(0, 0, 0)], stroke: 1, color: INK });
// The tilt itself, as a swept arc from the celestial pole to the true ecliptic pole, rather than a straight
// chord between them: a curve reads as "this many degrees of angle" more directly than a line does. Both
// axes extend through the origin in both directions (north and south pole), so the arc is mirrored too:
// trueObliquityArc for the north side, trueObliquityArcSouth for the (identical, negated) south side.
const trueObliquityArc = new Shape({ addTo: earthAnchor, path: [v(0, 0, 0)], closed: false, stroke: 1, color: INK });
const trueObliquityArcSouth = new Shape({
    addTo: earthAnchor,
    path: [v(0, 0, 0)],
    closed: false,
    stroke: 1,
    color: INK,
});
// Longitude nutation: the true equinox (where RA is actually measured from right now) wanders a little
// from the mean/fixed one (our +X axis) within the equatorial plane; marked on the equator ring's surface.
const longitudeNutationLine = new Shape({
    addTo: earthAnchor,
    path: [v(0, 0, 0), v(0, 0, 0)],
    stroke: 1,
    color: INK,
});
const trueEquinoxDot = new Shape({ addTo: earthAnchor, stroke: 3, color: INK });
// Earth's (equivalently, from here, the sun's apparent) orbital ellipse, real eccentricity (~0.0167), so
// this will read as very nearly circular, which is itself the honest answer. Centered on Earth rather than
// offset to the correct focus: that needs the orbit's orientation (longitude of perihelion), which nothing
// in this codebase computes, so this shows the shape/flatness, not the correct sun-at-focus positioning.
const orbitEllipse = new Ellipse({
    addTo: earthAnchor,
    rotate: { x: Math.PI / 2 },
    color: INK,
    stroke: 1,
    fill: false,
});
// The atmosphere shell as a constant, always-on presence, layered on top of everything else: a single
// billboarded circle (see billboardRotate) at the atmosphere's outer radius, rather than three fixed
// wireframe rings, so it always reads as a clean full disc regardless of how the scene is rotated. No
// view-distance-through-atmosphere ray visualization: that distance is too small a fraction of EARTH_R to
// read at this scene's scale.
const atmosphereShell = new Ellipse({
    addTo: earthAnchor,
    diameter: ATMOSPHERE_SHELL_DIAMETER,
    color: PAGE_ACCENT,
    stroke: 1,
    fill: false,
});

const sunAnchor = new Anchor({ addTo: illustration });
// A solid, billboarded outline, deliberately not dotted like atmosphereShell/moonDisc: with the sunrays
// below, the sun is the one body meant to read as a concrete, currently-there thing rather than a fixed
// reference construction, matching radiusLine's "solid = the actual answer" tier. Always presents a full
// circle to the viewer regardless of scene rotation, unlike earthAnchor's two-ring (outline + equator)
// treatment, which is oriented toward Earth, not the camera. Plain INK, same as everything else:
// yellow/grey didn't read well against the dotted stroke at this size.
const sunDisc = new Ellipse({ addTo: sunAnchor, diameter: SUN_R * 2, color: INK, stroke: 1, fill: false });
// Mirrors earthAnchor's centerDot: marks the exact point the body's apparentPosition refers to.
new Shape({ addTo: sunAnchor, stroke: 3, color: INK });

// Sunrays: the one purely decorative touch in this otherwise data-driven scene, so the sun reads as the sun
// at a glance instead of just "the bigger of two identical outline circles" next to the moon (whose apparent
// size is now often close to the sun's, see APPARENT_SIZE_SCALE above). Short strokes radiating from just
// outside the disc's edge, camera-facing like the disc itself; a gap separates them from the outline so they
// don't visually fuse into it. Recomputed every frame in frame() below since sunDisc's own radius changes
// with apparentAngularDiameter. Dotted (see the dash-array loop in frame()), unlike the now-solid disc: the
// disc itself is the "concrete, currently-there" answer, the rays are just flourish around it.
const SUN_RAY_COUNT = 12;
const SUN_RAY_GAP = 8;
const SUN_RAY_LENGTH = 24;
const sunRays = Array.from(
    { length: SUN_RAY_COUNT },
    () => new Shape({ addTo: sunAnchor, path: [v(0, 0, 0), v(0, 0, 0)], stroke: 1, color: INK }),
);

const moonAnchor = new Anchor({ addTo: illustration });
const moonDisc = new Ellipse({
    addTo: moonAnchor,
    diameter: APPARENT_SIZE_SCALE * precise.moon.apparentAngularDiameter(precise.J2000),
    color: MOON_INK,
    stroke: 1,
    fill: false,
});
new Shape({ addTo: moonAnchor, stroke: 3, color: MOON_INK });

// Two small, flat (never rotated), transparent panels overlaid on the main scene, each locked to one body: seen along
// the vertical circle through it, as in the analemma (see alongVerticalCircle), with that body always at the center and
// the horizon, the altitude lines and the other body moving around it instead. Units are degrees.
const ALTAZ_FIELD_OF_VIEW_DEG = 120;
const ALTAZ_GRID_ANGLES = [-150, -120, -90, -60, -30, 30, 60, 90, 120, 150];
// The arrow towards the other body sits on a circle around the center, half the panel across.
const ALTAZ_ARROW_RADIUS = ALTAZ_FIELD_OF_VIEW_DEG / 4;

// A fixed per-species look, regardless of anchor/other role: the sun is a white disc plus rays, the moon carries its
// phase, lit towards wherever the sun stands in the same panel.
function altAzBody(point, isSun, unitsPerPx, towardsSun, lit, earthshine) {
    if (isSun) return sunSymbol(point.x, point.y, unitsPerPx);
    const radius = SUN_SYMBOL.radius * unitsPerPx;
    return moonSymbol(point.x, point.y, radius, lit, towardsSun.x, towardsSun.y, earthshine);
}

function makeAltAzPanel(elementSelector, anchorIsSun) {
    const element = document.querySelector(elementSelector);
    // Appended here (not hardcoded in the markup) so the caption can never drift out of sync with the field of view.
    const caption = element.closest(".altaz-panel")?.querySelector(".altaz-caption");
    // Appended as text, so the accented name already in the caption survives.
    if (caption) caption.append(`, ${ALTAZ_FIELD_OF_VIEW_DEG}° field of view`);
    return { element, anchorIsSun, drawn: "" };
}
const sunView = makeAltAzPanel("#sunView", true);
const moonView = makeAltAzPanel("#moonView", false);

function updateAltAzPanel(panel, anchorHorizontal, otherHorizontal, lit, earthshine, towardsSun) {
    // The panel is drawn at whatever size the page gives it; arrows and labels keep their size in screen pixels.
    const unitsPerPx = ALTAZ_FIELD_OF_VIEW_DEG / (panel.element.clientWidth || ALTAZ_FIELD_OF_VIEW_DEG);
    // Redrawn only when something changed, not every frame of the main scene.
    const key = [
        anchorHorizontal.altitude,
        anchorHorizontal.azimuth,
        otherHorizontal.altitude,
        otherHorizontal.azimuth,
        lit,
        earthshine,
        towardsSun.x,
        unitsPerPx,
    ].join();
    if (key === panel.drawn) return;
    panel.drawn = key;

    const half = ALTAZ_FIELD_OF_VIEW_DEG / 2;
    const anchorPoint = alongVerticalCircle(anchorHorizontal, anchorHorizontal.azimuth);
    const otherPoint = alongVerticalCircle(otherHorizontal, anchorHorizontal.azimuth);
    const [sunPoint, moonPoint] = panel.anchorIsSun ? [anchorPoint, otherPoint] : [otherPoint, anchorPoint];
    const center = anchorPoint;
    const [left, right] = [center.x - half, center.x + half];
    panel.element.setAttribute("viewBox", `${left} ${center.y - half} ${2 * half} ${2 * half}`);

    // The ground below the horizon first, so everything else draws on top of it; it reaches past the nadir's view.
    let svg = `<rect x="${left}" y="0" width="${2 * half}" height="${180 + half}" class="figure-ground"/>`;
    // Past the zenith the altitude falls again, on the far side of the sky, and past the nadir it rises again.
    for (const angle of ALTAZ_GRID_ANGLES) {
        // Only lines whose label fits whole into the panel.
        if (Math.abs(-angle - center.y) > half - 8 * unitsPerPx) continue;
        const altitude = angle > 90 ? 180 - angle : angle < -90 ? -180 - angle : angle;
        svg += gridLine(-angle, left, right, `${altitude}°`, unitsPerPx);
    }
    svg += `<line x1="${left}" y1="0" x2="${right}" y2="0" class="figure-horizon"/>`;
    // The compass directions on the horizon, where the x axis is plain azimuth: they pass by as the body moves.
    COMPASS.forEach((label, i) => {
        const x = ((i * 45 - anchorHorizontal.azimuth + 540) % 360) - 180;
        if (Math.abs(x) < half - 12 * unitsPerPx) svg += svgText(x, labelAboveY(0, unitsPerPx), label, "figure-label");
    });
    // The sun before the moon, whichever is the anchor, so the moon renders in front whenever the two nearly overlap.
    svg += altAzBody(sunPoint, true, unitsPerPx) + altAzBody(moonPoint, false, unitsPerPx, towardsSun, lit, earthshine);
    // The other body outside the panel gets an arrow around the anchor, along the great circle towards it.
    if (Math.abs(otherPoint.x - center.x) > half || Math.abs(otherPoint.y - center.y) > half) {
        const angle =
            precise.positionAngle(
                anchorHorizontal.azimuth,
                anchorHorizontal.altitude,
                otherHorizontal.azimuth,
                otherHorizontal.altitude,
            ) * DEG;
        const direction = { x: Math.sin(angle), y: -Math.cos(angle) };
        const arrow = arrowAround(center, direction, ALTAZ_ARROW_RADIUS, unitsPerPx);
        svg += offPanelArrowSvg(arrow, !panel.anchorIsSun);
    }
    drawSvg(panel.element, svg, unitsPerPx);
}

const stageEl = document.getElementById("stage");

// Manual drag-rotate (rather than Zdog's built-in dragRotate), since billboardRotate() needs the rotation as
// readable state, not hidden inside Zdog's Dragger.
let rotX = -0.45;
let rotY = 0.5;
let dragging = false;
let lastPointer = { x: 0, y: 0 };

stageEl.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    stageEl.setPointerCapture(e.pointerId);
});
window.addEventListener("pointerup", () => {
    dragging = false;
});
stageEl.addEventListener("pointermove", (e) => {
    if (dragging) {
        const dx = e.clientX - lastPointer.x;
        const dy = e.clientY - lastPointer.y;
        lastPointer = { x: e.clientX, y: e.clientY };
        rotY += dx * 0.008;
        rotX += dy * 0.008;
        requestFrame();
    }
});
function frame() {
    // Read once per animation frame from the shared state (see state.js), so the scene follows every set of controls.
    const { jd, latitude, longitude } = state;
    const time = precise.fromJulianDay(jd);

    const sunEqu = precise.sun.apparentPosition(ephemerisDay(jd));
    const moonEqu = precise.moon.apparentPosition(ephemerisDay(jd));
    const siderealTime = precise.siderealTime(time);
    const obliquity = precise.earth.trueObliquity(ephemerisDay(jd));

    const sunPos = sphericalToVector(sunEqu.rightAscension, sunEqu.declination, SUN_DIST);
    const moonPos = sphericalToVector(moonEqu.rightAscension, moonEqu.declination, MOON_DIST);
    const observerRa = siderealTime + longitude;
    const observerPos = sphericalToVector(observerRa, latitude, EARTH_R);

    const sunHorizontal = precise.sun.horizontalPosition(time, state);
    const moonHorizontal = precise.moon.horizontalPosition(time, state);
    // The locked views show sunrise and sunset to the second, so their altitudes are over the visible horizon: lifted by
    // refraction, the horizon lowered by the observer's height (see horizon.js). The horizon line stays where it is.
    const overHorizon = (h) => ({ ...h, altitude: aboveVisibleHorizon(h.altitude, state.heightM) });
    const sunSeen = overHorizon(sunHorizontal);
    const moonSeen = overHorizon(moonHorizontal);
    const lit = precise.moon.illuminatedFraction(ephemerisDay(jd));
    const earthshine = precise.moon.earthshine(ephemerisDay(jd));
    // The tilt of the crescent is the observer's, not the panel's: taken from the sky itself, so it matches the
    // Moon's own figure rather than following this panel's stretched projection.
    const sunFrame = sunInViewFrame(time, state);
    const towardsSun = { x: sunFrame.right, y: -sunFrame.up };
    updateAltAzPanel(sunView, sunSeen, moonSeen, lit, earthshine, towardsSun);
    updateAltAzPanel(moonView, moonSeen, sunSeen, lit, earthshine, towardsSun);

    sunAnchor.translate = sunPos;
    sunDisc.rotate = billboardRotate(rotX, rotY);
    sunDisc.diameter = APPARENT_SIZE_SCALE * precise.sun.apparentAngularDiameter(ephemerisDay(jd));
    sunDisc.updatePath();
    const sunRayInner = sunDisc.diameter / 2 + SUN_RAY_GAP;
    const sunRayOuter = sunRayInner + SUN_RAY_LENGTH;
    sunRays.forEach((ray, i) => {
        const rayAngle = (i / SUN_RAY_COUNT) * 2 * Math.PI;
        const cosA = Math.cos(rayAngle);
        const sinA = Math.sin(rayAngle);
        ray.rotate = billboardRotate(rotX, rotY);
        ray.path = [v(sunRayInner * cosA, sunRayInner * sinA, 0), v(sunRayOuter * cosA, sunRayOuter * sinA, 0)];
        ray.updatePath();
    });
    moonAnchor.translate = moonPos;
    moonDisc.rotate = billboardRotate(rotX, rotY);
    moonDisc.diameter = APPARENT_SIZE_SCALE * precise.moon.apparentAngularDiameter(ephemerisDay(jd));
    moonDisc.updatePath();
    atmosphereShell.rotate = billboardRotate(rotX, rotY);
    // observerPos already has magnitude EARTH_R (sphericalToVector's radius arg), so this only needs a
    // plain 1.02x nudge above the surface, not a divide-by-EARTH_R (that previously collapsed the whole
    // vector down to magnitude ~1, putting the dot at the center instead of on the sphere).
    observerMarker.translate = vScale(observerPos, 1.02);
    latitudeRing.diameter = 2 * EARTH_R * Math.cos(latitude * DEG);
    latitudeRing.translate = { y: -EARTH_R * Math.sin(latitude * DEG) };
    latitudeRing.updatePath();
    meridianRing.rotate = { y: observerRa * DEG };
    // The turn arrow starts on the observer's own meridian, so it sweeps around with sidereal time: step the clock
    // and it turns the way Earth does, one full round a day.
    spinArc.rotate = { y: observerRa * DEG };
    spinHead.rotate = { y: observerRa * DEG };
    radiusLine.path[1] = observerPos;
    radiusLine.updatePath();

    // Same rotate-the-Y-axis-by-obliquity-about-X derivation the ecliptic-plane ring used, applied to just
    // the pole direction instead of a whole ring.
    const eclipticPoleAt = (obliquityDeg) =>
        v(0, -Math.cos(obliquityDeg * DEG) * EARTH_R, Math.sin(obliquityDeg * DEG) * EARTH_R);
    const truePole = eclipticPoleAt(obliquity);
    trueEclipticAxis.path[0] = vScale(truePole, -AXIS_OVERHANG);
    trueEclipticAxis.path[1] = vScale(truePole, AXIS_OVERHANG);
    trueEclipticAxis.updatePath();

    const OBLIQUITY_ARC_SEGMENTS = 16;
    const northArcPath = Array.from({ length: OBLIQUITY_ARC_SEGMENTS + 1 }, (_, i) =>
        eclipticPoleAt((obliquity * i) / OBLIQUITY_ARC_SEGMENTS),
    );
    trueObliquityArc.path = northArcPath;
    trueObliquityArc.updatePath();
    trueObliquityArcSouth.path = northArcPath.map((p) => vScale(p, -1));
    trueObliquityArcSouth.updatePath();

    // The true equinox, shifted from the mean one (our +X axis) by longitudeNutation within the equatorial
    // plane; marked on the equator's surface (dec 0) rather than at the pole, since that's what "longitude"
    // (as opposed to obliquity, an angle *between* poles) refers to here.
    const longitudeNutation = precise.earth.longitudeNutation(ephemerisDay(jd));
    const trueEquinoxPoint = sphericalToVector(longitudeNutation, 0, EARTH_R);
    longitudeNutationLine.path[0] = sphericalToVector(0, 0, EARTH_R);
    longitudeNutationLine.path[1] = trueEquinoxPoint;
    longitudeNutationLine.updatePath();
    trueEquinoxDot.translate = vScale(trueEquinoxPoint, 1.02);

    const orbitEccentricity = precise.earth.orbitEccentricity(ephemerisDay(jd));
    orbitEllipse.width = 2 * SUN_DIST;
    orbitEllipse.height = 2 * SUN_DIST * Math.sqrt(1 - orbitEccentricity * orbitEccentricity);
    orbitEllipse.rotate = { x: Math.PI / 2 + obliquity * DEG };
    orbitEllipse.updatePath();

    illustration.rotate = { x: rotX, y: rotY, z: 0 };
    illustration.updateRenderGraph();
    annotate("observer", vScale(observerPos, 1.02));
    annotate("equinox", trueEquinoxDot.translate);
    annotate("north", v(0, -AXIS_OVERHANG * EARTH_R, 0));
    annotate("south", v(0, AXIS_OVERHANG * EARTH_R, 0));
    // At the axis' end, so the arrow runs along the axis and stops short of it like the others do at their dots.
    annotate("eclipticAxis", vScale(truePole, AXIS_OVERHANG));
    annotateEcliptic(sunPos);
    // The line styles are classes (see global.css), set once each shape has an SVG element, i.e. after its first
    // render. Dotted for the fixed references, long dashes for the Sun's orbit, which deserves a style of its own among
    // them, and short dashes for the observer's two circles. radiusLine and longitudeNutationLine are answers, so solid.
    const dashes = [
        [
            "line-dotted",
            [
                equatorRing,
                axisLine,
                trueEclipticAxis,
                trueObliquityArc,
                trueObliquityArcSouth,
                atmosphereShell,
                moonDisc,
                ...sunRays,
            ],
        ],
        ["line-long-dashed", [orbitEllipse]],
        ["line-dashed", [latitudeRing, meridianRing]],
    ];
    for (const [dash, shapes] of dashes) for (const shape of shapes) shape.svgElement?.classList.add(dash);
}

const requestFrame = onDemand(frame);
onChange(requestFrame);
new ResizeObserver(requestFrame).observe(stageEl);
requestFrame();

// The labels on Earth's surface ride one circle around it, a fixed gap outside the globe on screen, each in its marker's
// direction, so rotating the scene swings them around the circle instead of flinging them across the stage. Markers
// are projected the way Zdog does: rotated with the scene, scaled by the zoom, around the center.
const ANNOTATION_GAP_PX = 70;
// N and S sit just past the ends of Earth's axis.
const POLE_LABEL_GAP_PX = 6;
// Room between a label's box and the start of its arrow.
const ANNOTATION_LABEL_PAD_PX = 3;
const ANNOTATION_TIP_GAP_PX = 7;
const annotationParts = (name) =>
    ["scene-annotation", "annotation-arrow", "annotation-arrowhead"].map((c) =>
        document.querySelector(`.${c}[data-annotation="${name}"]`),
    );
const annotations = Object.fromEntries(
    ["observer", "equinox", "north", "south", "eclipticAxis"].map((n) => [n, annotationParts(n)]),
);

// "observer", "vernal equinox" and "ecliptic axis" ride the circle with a straight arrow to their marker; N and S sit
// right past the ends of Earth's axis and need none.
function annotate(name, point) {
    const [label, arrow, head] = annotations[name];
    const p = new Vector(point).rotate(illustration.rotate);
    const zoom = illustration.zoom;
    const [cx, cy] = [stageWidth / 2, stageHeight / 2];
    const [px, py] = [cx + p.x * zoom, cy + p.y * zoom];
    const length = Math.hypot(p.x, p.y) || 1;
    const [ux, uy] = length > 1e-3 ? [p.x / length, p.y / length] : [0, -1];
    // Without an arrow, a label sits past its point by a gap plus its own half extent in that direction.
    const extent = (Math.abs(ux) * label.offsetWidth + Math.abs(uy) * label.offsetHeight) / 2;
    // Arrowed labels keep to the circle, or stand further out when their marker lies beyond it.
    const circle = Math.max(EARTH_R * zoom + ANNOTATION_GAP_PX, length * zoom + ANNOTATION_GAP_PX / 2);
    const reach = arrow ? circle : length * zoom + POLE_LABEL_GAP_PX + extent;
    const [lx, ly] = [cx + ux * reach, cy + uy * reach];
    label.style.left = `${lx}px`;
    label.style.top = `${ly}px`;
    if (!arrow) return;
    // A straight line from the label's box to just short of the marker. It leaves the box where the line from the
    // label's center to the marker crosses it, and slides towards the middle of the left or right edge the more the
    // marker lies to that side, so the start never jumps as the scene turns.
    const [w, h] = [label.offsetWidth / 2 + ANNOTATION_LABEL_PAD_PX, label.offsetHeight / 2 + ANNOTATION_LABEL_PAD_PX];
    const [ex, ey] = [(px - lx) / w, (py - ly) / h];
    const hit = 1 / Math.max(Math.abs(ex), Math.abs(ey), 1e-6);
    const sideness = Math.abs(ex) / (Math.abs(ex) + Math.abs(ey) || 1);
    const toMiddle = sideness <= 0.5 ? 0 : ((t) => t * t * (3 - 2 * t))(Math.min((sideness - 0.5) / 0.3, 1));
    const [sx, sy] = [lx + ex * hit * w, ly + ey * hit * h * (1 - toMiddle)];
    const toTip = Math.hypot(px - sx, py - sy) || 1;
    const [dx, dy] = [(px - sx) / toTip, (py - sy) / toTip];
    const [tx, ty] = [px - dx * ANNOTATION_TIP_GAP_PX, py - dy * ANNOTATION_TIP_GAP_PX];
    arrow.setAttribute("d", `M ${sx} ${sy} L ${tx} ${ty}`);
    const [hx, hy] = [tx - dx * 7, ty - dy * 7];
    head.setAttribute("points", `${tx},${ty} ${hx - dy * 3.5},${hy + dx * 3.5} ${hx + dy * 3.5},${hy - dx * 3.5}`);
}

// "ecliptic": a label on the orbit ellipse's upper branch on screen, right of Earth, at its rightmost point inside the
// stage, left of the alt-az panels and clear of the Sun, so it keeps to one place as the scene turns; hidden if there is
// none. Lifted off the line, off the dashes.
const ECLIPTIC_MARGIN_PX = 40;
const eclipticLabel = document.querySelector('.scene-annotation[data-annotation="ecliptic"]');

function annotateEcliptic(sunPos) {
    const zoom = illustration.zoom;
    const [cx, cy] = [stageWidth / 2, stageHeight / 2];
    const project = (point) => {
        const p = new Vector(point).rotate(illustration.rotate);
        return [cx + p.x * zoom, cy + p.y * zoom];
    };
    const [sx, sy] = project(sunPos);
    const clearOfSun = (SUN_R + SUN_RAY_GAP + SUN_RAY_LENGTH) * zoom + ECLIPTIC_MARGIN_PX;
    // The panels cover the stage's right side on wide screens; on narrow ones they sit below it.
    const stageBox = eclipticLabel.parentElement.querySelector("#stage").getBoundingClientRect();
    const panelBox = eclipticLabel.parentElement.querySelector(".altaz-panel")?.getBoundingClientRect();
    const right = panelBox && panelBox.top < stageBox.bottom ? panelBox.left - stageBox.left : stageWidth;
    const at = (i) => {
        const t = i * DEG;
        const local = new Vector({
            x: (orbitEllipse.width / 2) * Math.cos(t),
            y: (orbitEllipse.height / 2) * Math.sin(t),
        });
        return project(local.rotate(orbitEllipse.rotate));
    };
    const points = Array.from({ length: 360 }, (_, i) => at(i));
    let best = null;
    points.forEach(([x, y], i) => {
        const inside = x > ECLIPTIC_MARGIN_PX && x < right - ECLIPTIC_MARGIN_PX && y > ECLIPTIC_MARGIN_PX;
        if (!inside || y > stageHeight - ECLIPTIC_MARGIN_PX || Math.hypot(x - sx, y - sy) < clearOfSun) return;
        // The upper branch of the ellipse on screen: where its outward normal points up.
        const [[ax, ay], [bx, by]] = [points[(i + 359) % 360], points[(i + 1) % 360]];
        const [nx, ny] = [by - ay, ax - bx];
        const outward = nx * (x - cx) + ny * (y - cy) > 0 ? 1 : -1;
        if (x > cx && ny * outward < 0 && (!best || x > best.x)) best = { x, y };
    });
    eclipticLabel.hidden = !best;
    if (!best) return;
    eclipticLabel.style.left = `${best.x}px`;
    eclipticLabel.style.top = `${best.y - 12}px`;
}

const labelsButton = document.querySelector('#scene [data-field="labels"]');
labelsButton.addEventListener("click", () => {
    const on = labelsButton.getAttribute("aria-pressed") !== "true";
    labelsButton.setAttribute("aria-pressed", String(on));
    document.querySelector("#scene").classList.toggle("labels-off", !on);
    requestFrame();
});
