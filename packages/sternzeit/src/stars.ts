// Terms used here are explained in the himmelszelt site's glossary (site/src/data/glossary.json).
// Where a catalog star stands tonight: proper motion and precession carry its J2000 position to the date (Meeus ch. 21),
// and one rotation carries the whole catalog from the J2000 equatorial frame into the observer's ENU frame, for a
// renderer that draws thousands of stars on the GPU (`@himmelszelt/sternenheer`). The catalog itself ships with that
// package; here is the math only.
import { type EquatorialCoords, equatorialToHorizontal, type HorizontalCoords, type Observer } from "./coords.js";
import { DEG_TO_RAD, normalizeDegrees, RAD_TO_DEG } from "./math.js";
import { apparentSiderealTime, apparentSiderealTimeApprox } from "./siderealTime.js";
import {
    type AstronomicalTime,
    J2000,
    type JulianDay,
    julianCenturiesSinceStandardEquinox,
    julianEphemerisDay,
} from "./time.js";

/** A star as a catalog lists it: its position at equinox J2000.0 and its own motion across the sky. */
export interface CatalogStar extends EquatorialCoords {
    /** Annual proper motion in right ascension, in arcseconds per year, on the sky (μα cos δ), as the Yale Bright
     *  Star Catalogue and Hipparcos list it. */
    properMotionRightAscension: number;
    /** Annual proper motion in declination, in arcseconds per year. */
    properMotionDeclination: number;
}

/** A 3 by 3 rotation, column major, as a GPU takes it: `m[column * 3 + row]`. */
export type Matrix3 = Float32Array;

const rotationZ = (angle: number): number[] => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [c, s, 0, -s, c, 0, 0, 0, 1];
};
const rotationY = (angle: number): number[] => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [c, 0, -s, 0, 1, 0, s, 0, c];
};
/** `a` times `b`, both column major: `b` applied first. */
export function multiplyMatrix3(a: ArrayLike<number>, b: ArrayLike<number>): Matrix3 {
    const m = new Float32Array(9);
    for (let column = 0; column < 3; column++) {
        for (let row = 0; row < 3; row++) {
            let sum = 0;
            for (let k = 0; k < 3; k++) sum += (a[k * 3 + row] ?? 0) * (b[column * 3 + k] ?? 0);
            m[column * 3 + row] = sum;
        }
    }
    return m;
}
/** `m` applied to a vector. */
export function applyMatrix3(m: ArrayLike<number>, [x, y, z]: readonly [number, number, number]) {
    return [
        (m[0] ?? 0) * x + (m[3] ?? 0) * y + (m[6] ?? 0) * z,
        (m[1] ?? 0) * x + (m[4] ?? 0) * y + (m[7] ?? 0) * z,
        (m[2] ?? 0) * x + (m[5] ?? 0) * y + (m[8] ?? 0) * z,
    ] as [number, number, number];
}

/** Equatorial coordinates in degrees as a unit vector: x towards the equinox, y towards 90° of right ascension, z
 *  towards the north celestial pole. */
export function equatorialToVector({ rightAscension, declination }: EquatorialCoords): [number, number, number] {
    const a = rightAscension * DEG_TO_RAD;
    const d = declination * DEG_TO_RAD;
    return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

/** The equatorial coordinates, in degrees, of a unit vector as `equatorialToVector` lays it out. */
export function vectorToEquatorial([x, y, z]: readonly [number, number, number]): EquatorialCoords {
    return {
        rightAscension: normalizeDegrees(Math.atan2(y, x) * RAD_TO_DEG),
        declination: Math.asin(Math.max(-1, Math.min(1, z))) * RAD_TO_DEG,
    };
}

/**
 * The three angles of the precession from J2000.0 to the mean equinox of the date, ζ, z and θ, in degrees, per Meeus
 * 21.2: the slow turning of Earth's axis, about 50 arcseconds a year, which moves every star's coordinates by far more
 * than its own motion does.
 */
export function precessionAngles(t: JulianDay): { zeta: number; z: number; theta: number } {
    const T = julianCenturiesSinceStandardEquinox(t);
    const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) / 3600;
    const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) / 3600;
    const theta = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) / 3600;
    return { zeta, z, theta };
}

/** The rotation from the J2000.0 equatorial frame to the mean equator and equinox of the date, Meeus 21.4 as a
 *  matrix: a J2000 catalog vector times it points where the star's precessed coordinates say. */
export function precessionMatrix(t: JulianDay): Matrix3 {
    const { zeta, z, theta } = precessionAngles(t);
    return multiplyMatrix3(
        multiplyMatrix3(rotationZ(z * DEG_TO_RAD), rotationY(-theta * DEG_TO_RAD)),
        rotationZ(zeta * DEG_TO_RAD),
    );
}

/** `precessionMatrix` with the angles as Jensen et al. 2001 approximate them, linear in the centuries: ζ and z as
 *  0.01118 T, θ as 0.00972 T, in radians. Within an arcsecond of Meeus' over a century. */
export function precessionMatrixApprox(t: JulianDay): Matrix3 {
    const T = julianCenturiesSinceStandardEquinox(t);
    return multiplyMatrix3(multiplyMatrix3(rotationZ(0.01118 * T), rotationY(-0.00972 * T)), rotationZ(0.01118 * T));
}

/** A catalog star's J2000 position moved by its proper motion to the date, in degrees. */
export function properMotion(star: CatalogStar, t: JulianDay): EquatorialCoords {
    const years = (t - J2000) / 365.25;
    const cosDeclination = Math.cos(star.declination * DEG_TO_RAD);
    return {
        rightAscension: normalizeDegrees(
            star.rightAscension + (star.properMotionRightAscension * years) / 3600 / Math.max(cosDeclination, 1e-9),
        ),
        declination: star.declination + (star.properMotionDeclination * years) / 3600,
    };
}

/**
 * Where a catalog star stands at the date: its proper motion applied, then the precession from J2000.0 to the mean
 * equinox of the date, per Meeus ch. 21, in degrees. Nutation and aberration, up to 20 arcseconds each, are left out,
 * as a renderer's pixels are coarser than that; `equatorialToHorizontal` with the apparent sidereal time then puts the
 * star in the sky. A whole catalog is better moved at once by `horizontalMatrix`.
 */
export function apparentPosition(star: CatalogStar, t: JulianDay): EquatorialCoords {
    return vectorToEquatorial(applyMatrix3(precessionMatrix(t), equatorialToVector(properMotion(star, t))));
}

/** `apparentPosition` with the approximate precession. */
export function apparentPositionApprox(star: CatalogStar, t: JulianDay): EquatorialCoords {
    return vectorToEquatorial(applyMatrix3(precessionMatrixApprox(t), equatorialToVector(properMotion(star, t))));
}

/** A catalog star's azimuth and altitude at the time and place, from `apparentPosition`. */
export function horizontalPosition(star: CatalogStar, time: AstronomicalTime, observer: Observer): HorizontalCoords {
    const t = julianEphemerisDay(time);
    return equatorialToHorizontal(apparentPosition(star, t), apparentSiderealTime(time), observer);
}

/** `horizontalPosition` with the approximate precession and sidereal time. */
export function horizontalPositionApprox(
    star: CatalogStar,
    time: AstronomicalTime,
    observer: Observer,
): HorizontalCoords {
    const t = julianEphemerisDay(time);
    return equatorialToHorizontal(apparentPositionApprox(star, t), apparentSiderealTimeApprox(time), observer);
}

/**
 * The rotation from equatorial coordinates of the date into the observer's ENU frame (x east, y north, z up), from the
 * Greenwich sidereal time in degrees and the place: the matrix form of `equatorialToHorizontal`, for turning a whole
 * catalog at once. The celestial pole lands in the north at the latitude's altitude.
 */
export function equatorialToHorizontalMatrix(siderealTime: number, { latitude, longitude }: Observer): Matrix3 {
    const theta = (siderealTime + longitude) * DEG_TO_RAD;
    const phi = latitude * DEG_TO_RAD;
    const [sinTheta, cosTheta, sinPhi, cosPhi] = [Math.sin(theta), Math.cos(theta), Math.sin(phi), Math.cos(phi)];
    // Rows east, north, up; stored column major.
    return new Float32Array([
        -sinTheta,
        -sinPhi * cosTheta,
        cosPhi * cosTheta,
        cosTheta,
        -sinPhi * sinTheta,
        cosPhi * sinTheta,
        0,
        cosPhi,
        sinPhi,
    ]);
}

/**
 * The one rotation that turns a J2000 catalog into tonight's sky: the precession to the date, then the turn of Earth
 * by the apparent sidereal time, into the observer's ENU frame. A star's J2000 vector (`equatorialToVector`) times
 * it is the direction to look in, as `horizontalToDirection` gives it for a single star. Proper motion is the star's own
 * and stays per star.
 */
export function horizontalMatrix(time: AstronomicalTime, observer: Observer): Matrix3 {
    const t = julianEphemerisDay(time);
    return multiplyMatrix3(equatorialToHorizontalMatrix(apparentSiderealTime(time), observer), precessionMatrix(t));
}

/** `horizontalMatrix` with the approximate precession and sidereal time. */
export function horizontalMatrixApprox(time: AstronomicalTime, observer: Observer): Matrix3 {
    const t = julianEphemerisDay(time);
    return multiplyMatrix3(
        equatorialToHorizontalMatrix(apparentSiderealTimeApprox(time), observer),
        precessionMatrixApprox(t),
    );
}
