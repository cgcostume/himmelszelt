// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, not alphabetical
import * as earthImpl from "./earth.js";
import * as moonImpl from "./moon.js";
import * as sunImpl from "./sun.js";
import * as eclipseImpl from "./eclipse.js";
import { EQUATORIAL_RADIUS_KM } from "./coords.js";

// Math auxiliaries, generic enough to be useful to any consumer, not just internally.
export {
    angularSeparation,
    ASTRONOMICAL_UNIT_KM,
    DEG_TO_RAD,
    normalizeDegrees,
    positionAngle,
    RAD_TO_DEG,
} from "./math.js";

// Coordinate systems.
export type { Direction, EclipticalCoords, EquatorialCoords, HorizontalCoords, Observer } from "./coords.js";
export type { RefractionConditions, ViewDistanceOptions } from "./earth.js";
export { eclipticalToEquatorial, equatorialToHorizontal, horizontalToDirection } from "./coords.js";

// Time and Julian Day.
export type { AstronomicalTime, JulianDay } from "./time.js";
export { J2000, J2050, B1900, B1950, STANDARD_EQUINOX } from "./time.js"; // reference epochs
export {
    dateFromJulianDay,
    fromDate,
    fromJulianDay,
    julianDay,
    julianDay0UT,
    julianDayFromDate,
    julianDayUT,
    julianEphemerisDay,
    deltaT,
    julianDaysSinceStandardEquinox,
    julianCenturiesSinceStandardEquinox,
    modifiedJulianDay,
    toDate,
    toUT,
} from "./time.js"; // Julian Day conversions

// Sidereal time.
export { meanSiderealTime as siderealTime, apparentSiderealTime } from "./siderealTime.js";

// Earth.
export const earth = {
    MEAN_RADIUS_KM: earthImpl.MEAN_RADIUS_KM,
    EQUATORIAL_RADIUS_KM,
    ATMOSPHERE_THICKNESS_KM: earthImpl.ATMOSPHERE_THICKNESS_KM,
    ATMOSPHERE_THICKNESS_NON_UNIFORM_KM: earthImpl.ATMOSPHERE_THICKNESS_NON_UNIFORM_KM,
    APPARENT_MAGNITUDE_LIMIT: earthImpl.APPARENT_MAGNITUDE_LIMIT,
    PRESSURE_SCALE_HEIGHT_M: earthImpl.PRESSURE_SCALE_HEIGHT_M,
    airPressureRatio: earthImpl.airPressureRatio,
    atmosphericRefraction: earthImpl.atmosphericRefraction,
    atmosphericRefractionFromApparent: earthImpl.atmosphericRefractionFromApparent,
    apparentAltitude: earthImpl.apparentAltitude,
    orbitEccentricity: earthImpl.orbitEccentricity,
    longitudeNutation: earthImpl.longitudeNutation,
    obliquityNutation: earthImpl.obliquityNutation,
    meanObliquity: earthImpl.meanObliquity,
    trueObliquity: earthImpl.trueObliquity,
    viewDistanceWithinAtmosphere: earthImpl.viewDistanceWithinAtmosphere,
    horizonDip: earthImpl.horizonDip,
};

// Sun.
export const sun = {
    MEAN_RADIUS_KM: sunImpl.MEAN_RADIUS_KM,
    meanAnomaly: sunImpl.meanAnomaly,
    meanLongitude: sunImpl.meanLongitude,
    equationOfCenter: sunImpl.equationOfCenter,
    trueAnomaly: sunImpl.trueAnomaly,
    trueLongitude: sunImpl.trueLongitude,
    apparentLongitude: sunImpl.apparentLongitude,
    apparentPosition: sunImpl.apparentPosition,
    equatorialHorizontalParallax: sunImpl.equatorialHorizontalParallax,
    topocentricPosition: sunImpl.topocentricPosition,
    horizontalPosition: sunImpl.horizontalPosition,
    direction: sunImpl.direction,
    distance: sunImpl.distance,
    apparentAngularDiameter: sunImpl.apparentAngularDiameter,
};

// Moon.
export type { MoonLibration } from "./moon.js";
export const moon = {
    MEAN_RADIUS_KM: moonImpl.MEAN_RADIUS_KM,
    MEAN_SYNODIC_MONTH: moonImpl.MEAN_SYNODIC_MONTH,
    MEAN_NEW_MOON: moonImpl.MEAN_NEW_MOON,
    meanLongitude: moonImpl.meanLongitude,
    meanElongation: moonImpl.meanElongation,
    meanAnomaly: moonImpl.meanAnomaly,
    meanArgumentOfLatitude: moonImpl.meanArgumentOfLatitude,
    meanAscendingNodeLongitude: moonImpl.meanAscendingNodeLongitude,
    position: moonImpl.position,
    apparentPosition: moonImpl.apparentPosition,
    equatorialHorizontalParallax: moonImpl.equatorialHorizontalParallax,
    topocentricPosition: moonImpl.topocentricPosition,
    horizontalPosition: moonImpl.horizontalPosition,
    direction: moonImpl.direction,
    distance: moonImpl.distance,
    apparentAngularDiameter: moonImpl.apparentAngularDiameter,
    topocentricAngularDiameter: moonImpl.topocentricAngularDiameter,
    opticalLibrations: moonImpl.opticalLibrations,
    librations: moonImpl.librations,
    parallacticAngle: moonImpl.parallacticAngle,
    brightLimbAngle: moonImpl.brightLimbAngle,
    positionAngleOfAxis: moonImpl.positionAngleOfAxis,
    phaseAngle: moonImpl.phaseAngle,
    illuminatedFraction: moonImpl.illuminatedFraction,
    sunDirection: moonImpl.sunDirection,
    earthshine: moonImpl.earthshine,
};

// Eclipses.
export type { SolarEclipseState, LunarEclipseState } from "./eclipse.js";
export const eclipse = {
    solar: eclipseImpl.solarEclipseState,
    lunar: eclipseImpl.lunarEclipseState,
};
