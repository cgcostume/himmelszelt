// biome-ignore-all assist/source/organizeImports: exports are hand-grouped by domain, as in index.ts
import * as earthImpl from "./earth.js";
import * as moonImpl from "./moon.js";
import * as sunImpl from "./sun.js";
import * as eclipseImpl from "./eclipse.js";
import { EQUATORIAL_RADIUS_KM } from "./coords.js";

// Math auxiliaries, same in both entry points (no precise/approx distinction applies to these).
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
    julianDay,
    julianDay0UT,
    julianDayUT,
    julianEphemerisDay,
    deltaT,
    fromDate,
    fromJulianDay,
    modifiedJulianDay,
    toDate,
    toUT,
    julianDaysSinceStandardEquinox,
    julianCenturiesSinceStandardEquinox,
} from "./time.js"; // Julian Day conversions

// Sidereal time.
export {
    meanSiderealTimeApprox as siderealTime,
    apparentSiderealTimeApprox as apparentSiderealTime,
} from "./siderealTime.js";

// Earth. Same shape as the precise `earth` namespace in `index.ts`, minus `viewDistanceWithinAtmosphere`'s
// refraction flag. MEAN_RADIUS_KM/ATMOSPHERE_THICKNESS_KM/ATMOSPHERE_THICKNESS_NON_UNIFORM_KM/
// APPARENT_MAGNITUDE_LIMIT/atmosphericRefraction have no approximate variant, same values either way.
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
    apparentAltitude: earthImpl.apparentAltitudeApprox,
    orbitEccentricity: earthImpl.orbitEccentricityApprox,
    longitudeNutation: earthImpl.longitudeNutationApprox,
    obliquityNutation: earthImpl.obliquityNutationApprox,
    meanObliquity: earthImpl.meanObliquityApprox,
    trueObliquity: earthImpl.trueObliquityApprox,
    viewDistanceWithinAtmosphere: earthImpl.viewDistanceWithinAtmosphereApprox,
    horizonDip: earthImpl.horizonDipApprox,
};

// Sun. Same shape as the precise `sun` namespace in `index.ts`.
export const sun = {
    MEAN_RADIUS_KM: sunImpl.MEAN_RADIUS_KM,
    meanAnomaly: sunImpl.meanAnomalyApprox,
    meanLongitude: sunImpl.meanLongitudeApprox,
    equationOfCenter: sunImpl.equationOfCenterApprox,
    trueAnomaly: sunImpl.trueAnomalyApprox,
    trueLongitude: sunImpl.trueLongitudeApprox,
    apparentLongitude: sunImpl.apparentLongitudeApprox,
    apparentPosition: sunImpl.apparentPositionApprox,
    equatorialHorizontalParallax: sunImpl.equatorialHorizontalParallaxApprox,
    topocentricPosition: sunImpl.topocentricPositionApprox,
    horizontalPosition: sunImpl.horizontalPositionApprox,
    direction: sunImpl.directionApprox,
    distance: sunImpl.distanceApprox,
    apparentAngularDiameter: sunImpl.apparentAngularDiameterApprox,
};

// Moon. Same shape as the precise `moon` namespace in `index.ts`.
export type { MoonLibration } from "./moon.js";
export const moon = {
    MEAN_RADIUS_KM: moonImpl.MEAN_RADIUS_KM,
    MEAN_SYNODIC_MONTH: moonImpl.MEAN_SYNODIC_MONTH,
    MEAN_NEW_MOON: moonImpl.MEAN_NEW_MOON,
    meanLongitude: moonImpl.meanLongitudeApprox,
    meanElongation: moonImpl.meanElongationApprox,
    meanAnomaly: moonImpl.meanAnomalyApprox,
    meanArgumentOfLatitude: moonImpl.meanArgumentOfLatitudeApprox,
    meanAscendingNodeLongitude: moonImpl.meanAscendingNodeLongitudeApprox,
    position: moonImpl.positionApprox,
    apparentPosition: moonImpl.apparentPositionApprox,
    equatorialHorizontalParallax: moonImpl.equatorialHorizontalParallaxApprox,
    topocentricPosition: moonImpl.topocentricPositionApprox,
    horizontalPosition: moonImpl.horizontalPositionApprox,
    direction: moonImpl.directionApprox,
    distance: moonImpl.distanceApprox,
    apparentAngularDiameter: moonImpl.apparentAngularDiameterApprox,
    topocentricAngularDiameter: moonImpl.topocentricAngularDiameterApprox,
    opticalLibrations: moonImpl.opticalLibrationsApprox,
    librations: moonImpl.librationsApprox,
    parallacticAngle: moonImpl.parallacticAngleApprox,
    brightLimbAngle: moonImpl.brightLimbAngleApprox,
    positionAngleOfAxis: moonImpl.positionAngleOfAxisApprox,
    phaseAngle: moonImpl.phaseAngleApprox,
    illuminatedFraction: moonImpl.illuminatedFractionApprox,
    sunDirection: moonImpl.sunDirectionApprox,
    earthshine: moonImpl.earthshineApprox,
};

// Eclipses. Same shape as the precise `eclipse` namespace in `index.ts`.
export type { SolarEclipseState, LunarEclipseState } from "./eclipse.js";
export const eclipse = {
    solar: eclipseImpl.solarEclipseStateApprox,
    lunar: eclipseImpl.lunarEclipseStateApprox,
};
