// Terms used here are explained in the himmelszelt site's glossary (site/src/data/glossary.json).
import nutationTable from "./data/nutation.json" with { type: "json" };
import { arcsecondsToDegrees, DEG_TO_RAD, flatTable, polynomial, RAD_TO_DEG } from "./math.js";
import * as moon from "./moon.js";
import * as sun from "./sun.js";
import { type JulianDay, julianCenturiesSinceStandardEquinox } from "./time.js";

/** Mean radius of the Earth, in kilometers. http://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html */
export const MEAN_RADIUS_KM = 6371.0;

/** Thickness of the atmosphere if its density were uniform, in kilometers. */
export const ATMOSPHERE_THICKNESS_KM = 7.994;

/** Actual thickness of the atmosphere, in kilometers. */
export const ATMOSPHERE_THICKNESS_NON_UNIFORM_KM = 85.0;

/** Faintest apparent magnitude generally visible to the naked eye. http://www.astronomynotes.com/starprop/s4.htm */
export const APPARENT_MAGNITUDE_LIMIT = 6.5;

/** Eccentricity of Earth's orbit around the Sun, dimensionless (0 for a circle), per Meeus 25.4. */
export function orbitEccentricity(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    return polynomial(T, 0.016708634, -0.000042037, -0.0000001267);
}

/** Constant regardless of `t` in this approximation, but with `orbitEccentricity`'s signature, so switching the import
 *  is the only change a caller makes. http://nssdc.gsfc.nasa.gov/planetary/factsheet/earthfact.html */
export function orbitEccentricityApprox(_t: JulianDay): number {
    return 0.01671022;
}

/** The 63 periodic terms of the IAU 1980 nutation (Meeus table 22.A), nine numbers each: the multiples of D, M, M', F
 *  and Ω in the argument, then the coefficients of sin (Δψ) and cos (Δε), in 0.0001", each with its T term. */
const NUTATION_TERMS = flatTable(nutationTable.terms);

// The last result: a position asks for both Δψ and Δε at the same instant, and the series is the costly part.
let nutationAt = Number.NaN;
let nutationCached = { longitude: 0, obliquity: 0 };

/** Nutation in longitude (Δψ) and in obliquity (Δε), in degrees, summed over {@link NUTATION_TERMS} with the
 *  arguments of Meeus ch. 22, which differ slightly from the Moon's own mean elements of ch. 47. */
function nutation(t: JulianDay): { longitude: number; obliquity: number } {
    if (t === nutationAt) return nutationCached;
    const T = julianCenturiesSinceStandardEquinox(t);
    const D = polynomial(T, 297.85036, 445267.11148, -0.0019142, 1 / 189474) * DEG_TO_RAD;
    const M = polynomial(T, 357.52772, 35999.05034, -0.0001603, -1 / 300000) * DEG_TO_RAD;
    const Mm = polynomial(T, 134.96298, 477198.867398, 0.0086972, 1 / 56250) * DEG_TO_RAD;
    const F = polynomial(T, 93.27191, 483202.017538, -0.0036825, 1 / 327270) * DEG_TO_RAD;
    const O = polynomial(T, 125.04452, -1934.136261, 0.0020708, 1 / 450000) * DEG_TO_RAD;

    const n = (i: number) => NUTATION_TERMS[i] as number;
    let psi = 0;
    let eps = 0;
    for (let i = 0; i < NUTATION_TERMS.length; i += 9) {
        const argument = n(i) * D + n(i + 1) * M + n(i + 2) * Mm + n(i + 3) * F + n(i + 4) * O;
        psi += (n(i + 5) + n(i + 6) * T) * Math.sin(argument);
        eps += (n(i + 7) + n(i + 8) * T) * Math.cos(argument);
    }

    nutationAt = t;
    nutationCached = { longitude: arcsecondsToDegrees(psi * 0.0001), obliquity: arcsecondsToDegrees(eps * 0.0001) };
    return nutationCached;
}

/** Nutation in longitude (Δψ), in degrees, per Meeus table 22.A. */
export function longitudeNutation(t: JulianDay): number {
    return nutation(t).longitude;
}

/** Approximate nutation in longitude (Δψ), in degrees, from its four largest terms, per Meeus ch. 22: within 0.5".
 *  L and L' are the Sun's and the Moon's mean longitudes. */
export function longitudeNutationApprox(t: JulianDay): number {
    const L = sun.meanLongitudeApprox(t) * DEG_TO_RAD;
    const Lm = moon.meanLongitudeApprox(t) * DEG_TO_RAD;
    const O = moon.meanAscendingNodeLongitudeApprox(t) * DEG_TO_RAD;

    return arcsecondsToDegrees(
        -17.2 * Math.sin(O) - 1.32 * Math.sin(2 * L) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * O),
    );
}

/** Nutation in obliquity (Δε), in degrees, per Meeus table 22.A. */
export function obliquityNutation(t: JulianDay): number {
    return nutation(t).obliquity;
}

/** Approximate nutation in obliquity (Δε), in degrees, from the same four terms: within 0.1". */
export function obliquityNutationApprox(t: JulianDay): number {
    const L = sun.meanLongitudeApprox(t) * DEG_TO_RAD;
    const Lm = moon.meanLongitudeApprox(t) * DEG_TO_RAD;
    const O = moon.meanAscendingNodeLongitudeApprox(t) * DEG_TO_RAD;

    return arcsecondsToDegrees(
        9.2 * Math.cos(O) + 0.57 * Math.cos(2 * L) + 0.1 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * O),
    );
}

/** True obliquity of the ecliptic (ε = ε0 + Δε), in degrees: the mean one plus the nutation in obliquity (ch. 22). */
export function trueObliquity(t: JulianDay): number {
    return meanObliquity(t) + obliquityNutation(t);
}

/** Approximation of {@link trueObliquity}, from the approximate chain. */
export function trueObliquityApprox(t: JulianDay): number {
    return meanObliquityApprox(t) + obliquityNutationApprox(t);
}

/** Inclination of Earth's axis of rotation, in degrees, per Meeus 22.3 from Laskar 1986. Valid for `|U| < 1`, i.e.
 *  within 10,000 years of J2000. */
export function meanObliquity(t: JulianDay): number {
    const U = julianCenturiesSinceStandardEquinox(t) * 0.01;

    const e0 = polynomial(U, 0, -4680.93, -1.55, 1999.25, -51.38, -249.67, -39.05, 7.12, 27.87, 5.79, 2.45);

    return arcsecondsToDegrees(23 * 3600 + 26 * 60 + 21.448) + arcsecondsToDegrees(e0);
}

/** Approximation of {@link meanObliquity} per Jensen et al. 2001. */
export function meanObliquityApprox(t: JulianDay): number {
    const T = julianCenturiesSinceStandardEquinox(t);
    return (0.409093 - 0.000227 * T) * RAD_TO_DEG;
}

/** Pressure scale height of the international standard atmosphere, in meters: R·T₀ / (M·g) at 288.15 K. */
export const PRESSURE_SCALE_HEIGHT_M = 8434.5;

/**
 * Air pressure at a given height above sea level, relative to the sea-level pressure (so 1 at h = 0), per the
 * barometric formula for the international standard atmosphere. This is what scales refraction with height:
 * thinner air bends light less, which is why a body's apparent position gets closer to its true one the
 * higher the observer is, and why refraction vanishes at the top of the atmosphere.
 */
export function airPressureRatio(observerHeightM: number): number {
    return Math.exp(-observerHeightM / PRESSURE_SCALE_HEIGHT_M);
}

/** Local conditions at the observer. Both default to the ones both refraction fits assume: sea level and 10 °C. */
export interface RefractionConditions {
    /** Observer height above sea level, in meters (not to be confused with `altitude`, a sky angle). */
    observerHeightM?: number;
    /** Local air temperature, in degrees Celsius. */
    temperatureC?: number;
}

/**
 * Effect of atmospheric refraction on the true altitude, in degrees, per Meeus 16.4 from Sæmundsson
 * 1986.
 *
 * The fit assumes an observer at sea level at 10 °C; `conditions` scales the result for anything else
 * (Meeus ch. 16, the P/1010 · 283/(273+T) factor, with the pressure ratio taken from `airPressureRatio`). Strictly,
 * refraction is the integral of the refractive index gradient along the whole ray, not a function of the
 * conditions at one end of it, but scaling by the observer's pressure is the standard approximation.
 *
 * Takes the *true* (geometric) altitude, i.e. Meeus 16.4. Use `atmosphericRefractionFromApparent` for the other
 * direction; the two fits differ by ~5' at the horizon and are not interchangeable.
 *
 * Note this is unrelated to the scattering coefficients a renderer uses: refraction comes from air's
 * refractive index, absorption and scattering from its cross-sections, and neither follows from the other.
 */
export function atmosphericRefraction(altitude: number, conditions: RefractionConditions = {}): number {
    // The constant zeroes R at the zenith, which the bare fit misses by ~0.0019'.
    const R = 1.02 / Math.tan((altitude + 10.3 / (altitude + 5.11)) * DEG_TO_RAD) + 0.0019279;

    return (R / 60) * refractionConditionFactor(conditions); // R is in arcminutes.
}

/**
 * Effect of atmospheric refraction, in degrees, as a function of the *apparent* altitude it produced, per
 * Meeus 16.3 from Bennett 1982. The inverse relation of `atmosphericRefraction`, and the one a renderer wants,
 * since a camera ray is by definition an apparent direction: subtracting this from the ray's apparent altitude
 * gives the true altitude to look the sky up at. `@himmelszelt/dunstkreis` carries a WGSL twin for per-ray use on
 * the GPU; the two are pinned to each other by a test and must stay in sync.
 *
 * ~34.5' at the horizon, slightly more than the Sun's own ~32' apparent diameter, which is why a Sun that
 * looks like it is touching the horizon has geometrically already set.
 *
 * Meeus' fit is stated for apparent altitudes of 0 and above, and diverges below (it has a pole at -4.4°), so
 * the input is clamped at 0. Rays below the horizontal therefore all get the horizon value; they are either
 * ground or, for an elevated observer, within ~1° of the horizon, where that is a good approximation anyway.
 */
export function atmosphericRefractionFromApparent(
    apparentAltitude: number,
    conditions: RefractionConditions = {},
): number {
    const h = Math.max(apparentAltitude, 0);

    // As in Meeus 16.4 above, the constant zeroes R at the zenith rather than leaving the fit's ~-0.0014' there.
    const R = 1 / Math.tan((h + 7.31 / (h + 4.4)) * DEG_TO_RAD) + 0.0013515216737563;

    return (R / 60) * refractionConditionFactor(conditions); // R is in arcminutes.
}

/** Meeus' `P/1010 · 283/(273+T)` scaling (ch. 16) shared by both fits, as a plain multiplier that is 1 by default. */
function refractionConditionFactor({ observerHeightM = 0, temperatureC = 10 }: RefractionConditions): number {
    return airPressureRatio(observerHeightM) * (283 / (273 + temperatureC));
}

export interface ViewDistanceOptions {
    /** Observer height above sea level, in meters. */
    observerHeightM?: number;
    /** Bend the ray by atmospheric refraction first, treating `y` as the true direction. Precise variant only. */
    refractionCorrected?: boolean;
}

/**
 * Distance traveled through the atmosphere, in kilometers, along a view direction whose vertical (up) component
 * is `y` (i.e. `y = sin(altitude)`), through the uniform-density shell of `ATMOSPHERE_THICKNESS_KM`: an air mass
 * in kilometers. A ray that hits the ground ends there, so looking down from sea level gives 0, while an elevated
 * observer's slightly downward ray still crosses some air before it reaches the ground.
 */
export function viewDistanceWithinAtmosphere(y: number, options: ViewDistanceOptions = {}): number {
    const { observerHeightM = 0, refractionCorrected = false } = options;
    let yy = y;
    if (refractionCorrected) {
        const altitude = Math.asin(Math.max(-1, Math.min(1, y))) * RAD_TO_DEG;
        yy = Math.sin((altitude + atmosphericRefraction(altitude, { observerHeightM })) * DEG_TO_RAD);
    }
    return rayThroughShell(yy, observerHeightM);
}

/** The same distance without refraction; it is exact and cheap, so the approximate variant needs no fit. */
export function viewDistanceWithinAtmosphereApprox(
    y: number,
    options: Omit<ViewDistanceOptions, "refractionCorrected"> = {},
): number {
    return rayThroughShell(y, options.observerHeightM ?? 0);
}

// Ray from radius `ro` with vertical component `y` against two concentric spheres: the ground (R) and the top of
// the shell (R + t). Distances along the ray solve |o + d·v|² = ρ², i.e. d = -ro·y ± sqrt(ro²y² - ro² + ρ²).
function rayThroughShell(y: number, observerHeightM: number): number {
    const R = MEAN_RADIUS_KM;
    const top = R + ATMOSPHERE_THICKNESS_KM;
    const ro = Math.min(R + Math.max(0, observerHeightM) / 1000, top);
    const b = ro * y;
    const toGround = b * b - ro * ro + R * R;
    // Downward and the ground in the way: the first (near) intersection with it.
    if (y < 0 && toGround >= 0) return Math.max(0, -b - Math.sqrt(toGround));
    return -b + Math.sqrt(b * b - ro * ro + top * top);
}

/**
 * Dip of the horizon, in degrees: how far below the true horizontal the visible horizon lies for an observer
 * `observerHeightM` meters above the ground, from the tangent to a spherical Earth, `acos(R / (R + h))`. Geometric
 * only: terrestrial refraction, which lifts the visible horizon by roughly a tenth of that, is left out.
 */
export function horizonDip(observerHeightM: number): number {
    const R = MEAN_RADIUS_KM * 1000;
    return Math.acos(R / (R + Math.max(observerHeightM, 0))) * RAD_TO_DEG;
}

// The refraction fit (Meeus 16.4) holds down to about a degree below the horizon and has a pole near -1.9°; lower, it
// is taken as constant.
const REFRACTION_FLOOR_DEG = -1;

/**
 * The altitude a body at `trueAltitude` (degrees) appears at above the observer's visible horizon, in degrees: lifted by
 * `atmosphericRefraction`, while the horizon itself lies `horizonDip` below the true horizontal for an observer above
 * sea level. At sea level, simply the refracted altitude. Rising and setting are where this crosses 0 for the body's
 * upper limb, which is how a renderer with a horizon lines them up to the second.
 */
export function apparentAltitude(trueAltitude: number, conditions: RefractionConditions = {}): number {
    const refraction = atmosphericRefraction(Math.max(trueAltitude, REFRACTION_FLOOR_DEG), conditions);
    return trueAltitude + refraction + horizonDip(conditions.observerHeightM ?? 0);
}

/** `apparentAltitude` with the small-angle `horizonDipApprox`. */
export function apparentAltitudeApprox(trueAltitude: number, conditions: RefractionConditions = {}): number {
    const refraction = atmosphericRefraction(Math.max(trueAltitude, REFRACTION_FLOOR_DEG), conditions);
    return trueAltitude + refraction + horizonDipApprox(conditions.observerHeightM ?? 0);
}

/** The small-angle form of `horizonDip`, `sqrt(2h / R)`: within 0.01% of it anywhere within the atmosphere. */
export function horizonDipApprox(observerHeightM: number): number {
    return Math.sqrt((2 * Math.max(observerHeightM, 0)) / (MEAN_RADIUS_KM * 1000)) * RAD_TO_DEG;
}
