// Terms used here are explained in the himmelszelt site's glossary (site/src/data/glossary.json).
import {
    type Direction,
    type EclipticalCoords,
    EQUATORIAL_RADIUS_KM,
    type EquatorialCoords,
    eclipticalToEquatorial,
    equatorialToHorizontal,
    equatorialToTopocentric,
    type HorizontalCoords,
    horizontalToDirection,
    type Observer,
} from "./coords.js";
import * as earth from "./earth.js";
import { ASTRONOMICAL_UNIT_KM, DEG_TO_RAD, normalizeDegrees, polynomial, RAD_TO_DEG } from "./math.js";
import { apparentSiderealTime, apparentSiderealTimeApprox } from "./siderealTime.js";
import {
    type AstronomicalTime,
    type JulianDay,
    julianCenturiesSinceStandardEquinox,
    julianEphemerisDay,
} from "./time.js";

/** Mean radius of the Sun, in kilometers. http://nssdc.gsfc.nasa.gov/planetary/factsheet/sunfact.html */
export const MEAN_RADIUS_KM = 696_000;

/** Mean anomaly (M), in degrees, per Meeus 47.3, the one the Moon's series take too. */
export function meanAnomaly(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const M = polynomial(T, 357.5291092, 35999.0502909, -0.0001536, 1 / 24490000);

    return normalizeDegrees(M);
}

/** Approximation of {@link meanAnomaly} per Jensen et al. 2001. */
export function meanAnomalyApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const M = (6.24 + 628.302 * T) * RAD_TO_DEG;

    return normalizeDegrees(M);
}

/** Geometric mean longitude (L0), referred to the mean equinox of the date, in degrees, per Meeus 25.2. */
export function meanLongitude(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const L0 = polynomial(T, 280.46646, 36000.76983, 0.0003032);

    return normalizeDegrees(L0);
}

/** {@link meanLongitude} to four decimals, as Meeus' short nutation formula takes it (ch. 22). */
export function meanLongitudeApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const L0 = 280.4665 + T * 36000.7698;

    return normalizeDegrees(L0);
}

/** Equation of the center (C), in degrees, per Meeus 25.4: how far the elliptic orbit puts the Sun ahead of or behind
 *  its mean position. */
export function equationOfCenter(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const M = meanAnomaly(t) * DEG_TO_RAD;

    return (
        polynomial(T, 1.914602, -0.004817, -0.000014) * Math.sin(M) +
        (0.019993 - T * 0.000101) * Math.sin(2.0 * M) +
        0.000289 * Math.sin(3.0 * M)
    );
}

/** Approximation of {@link equationOfCenter} per Jensen et al. 2001. */
export function equationOfCenterApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const M = meanAnomalyApprox(t) * DEG_TO_RAD;

    return ((0.033417 - 0.000084 * T) * Math.sin(M) + 0.000351 * Math.sin(2 * M)) * RAD_TO_DEG;
}

/** True anomaly (v = M + C), in degrees: the Sun's actual angle along its orbit from perigee. */
export function trueAnomaly(t: JulianDay): number {
    return meanAnomaly(t) + equationOfCenter(t);
}

/** Approximation of {@link trueAnomaly}, from the approximate chain. */
export function trueAnomalyApprox(t: JulianDay): number {
    return meanAnomalyApprox(t) + equationOfCenterApprox(t);
}

/** True geometric longitude (Θ = L0 + C), in degrees, referred to the mean equinox of the date. */
export function trueLongitude(t: JulianDay): number {
    return meanLongitude(t) + equationOfCenter(t);
}

/** Approximation of {@link trueLongitude} per Jensen et al. 2001, from their own mean longitude. */
export function trueLongitudeApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    return normalizeDegrees((4.895048 + 628.331951 * T) * RAD_TO_DEG + equationOfCenterApprox(t));
}

/**
 * Apparent longitude (λ), in degrees: the true longitude moved to the true equinox of the date by the nutation in
 * longitude and back by the aberration, 20.4898" / R with R in AU, per Meeus ch. 25.
 */
export function apparentLongitude(t: JulianDay): number {
    const R = distance(t) / ASTRONOMICAL_UNIT_KM;
    return normalizeDegrees(trueLongitude(t) + earth.longitudeNutation(t) - 20.4898 / 3600 / R);
}

/** {@link apparentLongitude} from the approximate true longitude and nutation. */
export function apparentLongitudeApprox(t: JulianDay): number {
    const R = distanceApprox(t) / ASTRONOMICAL_UNIT_KM;
    return normalizeDegrees(trueLongitudeApprox(t) + earth.longitudeNutationApprox(t) - 20.4898 / 3600 / R);
}

/** Apparent geocentric ecliptical position: the apparent longitude, and a latitude of 0, the Sun's staying below 1.2". */
export function apparentEclipticalPosition(t: JulianDay): EclipticalCoords {
    return { longitude: apparentLongitude(t), latitude: 0 };
}

/** Approximation of {@link apparentEclipticalPosition}, from the approximate chain. */
export function apparentEclipticalPositionApprox(t: JulianDay): EclipticalCoords {
    return { longitude: apparentLongitudeApprox(t), latitude: 0 };
}

/** Apparent equatorial position: the apparent ecliptical position at the true obliquity, per Meeus ch. 25. */
export function apparentPosition(t: JulianDay): EquatorialCoords {
    return eclipticalToEquatorial(apparentEclipticalPosition(t), earth.trueObliquity(t));
}

/** Approximation of {@link apparentPosition}, from the approximate chain. */
export function apparentPositionApprox(t: JulianDay): EquatorialCoords {
    return eclipticalToEquatorial(apparentEclipticalPositionApprox(t), earth.trueObliquityApprox(t));
}

/** Equatorial horizontal parallax (π), in degrees, per Meeus 40.1: 8.794" at 1 AU.
 *  Tiny compared to the Moon's, but applying it keeps sun/moon topocentric positions on the same footing. */
export function equatorialHorizontalParallax(t: JulianDay): number {
    return Math.asin(EQUATORIAL_RADIUS_KM / distance(t)) * RAD_TO_DEG;
}

/** Approximation of {@link equatorialHorizontalParallax}, from the approximate chain. */
export function equatorialHorizontalParallaxApprox(t: JulianDay): number {
    return Math.asin(EQUATORIAL_RADIUS_KM / distanceApprox(t)) * RAD_TO_DEG;
}

/** The Sun's topocentric equatorial position: apparentPosition corrected for an observer's parallax. See
 *  moon.ts's topocentricPosition for the same shape; the Sun's shift is only ~8.8" but nonzero. Feeds
 *  horizontalPosition below, so that comparing sun/moon horizontal positions (e.g. for eclipses) compares
 *  positions from the same observer-centered frame instead of mixing a geocentric Sun with a topocentric Moon. */
export function topocentricPosition(time: AstronomicalTime, observer: Observer): EquatorialCoords {
    const t = julianEphemerisDay(time);
    const s = apparentSiderealTime(time);

    return equatorialToTopocentric(apparentPosition(t), equatorialHorizontalParallax(t), s, observer);
}

/** Approximation of {@link topocentricPosition}, from the approximate chain. */
export function topocentricPositionApprox(time: AstronomicalTime, observer: Observer): EquatorialCoords {
    const t = julianEphemerisDay(time);
    const s = apparentSiderealTimeApprox(time);

    return equatorialToTopocentric(apparentPositionApprox(t), equatorialHorizontalParallaxApprox(t), s, observer);
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

/** Unit direction to the Sun in the observer's ENU frame (x east, y north, z up): a renderer's light direction. */
export function direction(time: AstronomicalTime, observer: Observer): Direction {
    return horizontalToDirection(horizontalPosition(time, observer));
}

/** Approximation of {@link direction}, from the approximate chain. */
export function directionApprox(time: AstronomicalTime, observer: Observer): Direction {
    return horizontalToDirection(horizontalPositionApprox(time, observer));
}

/** Distance from the center of the Sun to the center of the Earth, in kilometers, per Meeus 25.5. */
export function distance(t: JulianDay): number {
    const e = earth.orbitEccentricity(t);
    const R = (1.000001018 * (1.0 - e * e)) / (1.0 + e * Math.cos(trueAnomaly(t) * DEG_TO_RAD));

    return R * ASTRONOMICAL_UNIT_KM;
}

/** Approximation of {@link distance} per Jensen et al. 2001. */
export function distanceApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    const M = 6.24 + 628.302 * T;

    const R = 1.00014 - (0.016708 - 0.000042 * T) * Math.cos(M) - 0.000141 * Math.cos(2 * M);

    return R * ASTRONOMICAL_UNIT_KM;
}

/** The Sun's apparent angular diameter as seen from Earth's center, in degrees. */
export function apparentAngularDiameter(t: JulianDay): number {
    return 2 * Math.atan(MEAN_RADIUS_KM / distance(t)) * RAD_TO_DEG;
}

/** Approximation of {@link apparentAngularDiameter}, from the approximate chain. */
export function apparentAngularDiameterApprox(t: JulianDay): number {
    return 2 * Math.atan(MEAN_RADIUS_KM / distanceApprox(t)) * RAD_TO_DEG;
}
