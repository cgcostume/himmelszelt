import { expect, test } from "@playwright/test";
import * as approx from "../src/approx.js";
import { observerGeocentric } from "../src/coords.js";
import * as precise from "../src/index.js";

test("earth.meanObliquity matches the standard J2000.0 value (23°26'21.448\")", () => {
    expect(precise.earth.meanObliquity(precise.J2000)).toBeCloseTo(23 + 26 / 60 + 21.448 / 3600, 9);
});

// Meeus, "Astronomical Algorithms", example 22.a (1987-04-10.0 TD).
test("earth nutation matches Meeus' worked example 22.a", () => {
    const t = 2446895.5;
    expect(precise.earth.longitudeNutation(t) * 3600).toBeCloseTo(-3.788, 3);
    expect(precise.earth.obliquityNutation(t) * 3600).toBeCloseTo(9.443, 2);
});

test('approx nutation stays within Meeus\' stated 0.5" and 0.1" over a century', () => {
    for (let t = precise.J2000; t < precise.J2050 + 18262; t += 17.3) {
        expect(Math.abs(approx.earth.longitudeNutation(t) - precise.earth.longitudeNutation(t)) * 3600).toBeLessThan(
            0.5,
        );
        expect(Math.abs(approx.earth.obliquityNutation(t) - precise.earth.obliquityNutation(t)) * 3600).toBeLessThan(
            0.1,
        );
    }
});

test("approx namespaces have exactly the precise ones' names", () => {
    const pairs = [
        [precise.earth, approx.earth, []],
        [precise.sun, approx.sun, []],
        [precise.moon, approx.moon, []],
        [precise.eclipse, approx.eclipse, []],
    ] as const;
    for (const [p, a, preciseOnly] of pairs) {
        expect(Object.keys(p).filter((key) => !(key in a))).toEqual(preciseOnly);
        expect(Object.keys(a).filter((key) => !(key in p))).toEqual([]);
    }
});

test("earth.orbitEccentricityApprox is the constant from the approximate model", () => {
    expect(approx.earth.orbitEccentricity(precise.J2000)).toBeCloseTo(0.01671022, 8);
});

test("precise and approx earth/sun/moon namespaces expose the same call sites", () => {
    // Same date, different accuracy: switching the import should be the only thing that changes.
    const t = precise.J2000;

    expect(typeof precise.earth.orbitEccentricity(t)).toBe("number");
    expect(typeof approx.earth.orbitEccentricity(t)).toBe("number");
    expect(typeof precise.sun.apparentPosition(t).rightAscension).toBe("number");
    expect(typeof approx.sun.apparentPosition(t).rightAscension).toBe("number");
    expect(typeof precise.moon.apparentPosition(t).declination).toBe("number");
    expect(typeof approx.moon.apparentPosition(t).declination).toBe("number");
});

test("earth.atmosphericRefraction reproduces the textbook sea-level values", () => {
    // AA.15.4 (Saemundsson) takes the TRUE altitude and returns the lift to apparent, so the value at 0 is
    // ~29', not the ~34' quoted for an apparent altitude of 0 (AA.15.3, Bennett proper, which is the inverse
    // relation). The two are not interchangeable; anything warping an already-apparent view ray wants 15.3.
    expect(precise.earth.atmosphericRefraction(0) * 60).toBeCloseTo(28.98, 2);
    expect(precise.earth.atmosphericRefraction(90) * 60).toBeCloseTo(0.0, 6);
    // Monotonically decreasing with altitude, over the range Bennett's fit is meant for.
    for (let a = 0; a < 90; ++a) {
        expect(precise.earth.atmosphericRefraction(a + 1)).toBeLessThan(precise.earth.atmosphericRefraction(a));
    }
});

test("earth.atmosphericRefraction defaults leave Bennett's formula untouched", () => {
    // The conditions argument must be a pure multiplier, 1 at its own reference conditions.
    for (const a of [0, 1, 5, 15, 45, 90]) {
        expect(precise.earth.atmosphericRefraction(a, { observerHeightM: 0, temperatureC: 10 })).toBeCloseTo(
            precise.earth.atmosphericRefraction(a),
            12,
        );
    }
});

test("earth.airPressureRatio thins the air, and refraction with it, as the observer climbs", () => {
    expect(precise.earth.airPressureRatio(0)).toBe(1);
    expect(precise.earth.airPressureRatio(1000)).toBeCloseTo(0.888, 3);
    expect(precise.earth.airPressureRatio(10000)).toBeCloseTo(0.3056, 4);
    // At the top of the atmosphere there is effectively nothing left to bend the light.
    expect(precise.earth.airPressureRatio(precise.earth.ATMOSPHERE_THICKNESS_NON_UNIFORM_KM * 1000)).toBeLessThan(1e-4);

    // Horizon refraction at 1000 m: ~26', down from ~29' at sea level.
    expect(precise.earth.atmosphericRefraction(0, { observerHeightM: 1000 }) * 60).toBeCloseTo(25.74, 2);
    expect(precise.earth.atmosphericRefraction(0, { observerHeightM: 1000 })).toBeLessThan(
        precise.earth.atmosphericRefraction(0),
    );
});

test("earth.atmosphericRefraction increases in colder, denser air", () => {
    expect(precise.earth.atmosphericRefraction(0, { temperatureC: -20 })).toBeGreaterThan(
        precise.earth.atmosphericRefraction(0, { temperatureC: 30 }),
    );
});

test("earth.atmosphericRefractionFromApparent reproduces the textbook horizon value", () => {
    // AA.15.3, the apparent-altitude fit: ~34.5', which exceeds the Sun's own ~32' apparent diameter, so a Sun
    // that looks like it is touching the horizon has geometrically already set. Distinctly not 15.4's ~29'.
    expect(precise.earth.atmosphericRefractionFromApparent(0) * 60).toBeCloseTo(34.48, 2);
    expect(precise.earth.atmosphericRefractionFromApparent(90) * 60).toBeCloseTo(0.0, 6);
    expect(precise.earth.atmosphericRefractionFromApparent(0)).toBeGreaterThan(precise.earth.atmosphericRefraction(0));
});

test("earth's two refraction fits are inverses of each other", () => {
    // The pairing the renderer depends on: sternzeit lifts a true altitude to apparent, dunstkreis' WGSL twin
    // of the 15.3 fit takes an apparent view ray back to true. Round-tripping must land where it started.
    // The two are independent empirical fits, so they agree to a few arcseconds rather than exactly.
    for (const trueAltitude of [0, 0.5, 1, 2, 5, 10, 20, 45, 80, 90]) {
        const apparent = trueAltitude + precise.earth.atmosphericRefraction(trueAltitude);
        const back = apparent - precise.earth.atmosphericRefractionFromApparent(apparent);

        expect(Math.abs(back - trueAltitude) * 3600).toBeLessThan(5); // arcseconds
    }
});

test("earth.atmosphericRefractionFromApparent clamps below the horizon instead of diverging", () => {
    // The fit has a pole at -4.4°; rays pointing down must still return something finite and usable.
    for (const a of [-0.5, -1, -4.4, -10, -90]) {
        expect(precise.earth.atmosphericRefractionFromApparent(a)).toBe(
            precise.earth.atmosphericRefractionFromApparent(0),
        );
    }
});

test("both refraction fits take the same conditions scaling", () => {
    const conditions = { observerHeightM: 1000, temperatureC: -5 };
    const factor = precise.earth.atmosphericRefraction(10, conditions) / precise.earth.atmosphericRefraction(10);

    expect(
        precise.earth.atmosphericRefractionFromApparent(10, conditions) /
            precise.earth.atmosphericRefractionFromApparent(10),
    ).toBeCloseTo(factor, 12);
});

test("earth.viewDistanceWithinAtmosphere: the shell thickness straight up, sqrt(2Rt + t²) at the horizon", () => {
    const { MEAN_RADIUS_KM: R, ATMOSPHERE_THICKNESS_KM: t } = precise.earth;
    for (const ns of [precise, approx]) {
        expect(ns.earth.viewDistanceWithinAtmosphere(1)).toBeCloseTo(t, 6);
        expect(ns.earth.viewDistanceWithinAtmosphere(0)).toBeCloseTo(Math.sqrt(2 * R * t + t * t), 6);
    }
});

test("earth.viewDistanceWithinAtmosphere ends at the ground: 0 from sea level, some air from a mountain", () => {
    const at = (degrees: number) => Math.sin((degrees * Math.PI) / 180);
    for (const ns of [precise, approx]) {
        expect(ns.earth.viewDistanceWithinAtmosphere(at(-0.5))).toBe(0);
        // From 1000 m the horizon dips ~1°: a ray at -0.5° still clears the ground and leaves the shell further
        // out than a sea-level horizon ray, one at -2° meets the ground ~30 km away.
        const clearing = ns.earth.viewDistanceWithinAtmosphere(at(-0.5), { observerHeightM: 1000 });
        expect(clearing).toBeGreaterThan(ns.earth.viewDistanceWithinAtmosphere(0));
        const grounded = ns.earth.viewDistanceWithinAtmosphere(at(-2), { observerHeightM: 1000 });
        expect(grounded).toBeGreaterThan(20);
        expect(grounded).toBeLessThan(40);
    }
});

test("earth.viewDistanceWithinAtmosphere with refraction lifts a horizon ray, shortening its path", () => {
    expect(precise.earth.viewDistanceWithinAtmosphere(0, { refractionCorrected: true })).toBeLessThan(
        precise.earth.viewDistanceWithinAtmosphere(0),
    );
});

test("earth.horizonDip is zero at sea level and about a degree from a 1000 m mountain", () => {
    expect(precise.earth.horizonDip(0)).toBe(0);
    expect(precise.earth.horizonDip(1000)).toBeCloseTo(1.015, 2);
    expect(approx.earth.horizonDip(1000)).toBeCloseTo(precise.earth.horizonDip(1000), 3);
});

// Meeus, "Astronomical Algorithms", example 11.a: Palomar Observatory, 33°21'22" N, 1706 m.
test("earth.apparentAltitude lifts by refraction, lowers the horizon by its dip, and holds below a degree under it", () => {
    expect(precise.earth.apparentAltitude(30)).toBeCloseTo(30 + precise.earth.atmosphericRefraction(30), 12);
    const conditions = { observerHeightM: 1000 };
    const expected = 0 + precise.earth.atmosphericRefraction(0, conditions) + precise.earth.horizonDip(1000);
    expect(precise.earth.apparentAltitude(0, conditions)).toBeCloseTo(expected, 12);
    // Below -1° the fit's value there is kept, so the result keeps falling with the true altitude instead of diverging.
    const floor = precise.earth.atmosphericRefraction(-1);
    expect(precise.earth.apparentAltitude(-5)).toBeCloseTo(-5 + floor, 12);
    expect(approx.earth.apparentAltitude(0, conditions)).toBeCloseTo(precise.earth.apparentAltitude(0, conditions), 3);
});

test("observerGeocentric places an observer on the ellipsoid and above it", () => {
    const { rhoSinPhi, rhoCosPhi } = observerGeocentric(33 + 21 / 60 + 22 / 3600, 1706);
    expect(rhoSinPhi).toBeCloseTo(0.546861, 6);
    expect(rhoCosPhi).toBeCloseTo(0.836339, 6);
});

test("moon.topocentricPosition shifts with the observer's height", () => {
    const time = precise.fromJulianDay(2461265.0);
    const low = precise.moon.topocentricPosition(time, { latitude: 43, longitude: 0 });
    const high = precise.moon.topocentricPosition(time, { latitude: 43, longitude: 0, heightM: 1000 });
    const shift = Math.abs(high.declination - low.declination) + Math.abs(high.rightAscension - low.rightAscension);
    expect(shift * 3600).toBeGreaterThan(0.05);
    expect(shift * 3600).toBeLessThan(2);
});

// Meeus, example 40.a: Mars from Palomar Observatory, 2003-08-28 3h17m UT.
test("equatorialToTopocentric matches Meeus' worked example 40.a", () => {
    const geocentric = { rightAscension: 339.530208, declination: -15.771083 };
    const siderealTime = 15 * (1 + 40 / 60 + 45 / 3600);
    const observer = {
        latitude: 33 + 21 / 60 + 22 / 3600,
        longitude: -(15 * (7 + 47 / 60 + 27 / 3600)),
        heightM: 1706,
    };
    const topocentric = precise.equatorialToTopocentric(geocentric, 23.592 / 3600, siderealTime, observer);
    expect(topocentric.rightAscension).toBeCloseTo(15 * (22 + 38 / 60 + 8.54 / 3600), 4);
    expect(topocentric.declination).toBeCloseTo(-(15 + 46 / 60 + 30.0 / 3600), 4);
});
