import * as precise from "@himmelszelt/sternzeit";
import { ephemerisDay, state } from "./state";

const timeOf = (jd: number) => precise.fromJulianDay(jd);

// An eclipse needs a new moon (solar) or a full one (lunar), so the search steps from one to the next rather than
// through the days between them (moon.MEAN_SYNODIC_MONTH and moon.MEAN_NEW_MOON); the true phase wanders up to
// about half a day either side of the mean one, which the day around each candidate covers.
export const SEARCH_YEARS = 20;
const CANDIDATE_WINDOW = 1;
// The grids a candidate is walked on: three hours to rule it out, ten minutes to find the closest approach, one
// minute to pin it down.
const RULE_OUT_STEP = 1 / 8;
const COARSE_STEP = 1 / 144;
const FINE_STEP = 1 / 1440;
// Geocentric separation under which the Moon may cover the Sun somewhere on Earth: the two discs are about half a
// degree wide, and parallax moves the Moon by up to another degree.
export const SOLAR_REACH_DEG = 2.5;
// An eclipse this close to the moment shown is the one already on screen, its deepest moment found on the minute grid
// a little off the greatest eclipse jumped to, and not the next one.
const SAME_ECLIPSE = 1 / 24;

/** How far the Moon is from what would eclipse it, as seen from Earth's center. */
function geocentricDistance(jd: number, lunar: boolean) {
    if (lunar) return precise.eclipse.lunar(ephemerisDay(jd)).axisOffsetKm;
    const [m, s] = [precise.moon.apparentPosition(ephemerisDay(jd)), precise.sun.apparentPosition(ephemerisDay(jd))];
    return precise.angularSeparation(m.rightAscension, m.declination, s.rightAscension, s.declination);
}

/** Whether `jd` is close enough to be worth walking minute by minute. */
function mayEclipse(jd: number, lunar: boolean) {
    if (!lunar) return geocentricDistance(jd, false) < SOLAR_REACH_DEG;
    const shadow = precise.eclipse.lunar(ephemerisDay(jd));
    return shadow.axisOffsetKm < 2 * shadow.penumbraRadiusKm;
}

/**
 * How far the Moon is from the Sun in this place's own sky, or null while the Sun is down: an eclipse no one here
 * can see is not one to jump to, and skipping the night is what makes the search quick.
 */
function separationHere(jd: number) {
    const time = timeOf(jd);
    const s = precise.sun.horizontalPosition(time, state);
    if (s.altitude <= 0) return null;
    const m = precise.moon.horizontalPosition(time, state);
    return precise.angularSeparation(s.azimuth, s.altitude, m.azimuth, m.altitude);
}

/** The deepest moment within `window` of `middle`, walked coarsely and then refined, or null if there is none. */
function deepest(middle: number, lunar: boolean) {
    const distance = lunar
        ? (jd: number): number | null => precise.eclipse.lunar(ephemerisDay(jd)).axisOffsetKm
        : separationHere;
    let best: { jd: number; value: number } | null = null;
    for (let jd = middle - CANDIDATE_WINDOW; jd <= middle + CANDIDATE_WINDOW; jd += COARSE_STEP) {
        const value = distance(jd);
        if (value !== null && (!best || value < best.value)) best = { jd, value };
    }
    if (!best) return null;
    for (let jd = best.jd - COARSE_STEP; jd <= best.jd + COARSE_STEP; jd += FINE_STEP) {
        const value = distance(jd);
        if (value !== null && value < best.value) best = { jd, value };
    }
    if (lunar) {
        const shadow = precise.eclipse.lunar(ephemerisDay(best.jd));
        return shadow.axisOffsetKm - precise.moon.MEAN_RADIUS_KM < shadow.umbraRadiusKm ? best.jd : null;
    }
    return precise.eclipse.solar(timeOf(best.jd), state).phase < 1 ? best.jd : null;
}

/**
 * The nearest eclipse before or after `from`, searched rather than looked up: one candidate per lunation, ruled out
 * in a few calls unless the two bodies really do come close. Penumbral lunar eclipses are left out, there is nothing
 * to see in them, and solar ones are answered for the chosen place, which is why they are rarer than the almanac's.
 */
export function nearestEclipse(from: number, direction: number, lunar: boolean) {
    const { MEAN_NEW_MOON, MEAN_SYNODIC_MONTH } = precise.moon;
    const offset = lunar ? 0.5 : 0;
    const k0 = (from - MEAN_NEW_MOON) / MEAN_SYNODIC_MONTH - offset;
    const months = Math.round((SEARCH_YEARS * 365.25) / MEAN_SYNODIC_MONTH);
    for (let i = 0; i <= months; i++) {
        const k = direction > 0 ? Math.floor(k0) + i : Math.ceil(k0) - i;
        const middle = MEAN_NEW_MOON + (k + offset) * MEAN_SYNODIC_MONTH;
        let near = false;
        for (let jd = middle - CANDIDATE_WINDOW; jd <= middle + CANDIDATE_WINDOW && !near; jd += RULE_OUT_STEP) {
            near = mayEclipse(jd, lunar);
        }
        if (!near) continue;
        const found = deepest(middle, lunar);
        if (found !== null && (found - from) * direction > SAME_ECLIPSE) return found;
    }
    return null;
}
