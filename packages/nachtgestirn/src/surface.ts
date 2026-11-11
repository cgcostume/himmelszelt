// Places on the Moon: where a selenographic longitude and latitude lie in the observer's ENU frame, whether they face
// the viewer and the Sun, and a crater's rim around them, for marking craters, maria or landing sites on the disc.

import type { MoonParams } from "./moon.js";
import { MOON_RADIUS_KM, type Vec3 } from "./orientation.js";

const DEG = Math.PI / 180;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A point on the Moon's unit sphere in its own frame, from selenographic longitude, east positive, and latitude, in degrees. */
export function selenographicPoint(longitude: number, latitude: number): Vec3 {
    const [l, b] = [longitude * DEG, latitude * DEG];
    return [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
}

/** The way back from `toSelenographic`: a point in the Moon's own frame as a direction in the observer's ENU frame. */
export function fromSelenographic(orientation: Float32Array, body: Vec3): Vec3 {
    const column = (c: number): Vec3 => [
        orientation[c * 3] ?? 0,
        orientation[c * 3 + 1] ?? 0,
        orientation[c * 3 + 2] ?? 0,
    ];
    return [dot(column(0), body), dot(column(1), body), dot(column(2), body)];
}

/** A place on the Moon as the observer sees it, from `surfacePoint`. */
export interface SurfacePoint {
    /** The surface normal there, unit, ENU: across the disc it is `dot(normal, right)` and `dot(normal, up)` disc radii
     *  from the center, in whatever frame the disc is drawn in. */
    normal: Vec3;
    /** The cosine of the angle between the normal and the way to the viewer: 1 at the disc's center, 0 at its limb. */
    facing: number;
    /** On the side turned to the viewer. */
    visible: boolean;
    /** How high the Sun stands over the place's horizon, in degrees, negative at night: shadows are long below some 10°. */
    sunAltitude: number;
    /** In sunlight: the Sun's center above the place's horizon. */
    lit: boolean;
}

/**
 * Where the place at selenographic `longitude`, east positive, and `latitude`, in degrees, lies for the Moon of `moon`,
 * the same numbers the pass takes, and how it is seen and lit: seen from far away, the limb where the normal turns
 * across the line of sight.
 */
export function surfacePoint(
    moon: Pick<MoonParams, "orientation" | "direction" | "sunDirection">,
    longitude: number,
    latitude: number,
): SurfacePoint {
    const normal = fromSelenographic(moon.orientation, selenographicPoint(longitude, latitude));
    const facing = -dot(normal, moon.direction);
    const sunAltitude = Math.asin(Math.max(-1, Math.min(1, dot(normal, moon.sunDirection)))) / DEG;
    return { normal, facing, visible: facing > 0, sunAltitude, lit: sunAltitude > 0 };
}

/**
 * The rim of a crater `diameterKm` across around selenographic `longitude` and `latitude`, in degrees, as `count`
 * directions in the observer's ENU frame, from its north clockwise as seen from above: a circle on the Moon's sphere,
 * which the disc foreshortens towards the limb. A point is behind the Moon where its `dot` with `moon.direction` is
 * positive.
 */
export function surfaceCircle(
    moon: Pick<MoonParams, "orientation">,
    longitude: number,
    latitude: number,
    diameterKm: number,
    count = 64,
): Vec3[] {
    const [l, b] = [longitude * DEG, latitude * DEG];
    const center = selenographicPoint(longitude, latitude);
    const east: Vec3 = [-Math.sin(l), Math.cos(l), 0];
    const north: Vec3 = [-Math.sin(b) * Math.cos(l), -Math.sin(b) * Math.sin(l), Math.cos(b)];
    // The rim's angular radius at the Moon's center.
    const radius = diameterKm / 2 / MOON_RADIUS_KM;
    const [c, s] = [Math.cos(radius), Math.sin(radius)];
    return Array.from({ length: count }, (_, i) => {
        const a = (i / count) * 2 * Math.PI;
        const [n, e] = [Math.cos(a) * s, Math.sin(a) * s];
        const body: Vec3 = [
            center[0] * c + north[0] * n + east[0] * e,
            center[1] * c + north[1] * n + east[1] * e,
            center[2] * c + north[2] * n + east[2] * e,
        ];
        return fromSelenographic(moon.orientation, body);
    });
}
