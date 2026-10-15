import * as precise from "@himmelszelt/sternzeit";
import Zdog from "zdog";
import { find } from "../dom";
import { onDemand } from "../frame";
import { SUN_SYMBOL, sunRays, themeColor, themeColors } from "./figure";
import { ephemerisDay, onChange, state } from "./state";
import { type Point, type Rotation, turn, viewToScene, zdogBody, zdogMoon, zdogSun } from "./zdogmoon";
import "./export";

const { Illustration, Anchor, Shape } = Zdog;
const DEG = precise.DEG_TO_RAD;
const AU = precise.ASTRONOMICAL_UNIT_KM;

// The zoom runs between two reaches, in kilometers from the frame's center to its nearer edge: the Moon's orbit with
// room around it, and Earth's orbit, all of it. Logarithmic in between, so every step zooms by the same factor.
const REACH_IN_KM = 550_000;
const REACH_OUT_KM = 1.3 * AU;
// The center glides from Earth to the Sun over the last stretch of the zoom, once the Sun comes into view, and Earth
// stays this far inside the frame throughout.
const GLIDE = { from: 0.8, to: 1 };
const KEEP_INSIDE = 0.8;
// The bodies grow as the zoom brings them in, from dots to discs, never smaller than their true size on screen. The
// Moon shows once its orbit has room for it beside Earth.
const EARTH_PX = { out: 3.5, in: 16 };
const MOON_PX = 7;
const BODY_GAP_PX = 3;
// Where on the zoom the bodies grow and shrink, as fractions of it.
const GROW = { from: 0.3, to: 0.8 };
// The paths: both bodies a lunation either way of the moment, every hour, and Earth's whole year, every six hours, so
// that zoomed in the orbit's chords still fall under a pixel. Every path keeps a gap of a diameter around each body.
const LUNATION_DAYS = precise.moon.MEAN_SYNODIC_MONTH;
const PATH_STEP_DAYS = 1 / 24;
const YEAR_DAYS = 365.25;
const YEAR_STEP_DAYS = 0.25;
const GAP_DIAMETERS = 1;
// The Sun's mean anomaly and its longitude advance this much a day: perihelion is where the anomaly passes 0, aphelion
// 180, the equinoxes where the longitude passes 0 and 180, the solstices 90 and 270.
const SOLAR_RATE = 0.9856;
const SEASONS: [longitude: number, name: string][] = [
    [0, "March equinox"],
    [90, "June solstice"],
    [180, "September equinox"],
    [270, "December solstice"],
];
// The Moon's loop gets its nodes and apsides once it is this large on screen.
const LOOP_CLEAR_PX = 60;
// The Moon's path fades out as its orbit shrinks to a few pixels around Earth's.
const MOON_PATH_FADE_PX = { from: 4, to: 16 };
// The reference points show once they stand clear of what they refer to: the Lagrange points L1 and L2 this far from
// Earth, L3 to L5 and the perihelion and aphelion this far from the Sun, on screen.
const CLEAR_PX = 28;
const ORBIT_CLEAR_PX = 80;
// The Sun-Earth Lagrange points, from the mass ratio of Earth and Moon together to the Sun, 1 to 328,900: L1 and L2
// at (μ/3)^(1/3) of Earth's distance either side of it, about 1.5 million km, L3 opposite the Sun, a hair outside the
// orbit, L4 and L5 on it, 60° ahead and behind (Murray and Dermott, Solar System Dynamics, eq. 3.90 to 3.98).
const MASS_RATIO = 1 / 328_900;
const HILL = (MASS_RATIO / 3) ** (1 / 3);
const L3_BEYOND = (5 / 12) * MASS_RATIO;
// Earth's marks: its axis through the poles and the equator.
const AXIS_REACH = 1.7;
// The observer's up, the zenith, this far out of the ground, in Earth radii.
const UP_REACH = 0.45;
const SPHERE_STEP = 6;
// Seen from above the ecliptic, tilted a little; the view may dip a little below the plane, not under it.
const TILT_MIN = -88 * DEG;
const TILT_MAX = 12 * DEG;
const DRAG_RADIANS_PER_PX = 0.008;

const INK = themeColor("--text");
const MUTED = themeColor("--muted");
const ACCENT = themeColor("--accent");
const earthColors = {
    edge: themeColor("--earth-edge"),
    night: themeColor("--earth-night"),
    lit: themeColor("--earth-lit"),
};
const faint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

const frameEl = find(".orbit-scene");
const labelsEl = find(".orbit-labels", frameEl);
const zoomInput = find<HTMLInputElement>('[data-field="zoom"]', frameEl.parentElement ?? document);
const zoomValue = find('[data-field="zoomValue"]', frameEl.parentElement ?? document);

// Strokes are in screen pixels (see .zdog in global.css); the dash patterns are classes there too, set on each shape's
// SVG element once it has one.
const dashes = new Map<Zdog.Anchor, string>();
const DOTTED = "line-dotted";
const DASHED = "line-dashed";
let stageWidth = 0;
let stageHeight = 0;
const rotation: Rotation = { x: -58 * DEG, y: 0, z: 0 };

const illustration = new Illustration({
    element: find<SVGSVGElement>(":scope > svg", frameEl),
    resize: true,
    rotate: rotation,
    onResize: function (this: Zdog.Illustration, width: number, height: number) {
        stageWidth = width;
        stageHeight = height;
        this.setSize(width, height);
    },
});
// Everything is rebuilt whenever the moment, the place or the zoom changes; Earth's marks on every turn as well.
const scene = new Anchor({ addTo: illustration });
const marks = new Anchor({ addTo: illustration });

function styled<T extends Zdog.Shape>(shape: T, strokePx: number, dash: string | null = null) {
    if (dash) dashes.set(shape, dash);
    shape.stroke = strokePx;
    return shape;
}

function clear(anchor: Zdog.Anchor) {
    for (const child of [...anchor.children]) {
        dashes.delete(child);
        child.remove();
    }
}

type Km = readonly [x: number, y: number, z: number];

// Heliocentric ecliptic coordinates, in kilometers: x towards the vernal equinox, y 90° on along the ecliptic, z to
// its north; the Sun at the origin. Earth stands opposite the Sun's geometric longitude, the Moon at its geocentric
// ecliptic position from there, both referred to the mean equinox of the date.
function earthAt(jd: number): Km {
    const t = ephemerisDay(jd);
    const lon = (precise.sun.trueLongitude(t) + 180) * DEG;
    const r = precise.sun.distance(t);
    return [r * Math.cos(lon), r * Math.sin(lon), 0];
}
function moonFromEarth(jd: number): Km {
    const t = ephemerisDay(jd);
    const { longitude, latitude } = precise.moon.position(t);
    const d = precise.moon.distance(t);
    const [lon, lat] = [longitude * DEG, latitude * DEG];
    return [d * Math.cos(lat) * Math.cos(lon), d * Math.cos(lat) * Math.sin(lon), d * Math.sin(lat)];
}
const add = ([x, y, z]: Km, [u, v, w]: Km): Km => [x + u, y + v, z + w];
const scale = ([x, y, z]: Km, s: number): Km => [x * s, y * s, z * s];
const turned = ([x, y, z]: Km, deg: number): Km => {
    const [c, s] = [Math.cos(deg * DEG), Math.sin(deg * DEG)];
    return [x * c - y * s, x * s + y * c, z];
};

/** The frame's reach for the slider's readout, short: millions of kilometers up to ten, AU beyond. */
function reachText(reachKm: number) {
    if (reachKm < 10e6) return `${(reachKm / 1e6).toFixed(1)}\u202FM\u202Fkm`;
    return `${(reachKm / AU).toFixed(1)}\u202FAU`;
}

/** When, near `guess`, a solar angle (the mean anomaly or the apparent longitude) passes `target` degrees. */
function solarTime(angle: (t: number) => number, guess: number, target: number) {
    let jd = guess;
    for (let i = 0; i < 5; i++) {
        const off = ((((angle(ephemerisDay(jd)) - target + 180) % 360) + 360) % 360) - 180;
        jd -= off / SOLAR_RATE;
    }
    return jd;
}

/** The zoom, 0 at the Moon's orbit to 1 at Earth's, as the slider holds it. */
const zoomLevel = () => Number(zoomInput.value) / 100;
const smoothstep = (from: number, to: number, x: number) => {
    const u = Math.min(1, Math.max(0, (x - from) / (to - from)));
    return u * u * (3 - 2 * u);
};

// The frame: its center and scale, from the zoom and the moment.
interface Frame {
    center: Km;
    reach: number;
    half: number;
    pxPerKm: number;
    grow: number;
}
function frameAt(jd: number): Frame {
    const s = zoomLevel();
    const half = Math.min(stageWidth, stageHeight) / 2 || 200;
    const reach = REACH_IN_KM ** (1 - s) * REACH_OUT_KM ** s;
    const earth = earthAt(jd);
    const r = Math.hypot(earth[0], earth[1]);
    const g = Math.min(smoothstep(GLIDE.from, GLIDE.to, s), (KEEP_INSIDE * reach) / r);
    return {
        center: [earth[0] * (1 - g), earth[1] * (1 - g), 0],
        reach,
        half,
        pxPerKm: half / reach,
        grow: 1 - smoothstep(GROW.from, GROW.to, s),
    };
}

// Ecliptic kilometers into the scene: x right, y down, z towards the viewer, with the ecliptic's north up.
function scenePoint([x, y, z]: Km, { center, pxPerKm }: Frame): Point {
    return { x: (x - center[0]) * pxPerKm, y: -(z - center[2]) * pxPerKm, z: -(y - center[1]) * pxPerKm };
}

// What the paths keep clear of: each body's center and the radius of the gap around it, in scene pixels.
let gaps: { at: Point; radius: number }[] = [];

/** Where the segment from `a` to `b` enters and leaves the gap `gap`, as fractions of the way, or null if it misses. */
function crossing(a: Point, b: Point, gap: { at: Point; radius: number }): [enter: number, leave: number] | null {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const f = { x: a.x - gap.at.x, y: a.y - gap.at.y, z: a.z - gap.at.z };
    const dd = d.x * d.x + d.y * d.y + d.z * d.z;
    const fd = f.x * d.x + f.y * d.y + f.z * d.z;
    const ff = f.x * f.x + f.y * f.y + f.z * f.z - gap.radius * gap.radius;
    const under = fd * fd - dd * ff;
    if (dd === 0 || under < 0) return null;
    return [(-fd - Math.sqrt(under)) / dd, (-fd + Math.sqrt(under)) / dd];
}

/** A path in runs that keep out of the gaps around the bodies, so no line shows through a disc, each run ending and
 *  starting where it meets a gap's edge, so a straight line to a body still reaches up to it, and one through a body
 *  skips it. */
function addPath(points: Point[], color: string, strokePx: number, dash: string | null, closed = false) {
    const lerp = (a: Point, b: Point, t: number): Point => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
    });
    const all = closed ? [...points, points[0] as Point] : points;
    const flush = (run: Point[]) => {
        if (run.length > 1)
            styled(new Shape({ addTo: scene, path: run, closed: false, color, fill: false }), strokePx, dash);
    };
    let run: Point[] = [all[0] as Point];
    for (let i = 1; i < all.length; i++) {
        const [a, b] = [all[i - 1] as Point, all[i] as Point];
        // Where the segment is inside any gap, as the first entry and the last exit along it.
        let enter = 1;
        let leave = 0;
        for (const gap of gaps) {
            const hit = crossing(a, b, gap);
            if (!hit || hit[1] <= 0 || hit[0] >= 1) continue;
            enter = Math.min(enter, Math.max(hit[0], 0));
            leave = Math.max(leave, Math.min(hit[1], 1));
        }
        if (enter >= leave) {
            run.push(b);
            continue;
        }
        if (enter > 0) run.push(lerp(a, b, enter));
        flush(run);
        run = leave < 1 ? [lerp(a, b, leave), b] : [];
    }
    flush(run);
}

// The bodies, rebuilt with the scene, lit and turned on every frame.
let earth: ReturnType<typeof zdogBody> | null = null;
let moon: ReturnType<typeof zdogMoon> | null = null;
let earthRadiusPx = 0;
let bodyPoints = { sun: { x: 0, y: 0, z: 0 }, earth: { x: 0, y: 0, z: 0 }, moon: { x: 0, y: 0, z: 0 } };
const billboards: { yaw: Zdog.Anchor; face: Zdog.Anchor }[] = [];
// The reference points' labels float over the scene in HTML, placed wherever their points project on each frame,
// each pushed away from what its point refers to: the Lagrange points L1 and L2 from Earth, the rest from the Sun.
const labels: { text: string; point: Point; away: Point }[] = [];
const LABEL_GAP_PX = 10;
const LABEL_LINE_PX = 13;

/** A small cross at a point, labeled beside it, on the side away from `away`. */
function addMark(point: Point, text: string, away: Point) {
    const cross = 3;
    for (const [a, b] of [
        [
            { x: -cross, y: 0 },
            { x: cross, y: 0 },
        ],
        [
            { x: 0, y: -cross },
            { x: 0, y: cross },
        ],
    ]) {
        const yaw = new Anchor({ addTo: scene, translate: point });
        const face = new Anchor({ addTo: yaw });
        billboards.push({ yaw, face });
        styled(
            new Shape({
                addTo: face,
                path: [
                    { ...a, z: 0 },
                    { ...b, z: 0 },
                ],
                color: MUTED,
            }),
            1,
        );
    }
    labels.push({ text, point, away });
}

function rebuild() {
    const { jd } = state;
    const frame = frameAt(jd);
    const { pxPerKm, grow, reach, half } = frame;
    clear(scene);
    billboards.length = 0;
    labels.length = 0;
    zoomValue.textContent = reachText(reach);

    const sunPoint = scenePoint([0, 0, 0], frame);
    const earthNow = earthAt(jd);
    const earthPoint = scenePoint(earthNow, frame);
    const moonPoint = scenePoint(add(earthNow, moonFromEarth(jd)), frame);
    earthRadiusPx = Math.max(
        precise.earth.MEAN_RADIUS_KM * pxPerKm,
        EARTH_PX.out + (EARTH_PX.in - EARTH_PX.out) * grow,
    );
    const moonOrbitPx = 384_400 * pxPerKm;
    const moonRadius = Math.max(precise.moon.MEAN_RADIUS_KM * pxPerKm, MOON_PX * grow);
    const moonShown = moonOrbitPx > earthRadiusPx + moonRadius + BODY_GAP_PX;
    const sunRadius = Math.max(SUN_SYMBOL.radius, precise.sun.MEAN_RADIUS_KM * pxPerKm);
    gaps = [
        { at: earthPoint, radius: 2 * GAP_DIAMETERS * earthRadiusPx },
        { at: sunPoint, radius: 2 * GAP_DIAMETERS * sunRadius },
    ];
    if (moonShown) gaps.push({ at: moonPoint, radius: 2 * GAP_DIAMETERS * moonRadius });

    // Earth's orbit over the rest of the year, faint, from the end of the coming lunation, drawn in full below, round to
    // the moment.
    const year = Math.round((YEAR_DAYS - LUNATION_DAYS) / YEAR_STEP_DAYS);
    const orbit = Array.from({ length: year + 1 }, (_, i) =>
        scenePoint(earthAt(jd + LUNATION_DAYS + i * YEAR_STEP_DAYS), frame),
    );
    addPath(orbit, faint(INK, 25), 1, null);
    const orbitPx = AU * pxPerKm;
    // The direction of the vernal equinox from the Sun, the ecliptic longitude 0 the positions are counted from, and
    // the nearest and farthest Earth comes to the Sun over the year.
    if (orbitPx > ORBIT_CLEAR_PX) {
        addPath([scenePoint([0, 0, 0], frame), scenePoint([1.12 * AU, 0, 0], frame)], faint(INK, 35), 1, DOTTED);
        labels.push({ text: "vernal equinox", point: scenePoint([1.12 * AU, 0, 0], frame), away: sunPoint });
        addMark(scenePoint(earthAt(solarTime(precise.sun.meanAnomaly, jd, 0)), frame), "perihelion", sunPoint);
        addMark(scenePoint(earthAt(solarTime(precise.sun.meanAnomaly, jd, 180)), frame), "aphelion", sunPoint);
        for (const [longitude, name] of SEASONS) {
            const at = solarTime(precise.sun.apparentLongitude, jd, longitude);
            addMark(scenePoint(earthAt(at), frame), name, sunPoint);
        }
    }

    // Both paths over the coming lunation, dotted; the lunation behind is sampled too, for the Moon's nodes and
    // apsides nearest to the moment, but not drawn, as the Moon's loop would cover the coming one. Earth's is its path
    // around the Sun, the Moon's its path around Earth, drawn around Earth where it stands now: along the Sun, Earth
    // moves seven times the Moon's distance a day, which would stretch the Moon's orbit into a wave too shallow to see.
    const steps = Math.round(LUNATION_DAYS / PATH_STEP_DAYS);
    const at = (i: number) => jd + (i - steps) * PATH_STEP_DAYS;
    const earthPath = Array.from({ length: steps + 1 }, (_, i) => scenePoint(earthAt(at(steps + i)), frame));
    addPath(earthPath, INK, 1, DOTTED);
    const moonPathAlpha = smoothstep(MOON_PATH_FADE_PX.from, MOON_PATH_FADE_PX.to, moonOrbitPx);
    if (moonPathAlpha > 0) {
        const fromEarth = Array.from({ length: 2 * steps + 1 }, (_, i) => moonFromEarth(at(i)));
        const moonPath = fromEarth.map((v) => scenePoint(add(earthNow, v), frame));
        const color = faint(MUTED, Math.round(moonPathAlpha * 100));
        addPath(moonPath.slice(steps), color, 1, DOTTED);
        // On the loop, the nearest of each to the moment: the nodes, where the Moon crosses the ecliptic, the ascending
        // one northwards, and the apsides, where it is nearest to and farthest from Earth.
        if (moonOrbitPx > LOOP_CLEAR_PX) {
            const events: { text: string; i: number; point: Point }[] = [];
            const distance = fromEarth.map((v) => Math.hypot(...v));
            for (let i = 1; i < fromEarth.length - 1; i++) {
                const [here, next] = [fromEarth[i] as Km, fromEarth[i + 1] as Km];
                if (here[2] <= 0 !== next[2] <= 0) {
                    const f = here[2] / (here[2] - next[2]);
                    const crossing = add(here, scale(add(next, scale(here, -1)), f));
                    const text = next[2] > 0 ? "☊ ascending node" : "☋ descending node";
                    events.push({ text, i: i + f, point: scenePoint(add(earthNow, crossing), frame) });
                }
                const [a, b, c] = [distance[i - 1] as number, distance[i] as number, distance[i + 1] as number];
                if ((b < a && b <= c) || (b > a && b >= c)) {
                    events.push({ text: b < a ? "perigee" : "apogee", i, point: moonPath[i] as Point });
                }
            }
            const nearest = new Map<string, { i: number; point: Point }>();
            for (const { text, i, point } of events) {
                const held = nearest.get(text);
                if (!held || Math.abs(i - steps) < Math.abs(held.i - steps)) nearest.set(text, { i, point });
            }
            for (const [text, { point }] of nearest) addMark(point, text, earthPoint);
        }
        // The Moon's own path along the Sun, fainter: that shallow wave, which never crosses Earth's within the frame.
        // The lunation behind as well, as Earth has its orbit behind it, dotted ahead like every coming path.
        const trace = Array.from({ length: 2 * steps + 1 }, (_, i) =>
            scenePoint(add(earthAt(at(i)), moonFromEarth(at(i))), frame),
        );
        const traceColor = faint(MUTED, Math.round(moonPathAlpha * 40));
        addPath(trace.slice(0, steps + 1), traceColor, 1, null);
        addPath(trace.slice(steps), traceColor, 1, DOTTED);
    }

    // The Lagrange points, each once it stands clear on screen: L1 and L2 of Earth, the others of the Sun.
    const hillPx = Math.hypot(earthNow[0], earthNow[1]) * HILL * pxPerKm;
    if (hillPx > CLEAR_PX) {
        addMark(scenePoint(scale(earthNow, 1 - HILL), frame), "L1", earthPoint);
        addMark(scenePoint(scale(earthNow, 1 + HILL), frame), "L2", earthPoint);
    }
    // Only while the orbit is in the frame: zoomed in, the lines would cross it with their points far outside.
    if (orbitPx > ORBIT_CLEAR_PX && orbitPx < 1.6 * half) {
        const [l3, l4, l5] = [
            scenePoint(scale(earthNow, -(1 + L3_BEYOND)), frame),
            scenePoint(turned(earthNow, 60), frame),
            scenePoint(turned(earthNow, -60), frame),
        ];
        addMark(l3, "L3", sunPoint);
        addMark(l4, "L4", sunPoint);
        addMark(l5, "L5", sunPoint);
        // The frame the points keep still in, turning with Earth: the Sun-Earth line through L1 to L3, and the two
        // equilateral triangles L4 and L5 make with the Sun and Earth.
        const frameLine = faint(INK, 30);
        addPath([l3, scenePoint(scale(earthNow, 1 + HILL), frame)], frameLine, 1, DASHED);
        addPath([sunPoint, l4, earthPoint], frameLine, 1, DASHED);
        addPath([sunPoint, l5, earthPoint], frameLine, 1, DASHED);
    }

    // The Sun, with its rays square to the viewer, and Earth and the Moon where they stand at the moment.
    zdogSun(scene, sunPoint, sunRadius);
    const yaw = new Anchor({ addTo: scene, translate: sunPoint });
    const face = new Anchor({ addTo: yaw });
    billboards.push({ yaw, face });
    const rays = sunRays();
    const stretch = sunRadius / SUN_SYMBOL.radius;
    for (const ray of rays) {
        const path = ray.map((p) => ({ x: p.x * stretch, y: p.y * stretch, z: 0 }));
        styled(new Shape({ addTo: face, path, color: INK }), 1, "figure-sun-ray");
    }

    earth = zdogBody(scene, earthPoint, earthRadiusPx, earthColors);
    moon = moonShown ? zdogMoon(scene, moonPoint, moonRadius) : null;
    bodyPoints = { sun: sunPoint, earth: earthPoint, moon: moonPoint };
}

/** A point on Earth at `ra` and `dec` (degrees) as the camera sees it, on the unit sphere: Earth's axis tilted by the
 *  obliquity, its north pole leaning towards the ecliptic's 90°, where the Sun stands in June. */
function earthUnit(ra: number, dec: number, obliquity: number): Point {
    const [a, d, e] = [ra * DEG, dec * DEG, obliquity * DEG];
    const [x, y, z] = [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
    // Equatorial to ecliptic, then into the scene as scenePoint lays the ecliptic out.
    const [Y, Z] = [y * Math.cos(e) + z * Math.sin(e), -y * Math.sin(e) + z * Math.cos(e)];
    return turn({ x, y: -Z, z: -Y }, rotation);
}

// Earth's marks, as the camera sees them: the near side's equator, the axis, and the chosen place as a dot while it
// faces the camera. Redrawn on every turn, since the near side changes with it.
function drawMarks() {
    clear(marks);
    const { jd, latitude, longitude } = state;
    const r = earthRadiusPx;
    if (r < EARTH_PX.in / 2) return;
    const obliquity = precise.earth.trueObliquity(ephemerisDay(jd));
    const theta = precise.siderealTime(precise.fromJulianDay(jd));
    const toScene = viewToScene(rotation);
    const place = (p: Point, lift = 0.15) => {
        const q = toScene(p.x * r, p.y * r, (p.z + lift) * r);
        return { x: q.x + bodyPoints.earth.x, y: q.y + bodyPoints.earth.y, z: q.z + bodyPoints.earth.z };
    };
    const line = faint(INK, 55);
    const runs = (points: Point[]) => {
        let run: Point[] = [];
        for (const p of [...points, { x: 0, y: 0, z: -1 }]) {
            if (p.z >= 0) run.push(place(p));
            else if (run.length > 1) {
                styled(new Shape({ addTo: marks, path: run, closed: false, color: line, fill: false }), 1);
                run = [];
            } else run = [];
        }
    };
    runs(Array.from({ length: 360 / SPHERE_STEP + 1 }, (_, i) => earthUnit(i * SPHERE_STEP, 0, obliquity)));
    // The axis beyond the poles, only where it clears the disc: behind Earth, from where it emerges from the silhouette.
    const pole = earthUnit(0, 90, obliquity);
    for (const sign of [1, -1]) {
        const from = Math.max(1, 1 / (Math.hypot(pole.x, pole.y) || 1));
        if (from >= AXIS_REACH) continue;
        const along = (t: number) => place({ x: sign * pole.x * t, y: sign * pole.y * t, z: sign * pole.z * t }, 0);
        styled(new Shape({ addTo: marks, path: [along(from), along(AXIS_REACH)], closed: false, color: INK }), 1);
    }
    // The chosen place, with its own up, the zenith, as a short line straight out of the ground.
    const observer = earthUnit(theta + longitude, latitude, obliquity);
    if (observer.z > 0) {
        const up = (t: number) => place({ x: observer.x * t, y: observer.y * t, z: observer.z * t });
        styled(new Shape({ addTo: marks, path: [up(1), up(1 + UP_REACH)], closed: false, color: ACCENT }), 1.5);
        styled(new Shape({ addTo: marks, translate: place(observer), color: ACCENT }), 5);
    }
}

/** The labels, each beside its point as the scene now shows it, on the far side from what it refers to; one that
 *  would sit on another moves down a line. */
function placeLabels() {
    const placed: { x: number; y: number; text: string; anchor: string }[] = [];
    for (const { text, point, away } of labels) {
        const p = turn(point, rotation);
        const from = turn(away, rotation);
        const [dx, dy] = [p.x - from.x, p.y - from.y];
        const length = Math.hypot(dx, dy) || 1;
        const [ux, uy] = [dx / length, dy / length];
        // Text starts at the point's right or ends at its left, as the push goes, and is centered when it goes up or down.
        const anchor = ux > 0.3 ? "0" : ux < -0.3 ? "-100%" : "-50%";
        const x = stageWidth / 2 + p.x + ux * LABEL_GAP_PX;
        let y = stageHeight / 2 + p.y + uy * LABEL_GAP_PX;
        while (placed.some((other) => Math.abs(other.y - y) < LABEL_LINE_PX && Math.abs(other.x - x) < 70)) {
            y += LABEL_LINE_PX;
        }
        placed.push({ x, y, text, anchor });
    }
    labelsEl.replaceChildren(
        ...placed.map(({ x, y, text, anchor }) => {
            const label = document.createElement("span");
            label.className = "dome-compass-label";
            label.dataset.exportText = "";
            label.textContent = text;
            label.style.left = `${x}px`;
            label.style.top = `${y}px`;
            label.style.transform = `translate(${anchor}, -50%)`;
            return label;
        }),
    );
}

function frame() {
    earth?.update(bodyPoints.sun, bodyPoints.earth, rotation, 1);
    moon?.update(bodyPoints.sun, bodyPoints.moon, rotation, 1);
    for (const { yaw, face } of billboards) {
        yaw.rotate.set({ x: 0, y: -rotation.y, z: 0 });
        face.rotate.set({ x: -rotation.x, y: 0, z: 0 });
    }
    drawMarks();
    placeLabels();
    illustration.rotate.set(rotation);
    illustration.updateRenderGraph();
    themeColors(illustration.element);
    for (const [shape, dash] of dashes) shape.svgElement?.classList.add(dash);
}

let dragFrom: { x: number; y: number } | null = null;
frameEl.addEventListener("pointerdown", (event) => {
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

// Drawn only when something changed: a drag, a resize, the zoom, or the moment and place.
const requestFrame = onDemand(frame);
function update() {
    rebuild();
    requestFrame();
}
zoomInput.addEventListener("input", update);
onChange(onDemand(update, frameEl));
new ResizeObserver(update).observe(frameEl);
update();
