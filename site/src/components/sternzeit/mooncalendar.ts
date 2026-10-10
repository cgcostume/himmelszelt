import * as precise from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { moonSymbol, sunInViewFrame } from "./figure";
import { onChange, state, update } from "./state";
import { momentOnClock } from "./timeofday";
import { clock, DAY_MS, instantOf, wallDayOf } from "./zone";

// Ten-minute steps: rise and set are then found to the minute by bisection, and the lanes are smooth enough.
const SAMPLES_PER_DAY = 144;
// The upper limb on the horizon, refraction included: the almanacs' -0.833 degrees, for the Moon about right too.
const RISE_ALTITUDE = -0.833;
// The end of civil twilight: below it, the Sun lane is night.
const TWILIGHT_ALTITUDE = -6;
// Above this the Moon has left the yellow of the long path through the air behind.
const MOON_WHITE_ALTITUDE = 10;
// Gradient stops along the lanes only where the color has moved on by this much, so a week takes a few dozen.
const LEVEL_STEP = 0.05;
const LANE_HEIGHT = 3;
const LANE_GAP = 1;
const LANES_HEIGHT = 2 * LANE_HEIGHT + LANE_GAP;
const DISC_RADIUS = 14;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Sixteen compass points, 22.5 degrees apart: about as fine as a whole-degree altitude beside it.
const COMPASS_16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

const figure = find(".moon-calendar");
const weeksEl = find('[data-field="weeks"]', figure);
const titleEl = find('[data-field="title"]', figure);
const monthButtons = [...figure.querySelectorAll<HTMLButtonElement>("[data-month]")];
const lockButton = find('[data-field="lock"]', figure);
// Locked, the calendar shows the moment's month and follows it; neither months nor days can be picked.
let locked = false;

const f = (n: number) => n.toFixed(2);
const timeOf = (ms: number) => precise.fromJulianDay(precise.julianDayFromDate(new Date(ms)));
const moonAltitude = (ms: number) => precise.moon.horizontalPosition(timeOf(ms), state).altitude;
const sunAltitude = (ms: number) => precise.sun.horizontalPosition(timeOf(ms), state).altitude;
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

const pageMs = () => precise.dateFromJulianDay(state.jd).getTime();
// The month shown, as year and month on the page's clock; it starts at the page's moment and then keeps to itself.
function pageMonth() {
    const date = new Date(wallDayOf(pageMs()) * DAY_MS);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}
let shown = pageMonth();

/** The days the grid shows: whole weeks from Monday, around the shown month. */
function gridDays() {
    const first = Date.UTC(shown.year, shown.month, 1) / DAY_MS;
    const count = new Date(Date.UTC(shown.year, shown.month + 1, 0)).getUTCDate();
    const weekday = (new Date(first * DAY_MS).getUTCDay() + 6) % 7;
    const weeks = Math.ceil((weekday + count) / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => first - weekday + i);
}

/** Narrows down where `altitude` crosses `threshold` between two instants, to well under a minute. */
function crossing(altitude: (ms: number) => number, threshold: number, a: number, b: number) {
    const aboveAtA = altitude(a) > threshold;
    for (let i = 0; i < 8; i++) {
        const m = (a + b) / 2;
        if (altitude(m) > threshold === aboveAtA) a = m;
        else b = m;
    }
    return (a + b) / 2;
}

/** Narrows down the Moon's highest point between two instants around it. */
function culmination(a: number, b: number) {
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
type Events = { rise: number | null; set: number | null; transit: number | null; transitAltitude: number | null };
type DayLanes = ReturnType<typeof dayLanes>;

function dayLanes(wallDay: number) {
    const start = instantOf(wallDay * DAY_MS);
    const step = (instantOf((wallDay + 1) * DAY_MS) - start) / SAMPLES_PER_DAY;
    const times = Array.from({ length: SAMPLES_PER_DAY + 1 }, (_, i) => start + i * step);
    const moon = times.map(moonAltitude);
    const sun = times.map(sunAltitude);
    const events: Events = { rise: null, set: null, transit: null, transitAltitude: null };
    const at = (i: number) => times[i] ?? start;
    const moonAt = (i: number) => moon[i] ?? Number.NaN;
    let highest = 0;
    for (let i = 1; i <= SAMPLES_PER_DAY; i++) {
        const [before, now] = [moonAt(i - 1) > RISE_ALTITUDE, moonAt(i) > RISE_ALTITUDE];
        if (!before && now) events.rise = crossing(moonAltitude, RISE_ALTITUDE, at(i - 1), at(i));
        if (before && !now) events.set = crossing(moonAltitude, RISE_ALTITUDE, at(i - 1), at(i));
        if (moonAt(i) > moonAt(highest)) highest = i;
    }
    // A maximum inside the day, not at its edge, is a culmination; above the horizon or not, it is the transit.
    if (highest > 0 && highest < SAMPLES_PER_DAY) {
        events.transit = culmination(at(highest - 1), at(highest + 1));
        events.transitAltitude = moonAltitude(events.transit);
    }
    const moonLevels = moon
        .slice(0, -1)
        .map((h) => (h > RISE_ALTITUDE ? clamp01((h - RISE_ALTITUDE) / (MOON_WHITE_ALTITUDE - RISE_ALTITUDE)) : -1));
    const sunLevels = sun
        .slice(0, -1)
        .map((h) =>
            h > RISE_ALTITUDE
                ? 1
                : h > TWILIGHT_ALTITUDE
                  ? clamp01((h - TWILIGHT_ALTITUDE) / (RISE_ALTITUDE - TWILIGHT_ALTITUDE))
                  : -1,
        );
    return { start, end: start + step * SAMPLES_PER_DAY, events, moonLevels, sunLevels };
}

const LANE_COLORS = {
    moon: (level: number) => `color-mix(in oklab, var(--text) ${(level * 100).toFixed(0)}%, var(--moon-low))`,
    sun: (level: number) => `color-mix(in oklab, var(--accent) ${(level * 100).toFixed(0)}%, var(--line))`,
};

/**
 * A week's lane as one rect filled with a gradient: no seams between pieces, the color gliding where the altitude does,
 * and a hard edge where the body rises or sets, two stops at the same offset. Levels are 0 to 1, -1 below the horizon.
 */
function lane(levels: number[], id: string, kind: keyof typeof LANE_COLORS, y: number) {
    const color = (level: number) => (level < 0 ? "var(--line)" : LANE_COLORS[kind](level));
    const stop = (offset: number, level = -1) =>
        `<stop offset="${offset.toFixed(5)}" style="stop-color: ${color(level)}"/>`;
    let stops = stop(0, levels[0]);
    let last = levels[0];
    for (let i = 1; i < levels.length; i++) {
        const [before, now] = [levels[i - 1], levels[i]];
        if (before < 0 !== now < 0) {
            stops += stop(i / levels.length, before) + stop(i / levels.length, now);
            last = now;
        } else if (now >= 0 && Math.abs(now - last) >= LEVEL_STEP) {
            stops += stop((i + 0.5) / levels.length, now);
            last = now;
        }
    }
    stops += stop(1, levels.at(-1));
    const width = levels.length;
    return `<linearGradient id="${id}">${stops}</linearGradient><rect y="${y}" width="${width}" height="${LANE_HEIGHT}" fill="url(#${id})"/>`;
}

/** The Moon at `ms` as the symbol in a day's cell: phase, earthshine, libration and tilt as seen from the place. */
function disc(ms: number) {
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

const clockTime = (ms: number | null) => (ms === null ? "none" : clock(new Date(ms), { timeStyle: "short" }).text);

/** What a day's tip says, as plain text for screen readers and as the tip's HTML: where the Moon is, and when it is up. */
function describe(wallDay: number, lanes: DayLanes, moon: ReturnType<typeof disc>, at: number) {
    const date = new Date(wallDay * DAY_MS).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
    });
    const { rise, set, transit, transitAltitude } = lanes.events;
    // In the order they happen: the Moon may well set in the morning and rise again in the evening of the same day.
    const events = (
        [
            [rise, `moonrise ${clockTime(rise)}`],
            [
                (transitAltitude ?? -90) > RISE_ALTITUDE ? transit : null,
                `highest ${clockTime(transit)} at ${transitAltitude?.toFixed(0)}°`,
            ],
            [set, `moonset ${clockTime(set)}`],
        ] as [number | null, string][]
    )
        .filter((event): event is [number, string] => event[0] !== null)
        .sort(([a], [b]) => a - b)
        .map(([, text]) => text);
    const where = moon.below ? "below the horizon" : `${moon.altitude.toFixed(0)}° up in the ${moon.direction}`;
    const now = `${where}, ${Math.round(moon.lit * 100)}% lit`;
    const day = events.length ? events.join(", ") : "no moonrise or moonset";
    return {
        label: `${date}, at ${clockTime(at)}: ${now}; ${day}`,
        html: `<strong>${date}</strong>, at ${clockTime(at)}: ${now}<span class="tip-note">${day.charAt(0).toUpperCase()}${day.slice(1)}</span>`,
    };
}

let lanesKey = "";
let lanesByDay = new Map<number, DayLanes>();

function render() {
    if (locked) shown = pageMonth();
    const days = gridDays();
    const key = [shown.year, shown.month, state.latitude, state.longitude, state.heightM, state.timeZone].join();
    if (key !== lanesKey) {
        lanesKey = key;
        lanesByDay = new Map(days.map((day) => [day, dayLanes(day)]));
    }
    // The moment's day and its time of day on the page's clock, the same time for every day of the grid.
    const { day: pageDay, timeOfDay } = momentOnClock();

    let html = "";
    for (let week = 0; week < days.length / 7; week++) {
        const weekDays = days.slice(week * 7, week * 7 + 7);
        let cells = "";
        // Under the ticks: the lanes of the whole week, each one gradient.
        const levels = (kind: "moonLevels" | "sunLevels") =>
            weekDays.flatMap((day) => lanesByDay.get(day)?.[kind] ?? []);
        let lanes =
            lane(levels("moonLevels"), `moon-calendar-lane-${week}-moon`, "moon", 0) +
            lane(levels("sunLevels"), `moon-calendar-lane-${week}-sun`, "sun", LANE_HEIGHT + LANE_GAP);
        weekDays.forEach((day, column) => {
            const date = new Date(day * DAY_MS);
            const other = date.getUTCMonth() !== shown.month;
            const at = instantOf(day * DAY_MS + timeOfDay);
            const moon = disc(at);
            const dayLanes = lanesByDay.get(day);
            if (!dayLanes) return;
            const tip = describe(day, dayLanes, moon, at);
            // A term like the glossary's, so its tip opens on hover, focus, and on a tap, which a touch screen needs.
            const classes = `calendar-day term${other ? " calendar-other" : ""}`;
            const current = day === pageDay ? ' aria-current="date"' : "";
            cells += `<button type="button" class="${classes}" data-day="${day}" data-at="${at}" aria-label="${tip.label}"${current}>
                <span class="calendar-date">${String(date.getUTCDate()).padStart(2, "0")}<span class="calendar-where">${moon.below ? "" : `<span>${moon.direction}</span><span>\u2191${moon.altitude.toFixed(0)}°</span>`}</span></span>
                <svg viewBox="-20 -20 40 40" aria-hidden="true">${moon.svg}</svg>
                <span class="term-tip" aria-hidden="true">${tip.html}</span></button>`;

            const x0 = column * SAMPLES_PER_DAY;
            const toX = (ms: number) =>
                x0 + ((ms - dayLanes.start) / (dayLanes.end - dayLanes.start)) * SAMPLES_PER_DAY;
            const tick = toX(at);
            lanes += `<line x1="${f(tick)}" y1="-1" x2="${f(tick)}" y2="${LANES_HEIGHT + 1}" class="calendar-tick"/>`;
        });
        html += `<div class="calendar-week">${cells}
            <svg class="calendar-lanes" viewBox="0 -2 ${7 * SAMPLES_PER_DAY} ${LANES_HEIGHT + 3}" preserveAspectRatio="none" aria-hidden="true">${lanes}</svg></div>`;
    }
    // Redrawn on every change, a tapped day included: its tip stays open across the redraw, where it was.
    const open = weeksEl.querySelector<HTMLElement>("[data-tip-open]");
    const shift = open?.querySelector<HTMLElement>(".term-tip")?.style.getPropertyValue("--tip-shift") ?? "";
    weeksEl.innerHTML = html;
    const reopened = open && weeksEl.querySelector(`[data-day="${open.dataset.day}"]`);
    if (reopened) {
        reopened.setAttribute("data-tip-open", "");
        reopened.querySelector<HTMLElement>(".term-tip")?.style.setProperty("--tip-shift", shift);
    }

    // en-US, as en-GB shortens September to four letters.
    const monthName = (offset: number, options: Intl.DateTimeFormatOptions) =>
        new Date(Date.UTC(shown.year, shown.month + offset, 1)).toLocaleDateString("en-US", {
            ...options,
            timeZone: "UTC",
        });
    // Three letters for every month, so in the monospaced font the buttons keep one width as the months turn.
    titleEl.textContent = monthName(0, { month: "short", year: "numeric" });
    // Every neighbor by its month alone; one of another year is dimmed, like the days of another month below.
    for (const button of monthButtons) {
        const offset = Number(button.dataset.month);
        const year = new Date(Date.UTC(shown.year, shown.month + offset, 1)).getUTCFullYear();
        button.textContent = monthName(offset, { month: "short" });
        button.classList.toggle("calendar-other-year", year !== shown.year);
        button.setAttribute("aria-label", monthName(offset, { month: "long", year: "numeric" }));
        button.disabled = locked;
    }
}

// Drawn on demand, at most once a frame, and only while in view: out of view a change just marks it for later.
const schedule = onDemand(render, figure);

lockButton.addEventListener("click", () => {
    locked = !locked;
    lockButton.setAttribute("aria-pressed", String(locked));
    figure.toggleAttribute("data-locked", locked);
    schedule();
});

for (const button of monthButtons) {
    button.addEventListener("click", () => {
        const date = new Date(Date.UTC(shown.year, shown.month + Number(button.dataset.month), 1));
        shown = { year: date.getUTCFullYear(), month: date.getUTCMonth() };
        schedule();
    });
}

// A day sets the page's moment to that day, at the same time of day; a second click or tap on it soon after turns the
// calendar to that day's month as well. Counted here rather than left to dblclick, as the first click redraws the
// calendar and the second lands on a new element.
const DOUBLE_CLICK_MS = 500;
let lastClick: { day: string | null; time: number } = { day: null, time: 0 };
weeksEl.addEventListener("click", (event) => {
    const day = event.target instanceof Element ? event.target.closest<HTMLElement>(".calendar-day") : null;
    if (!day || locked) return;
    const double = lastClick.day === (day.dataset.day ?? null) && event.timeStamp - lastClick.time < DOUBLE_CLICK_MS;
    lastClick = double ? { day: null, time: 0 } : { day: day.dataset.day ?? null, time: event.timeStamp };
    if (double) {
        const date = new Date(Number(day.dataset.day) * DAY_MS);
        shown = { year: date.getUTCFullYear(), month: date.getUTCMonth() };
    }
    const jd = precise.julianDayFromDate(new Date(Number(day.dataset.at)));
    update({ jd: Number(jd.toFixed(7)), live: false, animate: false });
});

find(".calendar-weekdays", figure).innerHTML = WEEKDAYS.map((day) => `<span>${day}</span>`).join("");

onChange(schedule);
schedule();
