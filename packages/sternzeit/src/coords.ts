// Terms used here are explained in the himmelszelt site's glossary (site/src/data/glossary.json).
import { DEG_TO_RAD, normalizeDegrees, RAD_TO_DEG } from "./math.js";

export interface EquatorialCoords {
    /** Right ascension (α), in degrees: angle east of the vernal equinox along the celestial equator. */
    rightAscension: number;
    /** Declination (δ), in degrees. Positive north of the celestial equator. */
    declination: number;
}

export interface EclipticalCoords {
    /** Ecliptical longitude (l), in degrees, measured from the vernal equinox along the ecliptic. */
    longitude: number;
    /** Ecliptical latitude (β), in degrees. Positive north of the ecliptic. */
    latitude: number;
}

export interface HorizontalCoords {
    /** Azimuth (A), in degrees, compass convention: measured clockwise from north through east, 0-360. */
    azimuth: number;
    /** Altitude (h), in degrees. Positive above, negative below the horizon. */
    altitude: number;
}

/** Ecliptical to equatorial coordinates, per Meeus 13.3, 13.4. */
export function eclipticalToEquatorial(ecl: EclipticalCoords, obliquity: number): EquatorialCoords {
    const e = obliquity * DEG_TO_RAD;
    const l = ecl.longitude * DEG_TO_RAD;
    const b = ecl.latitude * DEG_TO_RAD;

    const cose = Math.cos(e);
    const sine = Math.sin(e);
    const sinl = Math.sin(l);

    return {
        rightAscension: normalizeDegrees(Math.atan2(sinl * cose - Math.tan(b) * sine, Math.cos(l)) * RAD_TO_DEG),
        declination: Math.asin(Math.sin(b) * cose + Math.cos(b) * sine * sinl) * RAD_TO_DEG,
    };
}

/** Where on Earth the sky is seen from. */
export interface Observer {
    /** Geographic latitude, in degrees, positive north. */
    latitude: number;
    /** Geographic longitude, in degrees, positive east. */
    longitude: number;
    /** Height above sea level, in meters; 0 if left out. */
    heightM?: number;
}

/**
 * Equatorial to horizontal coordinates, per Meeus 13.5, 13.6. `siderealTime` is Greenwich's, in degrees: the apparent
 * one for an apparent position. `longitude` is positive east, the geographic convention, so the local sidereal time is
 * Greenwich's plus it. Meeus measures the azimuth westward from south; 180° is added to return the compass azimuth from
 * north through east instead, the one every renderer and map expects.
 */
export function equatorialToHorizontal(
    equ: EquatorialCoords,
    siderealTime: number,
    { latitude, longitude }: Observer,
): HorizontalCoords {
    // Local hour angle: H = θ - α (Meeus ch. 13).
    const H = (siderealTime + longitude - equ.rightAscension) * DEG_TO_RAD;
    const declination = equ.declination * DEG_TO_RAD;

    const cosH = Math.cos(H);
    const sinLat = Math.sin(latitude * DEG_TO_RAD);
    const cosLat = Math.cos(latitude * DEG_TO_RAD);

    return {
        altitude: Math.asin(sinLat * Math.sin(declination) + cosLat * Math.cos(declination) * cosH) * RAD_TO_DEG,
        azimuth: normalizeDegrees(
            Math.atan2(Math.sin(H), cosH * sinLat - Math.tan(declination) * cosLat) * RAD_TO_DEG + 180,
        ),
    };
}

/** Earth's equatorial radius (a) of the IAU 1976 ellipsoid, in kilometers, as in Meeus ch. 11. Parallaxes are
 *  defined against it, not against the mean radius. */
export const EQUATORIAL_RADIUS_KM = 6378.14;
/** Polar to equatorial axis ratio (b/a) of the same ellipsoid. */
const POLAR_AXIS_RATIO = 0.99664719;

/** The observer's geocentric position (ρ sin φ', ρ cos φ') in Earth equatorial radii, on the ellipsoid and
 *  `observerHeightM` above it, per Meeus ch. 11. */
export function observerGeocentric(latitude: number, observerHeightM = 0): { rhoSinPhi: number; rhoCosPhi: number } {
    const phi = latitude * DEG_TO_RAD;
    const u = Math.atan(POLAR_AXIS_RATIO * Math.tan(phi));
    const h = observerHeightM / (EQUATORIAL_RADIUS_KM * 1000);
    return {
        rhoSinPhi: POLAR_AXIS_RATIO * Math.sin(u) + h * Math.sin(phi),
        rhoCosPhi: Math.cos(u) + h * Math.cos(phi),
    };
}

/**
 * Geocentric to topocentric equatorial coordinates: a position corrected for the parallax `parallax` (the body's
 * equatorial horizontal parallax, in degrees) as seen from the observer's place on the ellipsoid and at their height, per
 * Meeus 40.2, 40.3. `siderealTime` is Greenwich's, in degrees, the hour angle as in equatorialToHorizontal. The Moon's
 * parallax, up to about a degree, always matters; the Sun's, about 8.8", is applied too, so eclipses compare like with like.
 */
export function equatorialToTopocentric(
    position: EquatorialCoords,
    parallax: number,
    siderealTime: number,
    { latitude, longitude, heightM = 0 }: Observer,
): EquatorialCoords {
    const H = (siderealTime + longitude - position.rightAscension) * DEG_TO_RAD;
    const { rhoSinPhi, rhoCosPhi } = observerGeocentric(latitude, heightM);
    const pi = parallax * DEG_TO_RAD;
    const delta = position.declination * DEG_TO_RAD;

    const sinPi = Math.sin(pi);
    const cosH = Math.cos(H);
    const cosDelta = Math.cos(delta);

    const deltaAlpha = Math.atan2(-rhoCosPhi * sinPi * Math.sin(H), cosDelta - rhoCosPhi * sinPi * cosH);
    const deltaPrime = Math.atan2(
        (Math.sin(delta) - rhoSinPhi * sinPi) * Math.cos(deltaAlpha),
        cosDelta - rhoCosPhi * sinPi * cosH,
    );

    return {
        rightAscension: normalizeDegrees(position.rightAscension + deltaAlpha * RAD_TO_DEG),
        declination: deltaPrime * RAD_TO_DEG,
    };
}

/**
 * A unit direction in the observer's local ENU frame: x east, y north, z up. Right-handed, the geodetic standard,
 * so it drops into right-handed renderer math as is; a y-up engine (three.js, glTF) takes it as `(x, z, -y)`.
 */
export type Direction = readonly [x: number, y: number, z: number];

/** Horizontal coordinates as a unit ENU direction vector, the form a renderer's lighting and view rays are in. */
export function horizontalToDirection({ azimuth, altitude }: HorizontalCoords): Direction {
    const a = altitude * DEG_TO_RAD;
    const z = azimuth * DEG_TO_RAD;

    return [Math.cos(a) * Math.sin(z), Math.cos(a) * Math.cos(z), Math.sin(a)];
}
