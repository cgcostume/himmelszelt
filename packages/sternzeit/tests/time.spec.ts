import { expect, test } from "@playwright/test";
import { apparentSiderealTime, meanSiderealTime } from "../src/siderealTime.js";
import {
    type AstronomicalTime,
    dateFromJulianDay,
    deltaT,
    fromDate,
    fromJulianDay,
    J2000,
    julianDay,
    julianDayFromDate,
    julianDayUT,
    julianEphemerisDay,
    modifiedJulianDay,
    toDate,
} from "../src/time.js";

function utc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): AstronomicalTime {
    return { year, month, day, hour, minute, second, utcOffsetSeconds: 0 };
}

test("julianDay matches the J2000.0 epoch", () => {
    expect(julianDay(utc(2000, 1, 1, 12))).toBeCloseTo(J2000, 6);
});

test("julianDay matches a known reference date (1999-01-01 0h UT)", () => {
    expect(julianDay(utc(1999, 1, 1))).toBeCloseTo(2451179.5, 6);
});

test("julianDay matches Meeus' worked example (1957-10-04.81)", () => {
    // Meeus, "Astronomical Algorithms", example 7.a (Sputnik 1 launch).
    expect(julianDay(utc(1957, 10, 4, 19, 26, 24))).toBeCloseTo(2436116.31, 2);
});

test("fromJulianDay is the inverse of julianDay", () => {
    const time = utc(2000, 1, 1, 12);
    expect(fromJulianDay(julianDay(time))).toEqual(time);
});

test("fromDate keeps the instant, whatever the runtime's time zone", () => {
    const date = new Date("2026-09-21T20:00:00+02:00");
    expect(julianDayUT(fromDate(date))).toBeCloseTo(2461305.25, 8);
    expect(toDate(fromDate(date)).getTime()).toBe(date.getTime());
});

test("meanSiderealTime matches Meeus' worked examples (12.a/12.b)", () => {
    expect(meanSiderealTime(utc(1987, 4, 10))).toBeCloseTo(197.693195, 2);
    expect(meanSiderealTime(utc(1987, 4, 10, 19, 21, 0))).toBeCloseTo(128.7378734, 2);
});

const year = (y: number) => J2000 + (y - 2000) * 365.25;

// The IERS values since 1962, and Espenak & Meeus' polynomials around them, meeting without a jump.
test("deltaT follows the observations and the NASA polynomials", () => {
    expect(deltaT(year(2000))).toBeCloseTo(63.83, 2);
    expect(deltaT(year(2020))).toBeCloseTo(69.36, 2);
    expect(deltaT(year(2020.5))).toBeCloseTo(69.36, 2);
    expect(deltaT(year(-500))).toBeCloseTo(17203.7, -1);
    expect(Math.abs(deltaT(year(1962)) - deltaT(year(1962 - 1e-9)))).toBeLessThan(0.02);
});

// On 2026-08-26 the IERS had 69.18 s.
test("deltaT continues from the last observation and blends into the NASA extrapolation", () => {
    const last = 2026;
    expect(Math.abs(deltaT(year(last)) - deltaT(year(last - 1e-9)))).toBeLessThan(1e-6);
    expect(deltaT(year(2026.65))).toBeCloseTo(69.18, 0);
    const u = (2200 - 1820) / 100;
    expect(deltaT(year(2200))).toBeCloseTo(-20 + 32 * u * u, 6);
});

test("julianEphemerisDay runs ahead of UT by deltaT", () => {
    const time = { year: 2026, month: 8, day: 12, hour: 18, minute: 0, second: 0, utcOffsetSeconds: 0 };
    const seconds = (julianEphemerisDay(time) - julianDayUT(time)) * 86400;
    expect(seconds).toBeCloseTo(deltaT(julianDayUT(time)), 3);
});

// Meeus, "Astronomical Algorithms", example 7.b: before the reform, the Julian calendar.
test("julianDay counts dates before 1582 in the Julian calendar", () => {
    expect(julianDay(utc(333, 1, 27, 12))).toBe(1842713);
});

test("fromJulianDay shifts the clock into the requested time zone", () => {
    const time = fromJulianDay(J2000, 7200);
    expect(time).toEqual({ year: 2000, month: 1, day: 1, hour: 14, minute: 0, second: 0, utcOffsetSeconds: 7200 });
    expect(julianDayUT(time)).toBeCloseTo(J2000, 8);
});

test("fromJulianDay keeps fractional seconds, to the millisecond", () => {
    const time = { ...utc(2026, 9, 21, 12, 0, 30.75), utcOffsetSeconds: 3600 };
    expect(fromJulianDay(julianDayUT(time), 3600)).toEqual(time);
    expect(fromJulianDay(J2000 - 0.0000001)).toEqual(utc(2000, 1, 1, 11, 59, 59.991));
});

test("modifiedJulianDay applies the time zone offset", () => {
    const berlin = { ...utc(2000, 1, 1, 14), utcOffsetSeconds: 7200 };
    expect(modifiedJulianDay(berlin)).toBeCloseTo(51544.5, 8);
});

// Meeus, example 12.a: 13h10m46.1351s, the mean sidereal time plus Δψ cos ε = -0.2317s.
test("apparentSiderealTime matches Meeus' worked example 12.a", () => {
    expect(apparentSiderealTime(utc(1987, 4, 10))).toBeCloseTo((13 + 10 / 60 + 46.1351 / 3600) * 15, 5);
});

test("julianEphemerisDay takes a Julian Day in UT as well as a date", () => {
    const time = utc(2026, 8, 12, 18);
    expect(julianEphemerisDay(julianDayUT(time))).toBe(julianEphemerisDay(time));
});

test("julianDayFromDate and dateFromJulianDay convert an instant both ways, to the millisecond", () => {
    expect(julianDayFromDate(new Date("2000-01-01T12:00:00Z"))).toBe(J2000);
    const date = new Date("2026-09-21T20:00:00.123+02:00");
    expect(julianDayFromDate(date)).toBeCloseTo(julianDayUT(fromDate(date)), 8);
    expect(dateFromJulianDay(julianDayFromDate(date)).getTime()).toBe(date.getTime());
});

// A Date counts in the Gregorian calendar throughout; an AstronomicalTime, as Meeus does, in the Julian before 1582.
test("fromDate and toDate keep the instant across the calendar reform and in local mean time", () => {
    for (const iso of [
        "1000-01-01T00:00:00Z",
        "1582-10-10T06:30:00Z",
        "1850-06-01T12:00:00.250Z",
        "-000584-05-22T12:00:00Z",
    ]) {
        const date = new Date(iso);
        expect(julianDayUT(fromDate(date))).toBeCloseTo(julianDayFromDate(date), 8);
        expect(toDate(fromDate(date)).getTime()).toBe(date.getTime());
    }
    // 1582 October 4 (Julian), the last day before the reform, was October 14 in the proleptic Gregorian calendar.
    const lastJulian = toDate({ year: 1582, month: 10, day: 4, hour: 12, minute: 0, second: 0, utcOffsetSeconds: 0 });
    expect(lastJulian.toISOString()).toBe("1582-10-14T12:00:00.000Z");
});
