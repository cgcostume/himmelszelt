// Terms used here are explained in the himmelszelt site's glossary (site/src/data/glossary.json).
import observedDeltaT from "./data/deltat.json" with { type: "json" };
import { dayFraction, frac, polynomial, toInt } from "./math.js";

/** A calendar date/time used for astronomical calculations. */
export interface AstronomicalTime {
    year: number;
    /** 1-12 */
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    /** Offset from UTC, in seconds. */
    utcOffsetSeconds: number;
}

export type JulianDay = number;
/** Julian centuries since a reference epoch (commonly `T`), not a {@link JulianDay}. */
export type JulianCenturies = number;

/** The J2000.0 epoch, 2000 January 1, 12:00 TT, as a Julian Day. */
export const J2000: JulianDay = 2451545.0;
/** 2050 January 1, 12:00 TT, as a Julian Day. */
export const J2050: JulianDay = 2469807.5;
/** The B1900.0 epoch, 1900 January 0.8135 TT, as a Julian Day. */
export const B1900: JulianDay = 2415020.3135;
/** The B1950.0 epoch, 1950 January 0.9235 TT, as a Julian Day. */
export const B1950: JulianDay = 2433282.4235;

/** The epoch Julian centuries are counted from: J2000.0. */
export const STANDARD_EQUINOX: JulianDay = J2000;

/**
 * Julian Day for a given calendar date/time, as given, without applying `utcOffsetSeconds` (see {@link julianDayUT}),
 * per Meeus ch. 7. Dates from 1582-10-15 on are Gregorian, earlier ones Julian, as in
 * Meeus; the ten days the reform skipped return 0. Valid for years from -4712 on.
 */
export function julianDay(time: AstronomicalTime): JulianDay {
    let { year, month } = time;
    const { day, hour, minute, second } = time;

    if (month < 3) {
        // January/February are treated as month 13/14 of the preceding year.
        year -= 1;
        month += 12;
    }

    const h = dayFraction(hour, minute, second);

    let b = 0;
    const cutover = year * 10000 + month * 100 + day;
    if (cutover >= 15821015) {
        const a = toInt(year * 0.01);
        b = 2 - a + toInt(a * 0.25);
    } else if (cutover > 15821004) {
        return 0;
    }

    return toInt(365.25 * (year + 4716)) + toInt(30.600001 * (month + 1)) + day + h + b - 1524.5;
}

/** Julian Day of `time` converted to UT first. */
export function julianDayUT(time: AstronomicalTime): JulianDay {
    return julianDay(time.utcOffsetSeconds === 0 ? time : toUT(time));
}

/**
 * ΔT = TT - UT, in seconds, at a given Julian Day (UT): how far Earth's slowing, uneven rotation has fallen behind the
 * uniform time the ephemerides run on. About a minute today, hours in antiquity, and unpredictable in detail for the
 * future. Observed values from the IERS since 1962, before that the polynomials of Espenak & Meeus 2006, from the Five
 * Millennium Canon of Solar Eclipses (NASA TP-2006-214141), fitted to Morrison & Stephenson 2004. After the last
 * observation, its recent trend blends into their extrapolation over a century.
 * https://eclipse.gsfc.nasa.gov/SEhelp/deltatpoly2004.html
 */
export function deltaT(jd: JulianDay): number {
    const y = 2000 + (jd - J2000) / 365.25;
    // Observed on January 1 of each year, from the IERS; see scripts/deltat-from-iers.mjs.
    const observed = (k: number) => observedDeltaT.deltaT[k] as number;
    const i = y - observedDeltaT.firstYear;
    const last = observedDeltaT.deltaT.length - 1;
    if (i < 0) return polynomialDeltaT(y);
    if (i < last) {
        const k = Math.floor(i);
        return observed(k) + (i - k) * (observed(k + 1) - observed(k));
    }
    // The trend of the last five years, blended over a century into the polynomials' long-term extrapolation.
    const years = y - (observedDeltaT.firstYear + last);
    const trend = observed(last) + (years * (observed(last) - observed(last - 5))) / 5;
    const w = Math.min(years / 100, 1);
    return (1 - w) * trend + w * polynomialDeltaT(y);
}

// biome-ignore format: one branch to a line, as NASA lists them
/** Espenak & Meeus' ΔT at a decimal year, in seconds. */
function polynomialDeltaT(y: number): number {
    const long = (u: number) => -20 + 32 * u * u;

    if (y < -500) return long((y - 1820) / 100);
    if (y <  500) return polynomial(y / 100, 10583.6, -1014.41, 33.78311, -5.952053, -0.1798452, 0.022174192, 0.0090316521);
    if (y < 1600) return polynomial((y - 1000) / 100, 1574.2, -556.01, 71.23472, 0.319781, -0.8503463, -0.005050998, 0.0083572073);
    if (y < 1700) return polynomial(y - 1600, 120, -0.9808, -0.01532, 1 / 7129);
    if (y < 1800) return polynomial(y - 1700, 8.83, 0.1603, -0.0059285, 0.00013336, -1 / 1174000);
    if (y < 1860) return polynomial(y - 1800, 13.72, -0.332447, 0.0068612, 0.0041116, -0.00037436, 1.21272e-5, -1.699e-7, 8.75e-10);
    if (y < 1900) return polynomial(y - 1860, 7.62, 0.5737, -0.251754, 0.01680668, -0.0004473624, 1 / 233174);
    if (y < 1920) return polynomial(y - 1900, -2.79, 1.494119, -0.0598939, 0.0061966, -0.000197);
    if (y < 1941) return polynomial(y - 1920, 21.2, 0.84493, -0.0761, 0.0020936);
    if (y < 1961) return polynomial(y - 1950, 29.07, 0.407, -1 / 233, 1 / 2547);
    if (y < 1986) return polynomial(y - 1975, 45.45, 1.067, -1 / 260, -1 / 718);
    if (y < 2005) return polynomial(y - 2000, 63.86, 0.3345, -0.060374, 0.0017275, 0.000651814, 0.00002373599);
    if (y < 2050) return polynomial(y - 2000, 62.92, 0.32217, 0.005589);
    if (y < 2150) return long((y - 1820) / 100) - 0.5628 * (2150 - y);
    return long((y - 1820) / 100);
}

/**
 * Julian Ephemeris Day (JDE): the Julian Day in UT moved on by {@link deltaT}, the uniform time the orbits are computed
 * in. Takes a date and time, or a Julian Day in UT. Sidereal time keeps to UT, as it follows Earth's actual rotation.
 */
export function julianEphemerisDay(time: AstronomicalTime | JulianDay): JulianDay {
    const jd = typeof time === "number" ? time : julianDayUT(time);
    return jd + deltaT(jd) / 86_400;
}

/** Julian Day at 0h UT of the same calendar date as `time`. */
export function julianDay0UT(time: AstronomicalTime): JulianDay {
    return julianDayUT({ ...time, hour: 0, minute: 0, second: 0 });
}

/** Modified Julian Day (JD - 2400000.5) of `time` converted to UT first. */
export function modifiedJulianDay(time: AstronomicalTime): JulianDay {
    return julianDayUT(time) - 2_400_000.5;
}

/** Inverse of {@link julianDayUT}: the instant `jd` (UT) as a calendar date/time in the zone `utcOffsetSeconds`, to the
 *  millisecond. */
export function fromJulianDay(jd: JulianDay, utcOffsetSeconds = 0): AstronomicalTime {
    const shifted = jd + 0.5 + utcOffsetSeconds / 86_400;
    let z = toInt(shifted);
    // Rounded to whole milliseconds, so a round trip does not come back a hair short, e.g. at 11:59:59.999999.
    let ms = Math.round(frac(shifted) * 86_400_000);
    if (ms === 86_400_000) {
        z += 1;
        ms = 0;
    }

    let a = z;
    if (z >= 2299161) {
        // Gregorian calendar.
        const g = toInt((z - 1867216.25) / 36524.25);
        a = z + 1 + g - toInt(g / 4);
    }

    const b = toInt(a + 1524);
    const c = toInt((b - 122.1) / 365.25);
    const d = toInt(365.25 * c);
    const e = toInt((b - d) / 30.600001);

    const day = b - d - toInt(30.600001 * e);
    const month = e < 14 ? e - 1 : e - 13;
    const year = month > 2 ? c - 4716 : c - 4715;

    const hour = Math.floor(ms / 3_600_000);
    const minute = Math.floor((ms % 3_600_000) / 60_000);
    const second = (ms % 60_000) / 1000;

    return { year, month, day, hour, minute, second, utcOffsetSeconds };
}

/**
 * A JavaScript `Date` as an AstronomicalTime in the runtime's local time zone, offset included, milliseconds as
 * fractional seconds. The calendar fields follow the AstronomicalTime convention (Meeus ch. 7): the Julian calendar
 * before 1582 October 15, the Gregorian after, whereas a `Date` counts in the Gregorian calendar throughout. The offset
 * is taken to the second, as a local mean time had seconds, which `getTimezoneOffset` would round off.
 */
export function fromDate(date: Date): AstronomicalTime {
    // The local wall clock read as if it were UT, minus the instant, is the offset.
    const wall = new Date(0);
    // setUTCFullYear, unlike Date.UTC, doesn't map the years 0-99 to 1900-1999.
    wall.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
    wall.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
    const utcOffsetSeconds = Math.round((wall.getTime() - date.getTime()) / 1000);
    return fromJulianDay(julianDayFromDate(date), utcOffsetSeconds);
}

// The Julian Day of 1970-01-01T00:00Z, where a JavaScript Date counts its milliseconds from.
const UNIX_EPOCH_JD = 2440587.5;

/** The Julian Day (UT) of the instant a JavaScript Date stands for. */
export function julianDayFromDate(date: Date): JulianDay {
    return UNIX_EPOCH_JD + date.getTime() / 86_400_000;
}

/** The JavaScript Date of a Julian Day (UT), to the millisecond. */
export function dateFromJulianDay(jd: JulianDay): Date {
    return new Date(Math.round((jd - UNIX_EPOCH_JD) * 86_400_000));
}

/** Inverse of {@link fromDate}: the same instant as a JavaScript `Date`, its fields read as Meeus reads them. */
export function toDate(time: AstronomicalTime): Date {
    return dateFromJulianDay(julianDayUT(time));
}

/** `time` converted to UT (utcOffsetSeconds = 0). */
export function toUT(time: AstronomicalTime): AstronomicalTime {
    if (time.utcOffsetSeconds === 0) return time;
    return fromJulianDay(julianDay(time) - time.utcOffsetSeconds / 3600 / 24, 0);
}

/** Days since the standard equinox (J2000.0). */
export function julianDaysSinceStandardEquinox(jd: JulianDay): number {
    return jd - STANDARD_EQUINOX;
}

/** Julian centuries since the standard equinox (J2000.0). Commonly denoted `T`. */
export function julianCenturiesSinceStandardEquinox(jd: JulianDay): JulianCenturies {
    return julianDaysSinceStandardEquinox(jd) / 36_525;
}
