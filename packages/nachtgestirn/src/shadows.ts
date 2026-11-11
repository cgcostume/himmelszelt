import {
    cross3 as cross,
    dot3 as dot,
    normalize3 as normalize,
    REFRACTION_SAMPLES,
    type RefractionTable,
    toSelenographic,
    type Vec3,
} from "./orientation.js";

/** The band the shadow map covers, as angles from the subsolar point: NG_BAND_FROM and NG_BAND_TO in moon.comp.wgsl. */
const BAND_FROM = Math.PI / 2 - 0.45;
const BAND_TO = Math.PI / 2 + 0.12;
/** Rays across the view in each direction, to find what of the Moon it shows. */
const GRID = 24;
/** How much wider than needed a window is made, each side, so a view that moves a little keeps it. */
const SLACK = 0.25;

/** What the pass needs of the view and the Moon to plan its shadow map. */
export interface ShadowView {
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    direction: Vec3;
    angularDiameter: number;
    sunDirection: Vec3;
    sunAngularDiameter: number;
    orientation: Float32Array;
    refraction: RefractionTable | null;
}

/** A shadow map's window in the band's frame: as params.wgsl's `shadowSun`, `shadowEast` and `shadowWindow` hold it. */
export interface ShadowWindow {
    /** The Sun in the Moon's frame it was made for, the axis longitudes count from, and the viewer's direction. */
    sun: Vec3;
    east: Vec3;
    viewer: Vec3;
    /** A texel's angle on the unit sphere, the window's first longitude and first angle from the subsolar point. */
    texel: number;
    longitude: number;
    theta: number;
    /** Its size in texels. */
    width: number;
    height: number;
    /** Whether it holds the whole ring, which no view can leave. */
    ring: boolean;
    /** The Sun's angular diameter in degrees it was made for, 0 a point: its shadows' penumbrae. */
    sunDiameter: number;
    /** What of it the view needs, without the slack: first longitude, its span, first and last angle from the Sun. */
    needed: readonly [number, number, number, number];
}

/** What `planShadows` finds: the disc's size in pixels, and the window the view needs, or null for none. */
export interface ShadowPlan {
    discPixels: number;
    window: ShadowWindow | null;
}

// dunstkreis' dkUnproject and dkProjectRay, in camera.wgsl, as the pass casts its rays.
function unproject(m: Float32Array, x: number, y: number): Vec3 {
    const at = (i: number) => m[i] ?? 0;
    const ew = at(11) === 0 ? 1 : at(11);
    const w = at(3) * x + at(7) * y + at(11) * 0.5 + at(15);
    return normalize([
        (at(0) * x + at(4) * y + at(8) * 0.5 + at(12)) / w - at(8) / ew,
        (at(1) * x + at(5) * y + at(9) * 0.5 + at(13)) / w - at(9) / ew,
        (at(2) * x + at(6) * y + at(10) * 0.5 + at(14)) / w - at(10) / ew,
    ]);
}

function projectRay(m: Float32Array, x: number, y: number, d: number): Vec3 {
    const view = unproject(m, x, y);
    if (d <= 0) return view;
    const center = unproject(m, 0, 0);
    const along = dot(view, center);
    const offset: Vec3 = [view[0] - center[0] * along, view[1] - center[1] * along, view[2] - center[2] * along];
    const rho = Math.hypot(...offset) / along;
    if (rho < 1e-7) return center;
    const k = rho / (d + 1);
    const cosTheta = (Math.sqrt(1 + k * k * (1 - d * d)) - k * k * d) / (1 + k * k);
    const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
    const o = normalize(offset);
    return [
        center[0] * cosTheta + o[0] * sinTheta,
        center[1] * cosTheta + o[1] * sinTheta,
        center[2] * cosTheta + o[2] * sinTheta,
    ];
}

// The pass' ngUnbend: the ray as it left the air.
function unbend(view: Vec3, table: RefractionTable | null): Vec3 {
    const horizontal = Math.hypot(view[0], view[1]);
    if (!table || table.step <= 0 || horizontal < 1e-6) return view;
    const apparent = Math.atan2(view[2], horizontal);
    const x = Math.min(Math.max((apparent - table.from) / table.step, 0), REFRACTION_SAMPLES - 1);
    const i = Math.min(Math.floor(x), REFRACTION_SAMPLES - 2);
    const bend = (table.bends[i] ?? 0) + ((table.bends[i + 1] ?? 0) - (table.bends[i] ?? 0)) * (x - i);
    const altitude = apparent - bend;
    return [
        (view[0] / horizontal) * Math.cos(altitude),
        (view[1] / horizontal) * Math.cos(altitude),
        Math.sin(altitude),
    ];
}

const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.min(Math.max(dot(a, b), -1), 1));
const wrap = (a: number) => a - Math.floor(a / (2 * Math.PI)) * 2 * Math.PI;

/** The axis the band's longitudes count from, about the Sun in the Moon's frame: fixed by the Moon's own axes alone. */
function eastOf(sun: Vec3): Vec3 {
    return normalize(cross(Math.abs(sun[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], sun));
}

/**
 * Plans the shadow map for a view of `width` by `height` pixels: how many pixels the disc spans, and, from `from` pixels
 * on, the window of the band around the terminator the view shows, a texel to a pixel at most and never finer than
 * `finest`, an angle, holding at most `budget` texels: the whole ring where it fits, else what
 * the view shows with some slack. The Sun a disc from `softFrom` pixels on, else a point.
 */
export function planShadows(
    view: ShadowView,
    width: number,
    height: number,
    from: number,
    finest: number,
    budget: number,
    softFrom = 0,
): ShadowPlan {
    const m = view.direction;
    const radius = (view.angularDiameter / 2) * (Math.PI / 180);
    const sinA = Math.sin(radius);
    const d = Math.min(Math.max(view.projectionDistance, 0), 1);
    const ray = (px: number, py: number) =>
        unbend(projectRay(view.inverseViewProjection, (px / width) * 2 - 1, 1 - (py / height) * 2, d), view.refraction);
    const sun = toSelenographic(view.orientation, view.sunDirection);
    const east = eastOf(sun);
    const north = cross(sun, east);
    const viewer = toSelenographic(view.orientation, [-m[0], -m[1], -m[2]]);
    // The grid's rays: the point of the Moon each meets, or the limb's nearest, its band coordinates, and a pixel's angle.
    const cell = Math.max(width, height) / GRID;
    const samples: ({ longitude: number; theta: number } | null)[] = [];
    let pixelAngle = Number.POSITIVE_INFINITY;
    let nearest = { angle: Number.POSITIVE_INFINITY, pixel: 0 };
    for (let j = 0; j <= GRID; j++) {
        for (let i = 0; i <= GRID; i++) {
            const [px, py] = [(i / GRID) * width, (j / GRID) * height];
            const v = ray(px, py);
            const pixel = angleBetween(v, ray(px + 1, py));
            const angle = angleBetween(v, m);
            if (angle < nearest.angle) nearest = { angle, pixel };
            if (angle > radius * 1.01 + cell * pixel) {
                samples.push(null);
                continue;
            }
            pixelAngle = Math.min(pixelAngle, pixel);
            const cosC = dot(v, m);
            const t = cosC - Math.sqrt(Math.max(cosC * cosC - 1 + sinA * sinA, 0));
            const body = toSelenographic(
                view.orientation,
                normalize([t * v[0] - m[0], t * v[1] - m[1], t * v[2] - m[2]]),
            );
            samples.push({ longitude: Math.atan2(dot(body, north), dot(body, east)), theta: angleBetween(body, sun) });
        }
    }
    if (!Number.isFinite(pixelAngle)) pixelAngle = nearest.pixel;
    const discPixels = (2 * radius) / Math.max(pixelAngle, 1e-12);
    if (discPixels < from) return { discPixels, window: null };
    let texel = finest * 2 ** Math.max(0, Math.floor(Math.log2(pixelAngle / sinA / finest)));
    const window = (
        longitude: number,
        theta: number,
        span: number,
        thetaSpan: number,
        ring: boolean,
        needed: ShadowWindow["needed"] = [longitude, span, theta, theta + thetaSpan],
    ): ShadowWindow => {
        while (Math.ceil(span / texel) * Math.ceil(thetaSpan / texel) > budget) texel *= 2;
        return {
            sun,
            east,
            viewer,
            texel,
            longitude,
            theta,
            width: Math.ceil(span / texel),
            height: Math.ceil(thetaSpan / texel),
            ring,
            sunDiameter: discPixels >= softFrom ? view.sunAngularDiameter : 0,
            needed,
        };
    };
    const ring = () => window(0, BAND_FROM, 2 * Math.PI, BAND_TO - BAND_FROM, true);
    if (Math.ceil((2 * Math.PI) / texel) * Math.ceil((BAND_TO - BAND_FROM) / texel) <= budget) {
        return { discPixels, window: ring() };
    }
    // The band's part the view shows: its samples' extent, widened by the most a cell moves either coordinate, since
    // the band may reach between them.
    let reference: number | null = null;
    let [low, high, thetaLow, thetaHigh, pad, thetaPad] = [Infinity, -Infinity, Infinity, -Infinity, 0, 0];
    for (let j = 0; j <= GRID; j++) {
        for (let i = 0; i <= GRID; i++) {
            const s = samples[j * (GRID + 1) + i];
            if (!s) continue;
            for (const n of [
                i < GRID ? samples[j * (GRID + 1) + i + 1] : null,
                j < GRID ? samples[(j + 1) * (GRID + 1) + i] : null,
            ]) {
                if (!n) continue;
                pad = Math.max(pad, Math.abs(wrap(n.longitude - s.longitude + Math.PI) - Math.PI));
                thetaPad = Math.max(thetaPad, Math.abs(n.theta - s.theta));
            }
            if (s.theta < BAND_FROM - 0.2 || s.theta > BAND_TO + 0.2) continue;
            reference ??= s.longitude;
            const relative = wrap(s.longitude - reference + Math.PI) - Math.PI;
            [low, high] = [Math.min(low, relative), Math.max(high, relative)];
            [thetaLow, thetaHigh] = [Math.min(thetaLow, s.theta), Math.max(thetaHigh, s.theta)];
        }
    }
    if (reference === null) return { discPixels, window: null };
    const span = high - low + 2 * pad;
    const thetaSpan = thetaHigh - thetaLow + 2 * thetaPad;
    const start = Math.max(thetaLow - thetaPad - SLACK * thetaSpan, BAND_FROM);
    const end = Math.min(thetaHigh + thetaPad + SLACK * thetaSpan, BAND_TO);
    if (span * (1 + 2 * SLACK) >= 2 * Math.PI || end <= start)
        return { discPixels, window: end > start ? ring() : null };
    const first = wrap(reference + low - pad);
    const needed = [
        first,
        span,
        Math.max(thetaLow - thetaPad, BAND_FROM),
        Math.min(thetaHigh + thetaPad, BAND_TO),
    ] as const;
    return {
        discPixels,
        window: window(wrap(first - SLACK * span), start, span * (1 + 2 * SLACK), end - start, false, needed),
    };
}

/** Whether a shadow map made for `made` still serves a view that needs `needed`: the same texel, Sun and Sun's size, the viewer
 *  much where it was, and the window the view needs within the one made. */
export function shadowsHold(made: ShadowWindow | null, needed: ShadowWindow): boolean {
    if (!made || made.texel !== needed.texel || made.ring !== needed.ring || made.sunDiameter !== needed.sunDiameter) {
        return false;
    }
    if (angleBetween(made.sun, needed.sun) > 0.05 * made.texel || angleBetween(made.viewer, needed.viewer) > 0.01) {
        return false;
    }
    if (made.ring) return true;
    // The window needed, without its slack, within the one made.
    const [first, span, thetaStart, thetaEnd] = needed.needed;
    return (
        wrap(first - made.longitude) + span <= made.width * made.texel &&
        thetaStart >= made.theta - 1e-9 &&
        thetaEnd <= made.theta + made.height * made.texel + 1e-9
    );
}
