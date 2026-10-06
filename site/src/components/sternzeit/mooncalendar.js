import * as precise from "@himmelszelt/sternzeit";
import { moonSymbol, sunInViewFrame } from "./figure.js";
import { onChange, state, update } from "./state.js";
import { clock, clockOffsetMs } from "./zone.js";

const DAY_MS = 86_400_000;
// Ten-minute steps: rise and set are then found to the minute by bisection, and the lanes are smooth enough.
const SAMPLES_PER_DAY = 144;
// The upper limb on the horizon, refraction included: the almanacs' -0.833 degrees, for the Moon about right too.
const RISE_ALTITUDE = -0.833;
// The end of civil twilight: below it, the Sun lane is night.
const TWILIGHT_ALTITUDE = -6;
// Above this the Moon has left the yellow of the long path through the air behind.
const MOON_WHITE_ALTITUDE = 10;
// Color steps along the lanes: few enough to merge into a handful of runs per day, enough to read as a gradient.
const LEVELS = 4;
const LANE_HEIGHT = 3;
const LANE_GAP = 1;
const LANES_HEIGHT = 2 * LANE_HEIGHT + LANE_GAP;
const DISC_RADIUS = 14;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Sixteen compass points, 22.5 degrees apart: about as fine as a whole-degree altitude beside it.
const COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const figure = document.querySelector(".moon-calendar");
const weeksEl = figure.querySelector('[data-field="weeks"]');
const titleEl = figure.querySelector('[data-field="title"]');
const monthButtons = [...figure.querySelectorAll("[data-month]")];

const f = (n) => n.toFixed(2);
const timeOf = (ms) => precise.fromDate(new Date(ms));
const moonAltitude = (ms) => precise.moon.horizontalPosition(timeOf(ms), state).altitude;
const sunAltitude = (ms) => precise.sun.horizontalPosition(timeOf(ms), state).altitude;
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const level = (t) => Math.round(clamp01(t) * LEVELS) / LEVELS;

// A calendar day on the page's clock, as whole days since 1970, and the instant its clock reads `wallMs`, which is UT
// shifted by the clock's offset; the offset is taken twice, so a day that switches to or from daylight saving time
// lands right.
const wallDayOf = (ms) => Math.floor((ms + clockOffsetMs(new Date(ms))) / DAY_MS);
function instantOf(wallMs) {
    const guess = wallMs - clockOffsetMs(new Date(wallMs));
    return wallMs - clockOffsetMs(new Date(guess));
}

const pageMs = () => precise.toDate(precise.fromJulianDay(state.jd)).getTime();
// The month shown, as year and month on the page's clock; it starts at the page's moment and then keeps to itself.
let shown = (() => {
    const date = new Date(wallDayOf(pageMs()) * DAY_MS);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
})();

/** The days the grid shows: whole weeks from Monday, around the shown month. */
function gridDays() {
    const first = Date.UTC(shown.year, shown.month, 1) / DAY_MS;
    const count = new Date(Date.UTC(shown.year, shown.month + 1, 0)).getUTCDate();
    const weekday = (new Date(first * DAY_MS).getUTCDay() + 6) % 7;
    const weeks = Math.ceil((weekday + count) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => first - weekday + i);
}

/** Narrows down where `altitude` crosses `threshold` between two instants, to well under a minute. */
function crossing(altitude, threshold, a, b) {
    const aboveAtA = altitude(a) > threshold;
    for (let i = 0; i < 8; i++) {
        const m = (a + b) / 2;
        if (altitude(m) > threshold === aboveAtA) a = m;
        else b = m;
    }
    return (a + b) / 2;
}

/** Narrows down the Moon's highest point between two instants around it. */
function culmination(a, b) {
    for (let i = 0; i < 12; i++) {
        const [m1, m2] = [a + (b - a) / 3, b - (b - a) / 3];
        if (moonAltitude(m1) < moonAltitude(m2)) a = m1;
        else b = m2;
    }
    return (a + b) / 2;
}

/**
 * One day's lanes and events: the color level of each sample for the Moon and the Sun, and when the Moon rises, sets and
 * stands highest. Independent of the time of day the discs are drawn at, so it is kept until the month, the place or
 * the clock changes.
 */
function dayLanes(wallDay) {
    const start = instantOf(wallDay * DAY_MS);
    const step = (instantOf((wallDay + 1) * DAY_MS) - start) / SAMPLES_PER_DAY;
    const times = Array.from({ length: SAMPLES_PER_DAY + 1 }, (_, i) => start + i * step);
    const moon = times.map(moonAltitude);
    const sun = times.map(sunAltitude);
    const events = { rise: null, set: null, transit: null, transitAltitude: null };
    let highest = 0;
    for (let i = 1; i <= SAMPLES_PER_DAY; i++) {
        const [before, now] = [moon[i - 1] > RISE_ALTITUDE, moon[i] > RISE_ALTITUDE];
        if (!before && now) events.rise = crossing(moonAltitude, RISE_ALTITUDE, times[i - 1], times[i]);
        if (before && !now) events.set = crossing(moonAltitude, RISE_ALTITUDE, times[i - 1], times[i]);
        if (moon[i] > moon[highest]) highest = i;
    }
    // A maximum inside the day, not at its edge, is a culmination; above the horizon or not, it is the transit.
    if (highest > 0 && highest < SAMPLES_PER_DAY) {
        events.transit = culmination(times[highest - 1], times[highest + 1]);
        events.transitAltitude = moonAltitude(events.transit);
    }
    const moonLevels = moon
        .slice(0, -1)
        .map((h) => (h > RISE_ALTITUDE ? level((h - RISE_ALTITUDE) / (MOON_WHITE_ALTITUDE - RISE_ALTITUDE)) : -1));
    const sunLevels = sun
        .slice(0, -1)
        .map((h) =>
            h > RISE_ALTITUDE
                ? 1
                : h > TWILIGHT_ALTITUDE
                  ? level((h - TWILIGHT_ALTITUDE) / (RISE_ALTITUDE - TWILIGHT_ALTITUDE))
                  : -1,
        );
    return { start, end: start + step * SAMPLES_PER_DAY, events, moonLevels, sunLevels };
}

// Runs of equal level as rects, one sample one unit wide, x from the start of the day; -1 is below the horizon.
function laneRuns(levels, y, cls, x0) {
    let svg = "";
    let from = 0;
    for (let i = 1; i <= levels.length; i++) {
        if (i < levels.length && levels[i] === levels[from]) continue;
        const value = levels[from];
        const style = value < 0 ? "" : ` style="--level: ${value * 100}%"`;
        const kind = value < 0 ? "calendar-lane-below" : cls;
        svg += `<rect x="${x0 + from}" y="${y}" width="${i - from}" height="${LANE_HEIGHT}" class="${kind}"${style}/>`;
        from = i;
    }
    return svg;
}

/** The Moon at `ms` as the symbol in a day's cell: phase, earthshine, libration and tilt as seen from the place. */
function disc(ms) {
    const time = timeOf(ms);
    const jde = precise.julianEphemerisDay(time);
    const lit = precise.moon.illuminatedFraction(jde);
    const earthshine = precise.moon.earthshine(jde);
    const toSun = sunInViewFrame(time, state);
    const libration = precise.moon.librations(jde);
    const tilt = precise.moon.positionAngleOfAxis(jde) - precise.moon.parallacticAngle(time, state);
    const { altitude, azimuth } = precise.moon.horizontalPosition(time, state);
    const graticule = { ...libration, tilt };
    const symbol = moonSymbol(0, 0, DISC_RADIUS, lit, toSun.right, -toSun.up, earthshine, graticule);
    const below = altitude <= RISE_ALTITUDE;
    const svg = below
        ? `<g class="calendar-moon-below">${symbol}</g><circle r="${DISC_RADIUS}" class="calendar-moon-hatch"/>`
        : symbol;
    // The compass point it stands in, azimuths running from north through east.
    const direction = COMPASS_16[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];
    return { svg, lit, altitude, direction, below };
}

const clockTime = (ms) => (ms === null ? "none" : clock(new Date(ms), { timeStyle: "short" }).text);

function describe(wallDay, lanes, moon) {
    const date = new Date(wallDay * DAY_MS).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    });
    const { rise, set, transit, transitAltitude } = lanes.events;
    const highest =
        transit === null || transitAltitude <= RISE_ALTITUDE
            ? ""
            : `, highest ${clockTime(transit)} at ${transitAltitude.toFixed(0)}°`;
    const where = moon.below ? "below the horizon" : `${moon.altitude.toFixed(0)}° up in the ${moon.direction}`;
    return `${date}: moonrise ${clockTime(rise)}, moonset ${clockTime(set)}${highest}; ${Math.round(moon.lit * 100)}% lit, ${where} at the chosen time`;
}

let lanesKey = "";
let lanesByDay = new Map();
let visible = false;
let pending = false;

function render() {
    pending = false;
    const days = gridDays();
    const key = [shown.year, shown.month, state.latitude, state.longitude, state.heightM, state.timeZone].join();
    if (key !== lanesKey) {
        lanesKey = key;
        lanesByDay = new Map(days.map((day) => [day, dayLanes(day)]));
    }
    const page = pageMs();
    const pageDay = wallDayOf(page);
    // The time of day on the page's clock, the same for every day of the grid.
    const timeOfDay = page + clockOffsetMs(new Date(page)) - pageDay * DAY_MS;

    let html = "";
    for (let week = 0; week < days.length / 7; week++) {
        const weekDays = days.slice(week * 7, week * 7 + 7);
        let cells = "";
        let lanes = "";
        weekDays.forEach((day, column) => {
            const date = new Date(day * DAY_MS);
            const other = date.getUTCMonth() !== shown.month;
            const at = instantOf(day * DAY_MS + timeOfDay);
            const moon = disc(at);
            const dayLanes = lanesByDay.get(day);
            const label = describe(day, dayLanes, moon);
            const classes = `calendar-day${other ? " calendar-other" : ""}`;
            const current = day === pageDay ? ' aria-current="date"' : "";
            cells += `<button type="button" class="${classes}" data-day="${day}" data-at="${at}" title="${label}" aria-label="${label}"${current}>
                <span class="calendar-date">${String(date.getUTCDate()).padStart(2, "0")}<span class="calendar-where">${moon.below ? "<span>\u00a0</span><span>\u00a0</span>" : `<span>${moon.direction}</span><span>\u2191${moon.altitude.toFixed(0)}°</span>`}</span></span>
                <svg viewBox="-20 -20 40 40" aria-hidden="true">${moon.svg}</svg></button>`;

            const x0 = column * SAMPLES_PER_DAY;
            lanes += laneRuns(dayLanes.moonLevels, 0, "calendar-lane-moon", x0);
            lanes += laneRuns(dayLanes.sunLevels, LANE_HEIGHT + LANE_GAP, "calendar-lane-sun", x0);
            const toX = (ms) => x0 + ((ms - dayLanes.start) / (dayLanes.end - dayLanes.start)) * SAMPLES_PER_DAY;
            const tick = toX(at);
            lanes += `<line x1="${f(tick)}" y1="-1" x2="${f(tick)}" y2="${LANES_HEIGHT + 1}" class="calendar-tick"/>`;
        });
        html += `<div class="calendar-week">${cells}
            <svg class="calendar-lanes" viewBox="0 -2 ${7 * SAMPLES_PER_DAY} ${LANES_HEIGHT + 3}" preserveAspectRatio="none" aria-hidden="true">${lanes}</svg></div>`;
    }
    weeksEl.innerHTML = html;

    const monthName = (offset, options) =>
        new Date(Date.UTC(shown.year, shown.month + offset, 1)).toLocaleDateString("en-GB", {
            ...options,
            timeZone: "UTC",
        });
    titleEl.textContent = monthName(0, { month: "long", year: "numeric" });
    // The year only where it changes, counting outwards from the shown month: on a January to its right, a December
    // to its left.
    for (const button of monthButtons) {
        const offset = Number(button.dataset.month);
        const month = new Date(Date.UTC(shown.year, shown.month + offset, 1)).getUTCMonth();
        const boundary = month === (offset > 0 ? 0 : 11);
        button.textContent = monthName(offset, { month: "long", ...(boundary ? { year: "numeric" } : {}) });
        button.setAttribute("aria-label", monthName(offset, { month: "long", year: "numeric" }));
    }
}

// Drawn on demand, at most once a frame, and only while in view: out of view a change just marks it for later.
function schedule() {
    if (!visible || pending) return;
    pending = true;
    requestAnimationFrame(render);
}

for (const button of monthButtons) {
    button.addEventListener("click", () => {
        const date = new Date(Date.UTC(shown.year, shown.month + Number(button.dataset.month), 1));
        shown = { year: date.getUTCFullYear(), month: date.getUTCMonth() };
        schedule();
    });
}

// A day sets the page's moment to that day, at the same time of day. With Ctrl, or Cmd on a Mac, where Ctrl+click opens
// the context menu, the calendar turns to that day's month as well.
weeksEl.addEventListener("click", (event) => {
    const day = event.target.closest(".calendar-day");
    if (!day) return;
    if (event.ctrlKey || event.metaKey) {
        const date = new Date(Number(day.dataset.day) * DAY_MS);
        shown = { year: date.getUTCFullYear(), month: date.getUTCMonth() };
    }
    const jd = precise.julianDayUT(precise.fromDate(new Date(Number(day.dataset.at))));
    update({ jd: Number(jd.toFixed(7)), live: false, animate: false });
});

figure.querySelector(".calendar-weekdays").innerHTML = WEEKDAYS.map((day) => `<span>${day}</span>`).join("");

new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    schedule();
}).observe(figure);
onChange(schedule);
