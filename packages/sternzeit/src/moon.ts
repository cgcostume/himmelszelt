// Terms used here are explained in the himmelszelt site's glossary (site/src/data/glossary.json).
import {
    applyParallax,
    type Direction,
    type EclipticalCoords,
    EQUATORIAL_RADIUS_KM,
    type EquatorialCoords,
    eclipticalToEquatorial,
    equatorialToHorizontal,
    type HorizontalCoords,
    horizontalToDirection,
    type Observer,
} from "./coords.js";
import moonTables from "./data/moon.json" with { type: "json" };
import * as earth from "./earth.js";
import { angularSeparation, DEG_TO_RAD, flatTable, normalizeDegrees, polynomial, RAD_TO_DEG } from "./math.js";
import { apparentSiderealTime, apparentSiderealTimeApprox } from "./siderealTime.js";
import * as sun from "./sun.js";
import {
    type AstronomicalTime,
    type JulianCenturies,
    type JulianDay,
    julianCenturiesSinceStandardEquinox,
    julianEphemerisDay,
} from "./time.js";

/** Mean radius of the Moon, in kilometers. http://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html */
export const MEAN_RADIUS_KM = 1737.1;

/**
 * Mean length of a lunation, new moon to new moon, in days, per Meeus 49.1. The true
 * interval swings about half a day either side of it, so it locates a phase rather than timing it: stepping by it
 * from `MEAN_NEW_MOON` lands within a day of every new moon, which is enough to then search for one.
 */
export const MEAN_SYNODIC_MONTH = 29.530588861;

/**
 * The mean new moon of 2000 January 6, from which lunations are counted (Meeus 49.1): lunation k is at
 * `MEAN_NEW_MOON + k * MEAN_SYNODIC_MONTH`, a full moon half a lunation later. A Julian Ephemeris Day, like every
 * Julian Day these functions take.
 */
export const MEAN_NEW_MOON = 2451550.09766;

/** Inclination of the Moon's mean equator to the ecliptic (I), in radians. */
const MEAN_EQUATOR_INCLINATION = 1.54242 * DEG_TO_RAD;

/** Mean longitude, referred to the mean equinox of the date, in degrees, per Meeus 47.1. */
export function meanLongitude(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);

    const L0 = polynomial(T, 218.3164477, 481267.88123421, -0.0015786, 1 / 538841, -1 / 65194000);

    return normalizeDegrees(L0);
}

/** Approximation of {@link meanLongitude} per Jensen et al. 2001. */
export function meanLongitudeApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const L0 = (3.8104 + 8399.7091 * T) * RAD_TO_DEG;

    return normalizeDegrees(L0);
}

/** Mean elongation, in degrees, per Meeus 47.2. */
export function meanElongation(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);

    const D = polynomial(T, 297.8501921, 445267.1114034, -0.0018819, 1 / 545868, -1 / 113065000);

    return normalizeDegrees(D);
}

/** Approximation of {@link meanElongation} per Jensen et al. 2001. */
export function meanElongationApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const D = (5.1985 + 7771.3772 * T) * RAD_TO_DEG;

    return normalizeDegrees(D);
}

/** Mean anomaly, in degrees, per Meeus 47.4. */
export function meanAnomaly(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);

    const M = polynomial(T, 134.9633964, 477198.8675055, 0.0087414, 1 / 69699, -1 / 14712000);

    return normalizeDegrees(M);
}

/** Approximation of {@link meanAnomaly} per Jensen et al. 2001. */
export function meanAnomalyApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const M = (2.3554 + 8328.6911 * T) * RAD_TO_DEG;

    return normalizeDegrees(M);
}

/** Mean distance of the Moon from its ascending node, in degrees, per Meeus 47.5. */
export function meanArgumentOfLatitude(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);

    const F = polynomial(T, 93.272095, 483202.0175233, -0.0036539, -1 / 3526000, 1 / 863310000);

    return normalizeDegrees(F);
}

/** Approximation of {@link meanArgumentOfLatitude} per Jensen et al. 2001. */
export function meanArgumentOfLatitudeApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const F = (1.628 + 8433.4663 * T) * RAD_TO_DEG;

    return normalizeDegrees(F);
}

/** Longitude of the mean ascending node (Ω), in degrees, per Meeus 47.7. */
export function meanAscendingNodeLongitude(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const O = polynomial(T, 125.0445479, -1934.1362891, 0.0020754, 1 / 467441, -1 / 60616000);

    return normalizeDegrees(O);
}

/** {@link meanAscendingNodeLongitude} to two decimals, as Meeus' low-accuracy solar position takes it (ch. 25). */
export function meanAscendingNodeLongitudeApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const O = 125.04 + T * -1934.136;

    return normalizeDegrees(O);
}

/**
 * Correction factor for the eccentricity of the Earth's orbit around the Sun, used in the periodic terms
 * below (47.6). This is unrelated to `earth.orbitEccentricity`, which is ~60x smaller.
 */
function eccentricityCorrection(T: JulianCenturies): number {
    return polynomial(T, 1, -0.002516, -0.0000074);
}

/** Meeus' tables 47.A (D, M, M', F, then Σl and Σr) and 47.B (D, M, M', F, then Σb), flattened. */
const LONGITUDE_DISTANCE_TERMS = flatTable(moonTables.longitudeDistance.terms);
const LATITUDE_TERMS = flatTable(moonTables.latitude.terms);

/**
 * Sums a periodic series over a flattened table: each row's argument from D, M, M', F, times the factor E or E² its
 * multiple of M carries (47.6), times the coefficient in column `column` of rows `stride` long; cosines or sines.
 */
function periodicSum(t: JulianDay, table: Float64Array, stride: number, column: number, cosine: boolean): number {
    const E = eccentricityCorrection(julianCenturiesSinceStandardEquinox(t));
    const EE = E * E;
    const D = meanElongation(t) * DEG_TO_RAD;
    const M = sun.meanAnomaly(t) * DEG_TO_RAD;
    const Mm = meanAnomaly(t) * DEG_TO_RAD;
    const F = meanArgumentOfLatitude(t) * DEG_TO_RAD;
    const at = (i: number) => table[i] as number;

    let sum = 0;
    for (let i = 0; i < table.length; i += stride) {
        const coefficient = at(i + column);
        if (coefficient === 0) continue;
        const m = at(i + 1);
        const argument = at(i) * D + m * M + at(i + 2) * Mm + at(i + 3) * F;
        sum +=
            coefficient *
            (m === 0 ? 1 : m === 1 || m === -1 ? E : EE) *
            (cosine ? Math.cos(argument) : Math.sin(argument));
    }
    return sum;
}

/** Geocentric ecliptical position, geometric and referred to the mean equinox of the date, per Meeus ch. 47 (tables
 *  47.A and 47.B). {@link apparentPosition} adds the nutation. */
export function position(t: JulianDay): EclipticalCoords {
    const T = julianCenturiesSinceStandardEquinox(t);
    let Sl = periodicSum(t, LONGITUDE_DISTANCE_TERMS, 6, 4, false);
    let Sb = periodicSum(t, LATITUDE_TERMS, 5, 4, false);

    // Venus (A1), Jupiter (A2) and Earth's flattening (L', A3), in the same 0.000001°.
    const L = meanLongitude(t) * DEG_TO_RAD;
    const Mm = meanAnomaly(t) * DEG_TO_RAD;
    const F = meanArgumentOfLatitude(t) * DEG_TO_RAD;
    const A1 = (119.75 + 131.849 * T) * DEG_TO_RAD;
    const A2 = (53.09 + 479264.29 * T) * DEG_TO_RAD;
    const A3 = (313.45 + 481266.484 * T) * DEG_TO_RAD;
    Sl += 3958 * Math.sin(A1) + 1962 * Math.sin(L - F) + 318 * Math.sin(A2);
    Sb += -2235 * Math.sin(L) + 382 * Math.sin(A3) + 175 * Math.sin(A1 - F) + 175 * Math.sin(A1 + F);
    Sb += 127 * Math.sin(L - Mm) - 115 * Math.sin(L + Mm);

    return { longitude: normalizeDegrees(meanLongitude(t) + Sl / 1e6), latitude: Sb / 1e6 };
}

/** Approximation of {@link position} per Jensen et al. 2001. */
export function positionApprox(t: JulianDay): EclipticalCoords {
    const sM = sun.meanAnomalyApprox(t) * DEG_TO_RAD;

    const mL = meanLongitudeApprox(t) * DEG_TO_RAD;
    const mM = meanAnomalyApprox(t) * DEG_TO_RAD;
    const mD = meanElongationApprox(t) * DEG_TO_RAD;
    const mF = meanArgumentOfLatitudeApprox(t) * DEG_TO_RAD;

    let Sl = mL;

    Sl += 0.1098 * Math.sin(mM);
    Sl += 0.0222 * Math.sin(2 * mD - mM);
    Sl += 0.0115 * Math.sin(2 * mD);
    Sl += 0.0037 * Math.sin(2 * mM);
    Sl -= 0.0032 * Math.sin(sM);
    Sl -= 0.002 * Math.sin(2 * mF);
    Sl += 0.001 * Math.sin(2 * mD - 2 * mM);
    Sl += 0.001 * Math.sin(2 * mD - sM - mM);
    Sl += 0.0009 * Math.sin(2 * mD + mM);
    Sl += 0.0008 * Math.sin(2 * mD - sM);
    Sl -= 0.0007 * Math.sin(sM - mM);
    Sl -= 0.0006 * Math.sin(mD);
    Sl -= 0.0005 * Math.sin(sM + mM);

    let Sb = 0.0;

    Sb += 0.0895 * Math.sin(mF);
    Sb += 0.0049 * Math.sin(mM + mF);
    Sb += 0.0048 * Math.sin(mM - mF);
    Sb += 0.003 * Math.sin(2 * mD - mF);
    Sb += 0.001 * Math.sin(2 * mD - mM + mF);
    Sb += 0.0008 * Math.sin(2 * mD - mM - mF);
    Sb += 0.0006 * Math.sin(2 * mD + mF);

    return { longitude: normalizeDegrees(Sl * RAD_TO_DEG), latitude: Sb * RAD_TO_DEG };
}

/** Apparent geocentric equatorial position, per Meeus ch. 47: {@link position} moved to the true equinox of the date by
 *  the nutation in longitude (Δψ), at the true obliquity. The Moon's light time of ~1.3 s (~0.7") is left out. */
export function apparentPosition(t: JulianDay): EquatorialCoords {
    const { longitude, latitude } = position(t);
    return eclipticalToEquatorial(
        { longitude: longitude + earth.longitudeNutation(t), latitude },
        earth.trueObliquity(t),
    );
}

/** Approximation of {@link apparentPosition}, from the approximate chain. */
export function apparentPositionApprox(t: JulianDay): EquatorialCoords {
    const { longitude, latitude } = positionApprox(t);
    const ecl = { longitude: longitude + earth.longitudeNutationApprox(t), latitude };
    return eclipticalToEquatorial(ecl, earth.trueObliquityApprox(t));
}

/** Equatorial horizontal parallax (π), in degrees: the angle Earth's equatorial radius spans at the Moon's distance,
 *  per Meeus ch. 47. The observer's place on the ellipsoid enters in `applyParallax`. */
export function equatorialHorizontalParallax(t: JulianDay): number {
    return Math.asin(EQUATORIAL_RADIUS_KM / distance(t)) * RAD_TO_DEG;
}

/** Approximation of {@link equatorialHorizontalParallax}, from the approximate chain. */
export function equatorialHorizontalParallaxApprox(t: JulianDay): number {
    return Math.asin(EQUATORIAL_RADIUS_KM / distanceApprox(t)) * RAD_TO_DEG;
}

/** The Moon's topocentric equatorial position: apparentPosition corrected for an observer's parallax, since
 *  at the Moon's distance (~384,000 km) that shift is on the order of a degree (sun.ts has the same shape,
 *  though its parallax is only ~8.8"). Feeds horizontalPosition below. */
export function topocentricPosition(time: AstronomicalTime, observer: Observer): EquatorialCoords {
    const t = julianEphemerisDay(time);
    const s = apparentSiderealTime(time);

    return applyParallax(apparentPosition(t), equatorialHorizontalParallax(t), s, observer);
}

/** Approximation of {@link topocentricPosition}, from the approximate chain. */
export function topocentricPositionApprox(time: AstronomicalTime, observer: Observer): EquatorialCoords {
    const t = julianEphemerisDay(time);
    const s = apparentSiderealTimeApprox(time);

    return applyParallax(apparentPositionApprox(t), equatorialHorizontalParallaxApprox(t), s, observer);
}

/** Horizontal position as seen by the observer, in degrees: the topocentric position turned by the local apparent
 *  sidereal time (Meeus 13.5, 13.6). The true altitude, without refraction. */
export function horizontalPosition(time: AstronomicalTime, observer: Observer): HorizontalCoords {
    return equatorialToHorizontal(topocentricPosition(time, observer), apparentSiderealTime(time), observer);
}

/** Approximation of {@link horizontalPosition}, from the approximate chain. */
export function horizontalPositionApprox(time: AstronomicalTime, observer: Observer): HorizontalCoords {
    return equatorialToHorizontal(
        topocentricPositionApprox(time, observer),
        apparentSiderealTimeApprox(time),
        observer,
    );
}

/** Distance from the center of the Moon to the center of the Earth, in kilometers, per Meeus ch. 47 (table 47.A). */
export function distance(t: JulianDay): number {
    return 385_000.56 + periodicSum(t, LONGITUDE_DISTANCE_TERMS, 6, 5, true) / 1000;
}

/** Approximation of {@link distance} per Jensen et al. 2001. */
export function distanceApprox(t: JulianDay): number {
    const sM = sun.meanAnomalyApprox(t) * DEG_TO_RAD;

    const mM = meanAnomalyApprox(t) * DEG_TO_RAD;
    const mD = meanElongationApprox(t) * DEG_TO_RAD;

    let Sr = 0.016593;

    Sr += 0.000904 * Math.cos(mM);
    Sr += 0.000166 * Math.cos(2 * mD - mM);
    Sr += 0.000137 * Math.cos(2 * mD);
    Sr += 0.000049 * Math.cos(2 * mM);
    Sr += 0.000015 * Math.cos(2 * mD + mM);
    Sr += 0.000009 * Math.cos(2 * mD - sM);

    // Sr is the sine of the equatorial horizontal parallax, so it measures the equatorial radius, not the mean one.
    return EQUATORIAL_RADIUS_KM / Sr;
}

/** The Moon's apparent angular diameter as seen from Earth's center, in degrees. */
export function apparentAngularDiameter(t: JulianDay): number {
    return 2 * Math.atan(MEAN_RADIUS_KM / distance(t)) * RAD_TO_DEG;
}

/** Approximation of {@link apparentAngularDiameter}, from the approximate chain. */
export function apparentAngularDiameterApprox(t: JulianDay): number {
    return 2 * Math.atan(MEAN_RADIUS_KM / distanceApprox(t)) * RAD_TO_DEG;
}

/**
 * The Moon's angular diameter as seen by the observer, in degrees: larger than from Earth's center by up to about 1.7%
 * when it stands high, as the observer is then that much closer to it. s' = s (1 + sin h sin π), after Meeus ch. 40.
 */
export function topocentricAngularDiameter(time: AstronomicalTime, observer: Observer): number {
    const t = julianEphemerisDay(time);
    const h = horizontalPosition(time, observer).altitude * DEG_TO_RAD;
    return apparentAngularDiameter(t) * (1 + Math.sin(h) * Math.sin(equatorialHorizontalParallax(t) * DEG_TO_RAD));
}

export function topocentricAngularDiameterApprox(time: AstronomicalTime, observer: Observer): number {
    const t = julianEphemerisDay(time);
    const h = horizontalPositionApprox(time, observer).altitude * DEG_TO_RAD;
    const parallax = equatorialHorizontalParallaxApprox(t) * DEG_TO_RAD;
    return apparentAngularDiameterApprox(t) * (1 + Math.sin(h) * Math.sin(parallax));
}

export interface MoonLibration {
    /** Libration in longitude, in degrees, -180 to 180: positive shows more of the Moon's eastern limb. */
    longitude: number;
    /** Libration in latitude, in degrees: positive shows more of the Moon's north. */
    latitude: number;
}

/** Wraps an angle in degrees into [-180, 180). */
const wrap180 = (deg: number) => normalizeDegrees(deg + 180) - 180;

/**
 * Optical libration (l', b') from the Moon's geometric ecliptical position, per Meeus 53.1, where W = λ - Δψ - Ω on the
 * apparent longitude is λ - Ω on the geometric one. Also returns the angle A the physical libration takes, in radians.
 * All inputs in degrees.
 */
function optical(ecl: EclipticalCoords, node: number, argumentOfLatitude: number) {
    const la = ecl.latitude * DEG_TO_RAD;
    const W = (ecl.longitude - node) * DEG_TO_RAD;
    const cosI = Math.cos(MEAN_EQUATOR_INCLINATION);
    const sinI = Math.sin(MEAN_EQUATOR_INCLINATION);

    const A = Math.atan2(Math.sin(W) * Math.cos(la) * cosI - Math.sin(la) * sinI, Math.cos(W) * Math.cos(la));
    const b = Math.asin(-Math.sin(W) * Math.cos(la) * sinI - Math.sin(la) * cosI);

    return { longitude: wrap180(A * RAD_TO_DEG - argumentOfLatitude), latitude: b * RAD_TO_DEG, A };
}

/** Optical librations: the tilt and the varying speed of the orbit alone, per Meeus 53.1. */
export function opticalLibrations(t: JulianDay): MoonLibration {
    const { longitude, latitude } = optical(position(t), meanAscendingNodeLongitude(t), meanArgumentOfLatitude(t));
    return { longitude, latitude };
}

/** Approximation of {@link opticalLibrations} per Jensen et al. 2001. */
export function opticalLibrationsApprox(t: JulianDay): MoonLibration {
    const node = meanAscendingNodeLongitudeApprox(t);
    const { longitude, latitude } = optical(positionApprox(t), node, meanArgumentOfLatitudeApprox(t));
    return { longitude, latitude };
}

/**
 * The physical libration's ρ, σ and τ, in degrees: the Moon's own wobble about its mean rotation, driven by Earth's and
 * the Sun's pull on its uneven mass, per Meeus ch. 53. Below 0.04°.
 */
function physicalTerms(t: JulianDay): { rho: number; sigma: number; tau: number } {
    const T = julianCenturiesSinceStandardEquinox(t);
    const D = meanElongation(t) * DEG_TO_RAD;
    const M = sun.meanAnomaly(t) * DEG_TO_RAD;
    const Mm = meanAnomaly(t) * DEG_TO_RAD;
    const F = meanArgumentOfLatitude(t) * DEG_TO_RAD;
    const O = meanAscendingNodeLongitude(t) * DEG_TO_RAD;
    const E = eccentricityCorrection(T);
    const K1 = (119.75 + 131.849 * T) * DEG_TO_RAD;
    const K2 = (72.56 + 20.186 * T) * DEG_TO_RAD;

    // biome-ignore format: the series as Meeus prints it, wrapped by hand
    const rho =
        -0.02752 * Math.cos(Mm) - 0.02245 * Math.sin(F) + 0.00684 * Math.cos(Mm - 2 * F) - 0.00293 * Math.cos(2 * F) -
        0.00085 * Math.cos(2 * F - 2 * D) - 0.00054 * Math.cos(Mm - 2 * D) - 0.0002 * Math.sin(Mm + F) -
        0.0002 * Math.cos(Mm + 2 * F) - 0.0002 * Math.cos(Mm - F) + 0.00014 * Math.cos(Mm + 2 * F - 2 * D);

    // biome-ignore format: the series as Meeus prints it, wrapped by hand
    const sigma =
        -0.02816 * Math.sin(Mm) + 0.02244 * Math.cos(F) - 0.00682 * Math.sin(Mm - 2 * F) - 0.00279 * Math.sin(2 * F) -
        0.00083 * Math.sin(2 * F - 2 * D) + 0.00069 * Math.sin(Mm - 2 * D) + 0.0004 * Math.cos(Mm + F) -
        0.00025 * Math.sin(2 * Mm) - 0.00023 * Math.sin(Mm + 2 * F) + 0.0002 * Math.cos(Mm - F) +
        0.00019 * Math.sin(Mm - F) + 0.00013 * Math.sin(Mm + 2 * F - 2 * D) - 0.0001 * Math.cos(Mm - 3 * F);

    // biome-ignore format: the series as Meeus prints it, wrapped by hand
    const tau =
        0.0252 * E * Math.sin(M) + 0.00473 * Math.sin(2 * Mm - 2 * F) - 0.00467 * Math.sin(Mm) +
        0.00396 * Math.sin(K1) + 0.00276 * Math.sin(2 * Mm - 2 * D) + 0.00196 * Math.sin(O) -
        0.00183 * Math.cos(Mm - F) + 0.00115 * Math.sin(Mm - 2 * D) - 0.00096 * Math.sin(Mm - D) +
        0.00046 * Math.sin(2 * F - 2 * D) - 0.00039 * Math.sin(Mm - F) - 0.00032 * Math.sin(Mm - M - D) +
        0.00027 * Math.sin(2 * Mm - M - 2 * D) + 0.00023 * Math.sin(K2) - 0.00014 * Math.sin(2 * D) +
        0.00014 * Math.cos(2 * Mm - 2 * F) - 0.00012 * Math.sin(Mm - 2 * F) - 0.00012 * Math.sin(2 * Mm) +
        0.00011 * Math.sin(2 * Mm - 2 * M - 2 * D);

    return { rho, sigma, tau };
}

/**
 * Total librations, optical plus physical (53.2), per Meeus ch. 53: which part of the
 * Moon's face is turned towards Earth's center.
 */
export function librations(t: JulianDay): MoonLibration {
    const o = optical(position(t), meanAscendingNodeLongitude(t), meanArgumentOfLatitude(t));
    const { rho, sigma, tau } = physicalTerms(t);
    const cosA = Math.cos(o.A);
    const sinA = Math.sin(o.A);

    return {
        longitude: wrap180(o.longitude - tau + (rho * cosA + sigma * sinA) * Math.tan(o.latitude * DEG_TO_RAD)),
        latitude: o.latitude + sigma * cosA - rho * sinA,
    };
}

/** The optical librations alone: the physical part stays below 0.04°. */
export function librationsApprox(t: JulianDay): MoonLibration {
    return opticalLibrationsApprox(t);
}

/**
 * Parallactic angle (q), in degrees, per Meeus 14.1: the angle at the Moon between the directions to the celestial
 * north pole and to the zenith, from the Moon's topocentric position, as the observer sees it.
 */
export function parallacticAngle(time: AstronomicalTime, observer: Observer): number {
    return parallactic(topocentricPosition(time, observer), apparentSiderealTime(time), observer);
}

/** Approximation of {@link parallacticAngle}, from the approximate chain. */
export function parallacticAngleApprox(time: AstronomicalTime, observer: Observer): number {
    return parallactic(topocentricPositionApprox(time, observer), apparentSiderealTimeApprox(time), observer);
}

/** Meeus 14.1 from the local hour angle H = θ + L - α (Meeus ch. 13), all in degrees. */
function parallactic(pos: EquatorialCoords, siderealTime: number, { latitude, longitude }: Observer): number {
    const la = latitude * DEG_TO_RAD;
    const de = pos.declination * DEG_TO_RAD;
    const H = (siderealTime + longitude - pos.rightAscension) * DEG_TO_RAD;

    const q = Math.atan2(
        Math.sin(H) * Math.cos(la),
        Math.sin(la) * Math.cos(de) - Math.sin(de) * Math.cos(la) * Math.cos(H),
    );
    return q * RAD_TO_DEG;
}

/**
 * Position angle of the Moon's axis of rotation (P), in degrees, from the north point of the disc through east, per
 * Meeus ch. 53, with the physical libration.
 */
export function positionAngleOfAxis(t: JulianDay): number {
    const { rho, sigma } = physicalTerms(t);
    const node =
        meanAscendingNodeLongitude(t) + earth.longitudeNutation(t) + sigma / Math.sin(MEAN_EQUATOR_INCLINATION);
    const inclination = MEAN_EQUATOR_INCLINATION + rho * DEG_TO_RAD;

    return axisAngle(node, inclination, earth.trueObliquity(t), apparentPosition(t), librations(t).latitude);
}

/** Approximation per Jensen et al. 2001, without the physical libration. */
export function positionAngleOfAxisApprox(t: JulianDay): number {
    const node = meanAscendingNodeLongitudeApprox(t) + earth.longitudeNutationApprox(t);
    const b = opticalLibrationsApprox(t).latitude;

    return axisAngle(node, MEAN_EQUATOR_INCLINATION, earth.trueObliquityApprox(t), apparentPositionApprox(t), b);
}

/** P from V (degrees), the inclination (radians), the obliquity (degrees), α and the libration in latitude b. */
function axisAngle(V: number, inclination: number, obliquity: number, pos: EquatorialCoords, b: number): number {
    const v = V * DEG_TO_RAD;
    const e = obliquity * DEG_TO_RAD;
    const X = Math.sin(inclination) * Math.sin(v);
    const Y = Math.sin(inclination) * Math.cos(v) * Math.cos(e) - Math.cos(inclination) * Math.sin(e);
    const w = Math.atan2(X, Y);

    return (
        Math.asin((Math.hypot(X, Y) * Math.cos(pos.rightAscension * DEG_TO_RAD - w)) / Math.cos(b * DEG_TO_RAD)) *
        RAD_TO_DEG
    );
}

/** Geocentric elongation of the Moon from the Sun (ψ), in degrees, per Meeus 48.2. */
function elongation(moonPosition: EquatorialCoords, sunPosition: EquatorialCoords): number {
    const { rightAscension: a, declination: d } = moonPosition;

    return angularSeparation(sunPosition.rightAscension, sunPosition.declination, a, d);
}

/**
 * Phase angle (i), in degrees: the angle Sun-Moon-Earth, 0 at full moon and 180 at new moon, per Meeus
 * 48.3. Drives how much of the disc is lit (`illuminatedFraction`) and, from the other
 * side, how much of the Earth the Moon sees lit (`earthshine`).
 */
export function phaseAngle(t: JulianDay): number {
    const psi = elongation(apparentPosition(t), sun.apparentPosition(t)) * DEG_TO_RAD;
    const R = sun.distance(t);

    return Math.atan2(R * Math.sin(psi), distance(t) - R * Math.cos(psi)) * RAD_TO_DEG;
}

/** Phase angle from the mean elements alone, per Meeus 48.4; within ~0.2° of 48.3. */
export function phaseAngleApprox(t: JulianDay): number {
    const D = meanElongationApprox(t) * DEG_TO_RAD;
    const M = sun.meanAnomalyApprox(t) * DEG_TO_RAD;
    const Mm = meanAnomalyApprox(t) * DEG_TO_RAD;

    const i =
        180 -
        D * RAD_TO_DEG -
        6.289 * Math.sin(Mm) +
        2.1 * Math.sin(M) -
        1.274 * Math.sin(2 * D - Mm) -
        0.658 * Math.sin(2 * D) -
        0.214 * Math.sin(2 * Mm) -
        0.11 * Math.sin(D);

    return normalizeDegrees(i);
}

/** Illuminated fraction of the Moon's disc (k), 0 at new moon to 1 at full moon, per Meeus 48.1. */
export function illuminatedFraction(t: JulianDay): number {
    return (1 + Math.cos(phaseAngle(t) * DEG_TO_RAD)) / 2;
}

/** Approximation of {@link illuminatedFraction}, from the approximate chain. */
export function illuminatedFractionApprox(t: JulianDay): number {
    return (1 + Math.cos(phaseAngleApprox(t) * DEG_TO_RAD)) / 2;
}

/** Unit direction to the Moon in the observer's ENU frame (x east, y north, z up), for placing it in a scene. */
export function direction(time: AstronomicalTime, observer: Observer): Direction {
    return horizontalToDirection(horizontalPosition(time, observer));
}

/** Approximation of {@link direction}, from the approximate chain. */
export function directionApprox(time: AstronomicalTime, observer: Observer): Direction {
    return horizontalToDirection(horizontalPositionApprox(time, observer));
}

/**
 * Unit direction from the Moon's center towards the Sun, in the observer's local ENU frame (x east, y north, z up):
 * the light direction for shading the Moon's disc. Not quite the Sun's own direction as seen from Earth: the Moon
 * sits ~384,000 km off to the side, which turns the vector by up to ~0.15°.
 */
export function sunDirection(time: AstronomicalTime, observer: Observer): Direction {
    const t = julianEphemerisDay(time);
    return between(direction(time, observer), distance(t), sun.direction(time, observer), sun.distance(t));
}

/** Approximation of {@link sunDirection}, from the approximate chain. */
export function sunDirectionApprox(time: AstronomicalTime, observer: Observer): Direction {
    const t = julianEphemerisDay(time);
    return between(
        directionApprox(time, observer),
        distanceApprox(t),
        sun.directionApprox(time, observer),
        sun.distanceApprox(t),
    );
}

/** Unit vector from point `a` to point `b`, both given as a direction and a distance from the same origin. */
function between(a: Direction, aDistance: number, b: Direction, bDistance: number): Direction {
    const x = b[0] * bDistance - a[0] * aDistance;
    const y = b[1] * bDistance - a[1] * aDistance;
    const z = b[2] * bDistance - a[2] * aDistance;
    const length = Math.hypot(x, y, z);

    return [x / length, y / length, z / length];
}

/**
 * Earthshine on the Moon, the faint ashen glow of its night side from sunlight reflected by the Earth, as a relative
 * strength for shading that side: the Earth's albedo (0.19, after Jensen et al.) times half the phase function of the
 * Earth as seen from the Moon. Peaks at 0.095 at new moon, when the Moon sees a full Earth, and vanishes at full moon.
 * Not a fraction of sunlight: physically, earthshine is some 10^-4 of the sunlight on the Moon's day side. Per van de
 * Hulst, "Multiple Light Scattering" (1980), as used by osgHimmel.
 */
export function earthshine(t: JulianDay): number {
    // Half the elongation, clamped off both ends, where the formula is a 0 * infinity limit that tends to 0.
    const psi = elongation(apparentPosition(t), sun.apparentPosition(t)) * DEG_TO_RAD;
    const e = Math.min(Math.max(psi / 2, 1e-6), Math.PI / 2 - 1e-6);

    return 0.19 * 0.5 * (1 - Math.sin(e) * Math.tan(e) * Math.log(1 / Math.tan(e / 2)));
}

/** osgHimmel's polynomial fit of `earthshine`, within ~3% of it, with no logarithm or tangent to evaluate. */
export function earthshineApprox(t: JulianDay): number {
    const e = Math.PI - elongation(apparentPositionApprox(t), sun.apparentPositionApprox(t)) * DEG_TO_RAD;

    return Math.max(0, -0.0061 * e * e * e + 0.0289 * e * e - 0.0105 * Math.sin(e));
}
