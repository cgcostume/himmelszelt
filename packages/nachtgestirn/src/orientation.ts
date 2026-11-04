/**
 * Where the Moon's face is turned, as a matrix, and the light that reaches it: the astronomy stays with the caller
 * (`@himmelszelt/sternzeit` on the himmelszelt site), which hands over angles and directions.
 */

export type Vec3 = readonly [x: number, y: number, z: number];

const DEG = Math.PI / 180;
const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec3): Vec3 => {
    const length = Math.hypot(a[0], a[1], a[2]);
    return [a[0] / length, a[1] / length, a[2] / length];
};

/** What turns the Moon's face: the libration, the position angle of its axis and the parallactic angle, in degrees. */
export interface MoonOrientationInput {
    /** Unit direction towards the Moon in the observer's ENU frame (x east, y north, z up). */
    direction: Vec3;
    /** The libration in longitude, positive showing more of the eastern limb, and in latitude, positive more of the
     *  north, in degrees: `moon.librations` of `@himmelszelt/sternzeit`. */
    libration: { longitude: number; latitude: number };
    /** Position angle of the Moon's axis of rotation, from the north point of the disc through east, in degrees:
     *  `moon.positionAngleOfAxis`. */
    positionAngleOfAxis: number;
    /** The parallactic angle at the Moon, in degrees, which turns the sky's north to the observer's up:
     *  `moon.parallacticAngle`. */
    parallacticAngle: number;
}

/**
 * The frame the Moon is seen in from its direction: right across the view, up towards the zenith, and towards the
 * viewer, in the observer's ENU frame. Straight overhead, where the zenith gives no up, north is up.
 */
export function viewFrame(direction: Vec3): { right: Vec3; up: Vec3; toward: Vec3 } {
    const reference: Vec3 = Math.abs(direction[2]) > 0.999999 ? [0, 1, 0] : [0, 0, 1];
    // (v x z) x v: the zenith with the line of sight taken out of it.
    const up = normalize(cross(cross(direction, reference), direction));
    const right = cross(direction, up);
    return { right, up, toward: [-direction[0], -direction[1], -direction[2]] };
}

/**
 * The rotation from the observer's ENU frame into the Moon's own, selenographic frame (x towards 0° longitude, y
 * towards 90° east, z towards the north pole), as the Moon pass takes it: nine numbers, column major. A point of the
 * disc with the surface normal `n` is at `orientation * n` on the Moon. With the zenith up, the Moon's north pole stands
 * at the position angle of the axis minus the parallactic angle, counterclockwise from up; the disc's center shows the
 * libration's longitude and latitude.
 */
export function moonOrientation({
    direction,
    libration,
    positionAngleOfAxis,
    parallacticAngle,
}: MoonOrientationInput): Float32Array {
    const { right, up, toward } = viewFrame(direction);
    const tilt = (positionAngleOfAxis - parallacticAngle) * DEG;
    const [c, s] = [Math.cos(tilt), Math.sin(tilt)];
    // The disc's frame with the Moon's north up: east across the disc, north up, and towards the viewer.
    const east: Vec3 = [c * right[0] + s * up[0], c * right[1] + s * up[1], c * right[2] + s * up[2]];
    const north: Vec3 = [-s * right[0] + c * up[0], -s * right[1] + c * up[1], -s * right[2] + c * up[2]];
    // Those three in the Moon's own frame, for the point facing the viewer at the libration's longitude and latitude.
    const l = libration.longitude * DEG;
    const b = libration.latitude * DEG;
    const eastBody: Vec3 = [-Math.sin(l), Math.cos(l), 0];
    const northBody: Vec3 = [-Math.sin(b) * Math.cos(l), -Math.sin(b) * Math.sin(l), Math.cos(b)];
    const towardBody: Vec3 = [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];
    // Column k of the matrix: where the ENU axis k goes, eastBody * east_k + northBody * north_k + towardBody * toward_k.
    const matrix = new Float32Array(9);
    for (let k = 0; k < 3; k++) {
        for (let row = 0; row < 3; row++) {
            const e = (v: Vec3) => v[row] ?? 0;
            const a = (v: Vec3) => v[k] ?? 0;
            matrix[k * 3 + row] = e(eastBody) * a(east) + e(northBody) * a(north) + e(towardBody) * a(toward);
        }
    }
    return matrix;
}

/** `orientation` applied to a direction: where on the Moon a surface normal points, in its own frame. */
export function toSelenographic(orientation: Float32Array, n: Vec3): Vec3 {
    const m = (row: number, col: number) => orientation[col * 3 + row] ?? 0;
    return [
        m(0, 0) * n[0] + m(0, 1) * n[1] + m(0, 2) * n[2],
        m(1, 0) * n[0] + m(1, 1) * n[1] + m(1, 2) * n[2],
        m(2, 0) * n[0] + m(2, 1) * n[1] + m(2, 2) * n[2],
    ];
}

/** Selenographic longitude, east positive, and latitude of a point on the Moon's unit sphere, in degrees. */
export function selenographic(body: Vec3): { longitude: number; latitude: number } {
    return {
        longitude: Math.atan2(body[1], body[0]) / DEG,
        latitude: Math.asin(Math.max(-1, Math.min(1, body[2]))) / DEG,
    };
}

/** The Sun's illuminance above the atmosphere, in lux, as `@himmelszelt/dunstkreis` has it. */
export const SUN_ILLUMINANCE = 128_000;

/** The Moon's geometric albedo, 0.12, and mean radius in km, after NASA's fact sheet. */
export const MOON_GEOMETRIC_ALBEDO = 0.12;
export const MOON_RADIUS_KM = 1737.4;

/** Earth's visual geometric albedo, 0.367, and mean radius in km, after NASA's fact sheet. */
export const EARTH_GEOMETRIC_ALBEDO = 0.367;
export const EARTH_RADIUS_KM = 6371;

/**
 * Earthshine: Earth's illuminance at the Moon, in lux, from its phase as the Moon sees it, `phaseAngle` in degrees, 0
 * for a full Earth, which the Moon sees at new moon, 180 - `moon.phaseAngle` of `@himmelszelt/sternzeit`, and its
 * distance in km. Earth as a Lambert sphere of its geometric albedo: a full Earth lights the Moon with some 13 lux,
 * a ten thousandth of the Sun, and about fifty times a full Moon lights Earth.
 */
export function earthshineIlluminance(
    phaseAngle: number,
    distanceKm: number,
    sunIlluminance = SUN_ILLUMINANCE,
): number {
    const a = Math.min(Math.max(phaseAngle, 0), 180) * DEG;
    const phase = (Math.sin(a) + (Math.PI - a) * Math.cos(a)) / Math.PI;
    return EARTH_GEOMETRIC_ALBEDO * phase * sunIlluminance * (EARTH_RADIUS_KM / distanceKm) ** 2;
}

/**
 * How much of its full brightness the Moon keeps at a phase angle, in degrees: Allen's lunar phase law, a tenth at
 * first and last quarter, a hundredth with a few days to new moon. For metering a picture of the Moon.
 */
export function phaseLaw(phaseAngle: number): number {
    const a = Math.abs(phaseAngle);
    return 10 ** (-0.4 * (0.026 * a + 4e-9 * a ** 4));
}

/**
 * The luminance of the Moon's disc averaged over all of it, in cd/m², at a phase angle in degrees: the full Moon
 * reflects its geometric albedo's share of the Sun's illuminance like a flat Lambert disc, some 4,900 cd/m² for
 * 128,000 lux, dimmed by the phase law and by what the air lets through. For exposing a picture of the Moon by.
 */
export function meanLuminance(
    phaseAngle: number,
    sunIlluminance = SUN_ILLUMINANCE,
    transmittance = 1,
    geometricAlbedo = MOON_GEOMETRIC_ALBEDO,
): number {
    return ((geometricAlbedo * sunIlluminance) / Math.PI) * phaseLaw(phaseAngle) * transmittance;
}

/** The EV100 a light meter exposes `luminance` in cd/m² as mid gray with: log2 of luminance times 8. */
export function ev100ForLuminance(luminance: number): number {
    return Math.log2(Math.max(luminance, 1e-6) * 8);
}

/** The z, in the observer's ENU frame, of the horizon as seen from `heightM` over a planet of `radiusKm`: rays below it
 *  hit the ground. -1 for none. */
export function horizonZ(heightM: number, radiusKm = EARTH_RADIUS_KM): number {
    const r = radiusKm / (radiusKm + heightM / 1000);
    return -Math.sqrt(Math.max(1 - r * r, 0));
}

export { cross as cross3, dot as dot3, normalize as normalize3 };
