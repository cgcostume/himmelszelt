import * as precise from "@himmelszelt/sternzeit";
import * as approx from "@himmelszelt/sternzeit/approx";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, LABEL_GAP, STRIP_MARGIN, stripMoment, svgText } from "./figure";
import { onChange, state, update } from "./state";
import { clockOffsetMs, DAY_MS, wallDayOf } from "./zone";
import "./export";

// Ten-minute rows: a pixel or so each at the strip's height. The approximate Sun is a few thousandths of a degree off,
// far below that. A new year or place is sampled half-hourly first, on every fourth day with the days between drawn in,
// a twelfth of the work, and in full once it has stood still for a moment.
const ROWS = 144;
const COARSE_ROWS = 48;
const COARSE_DAY_STEP = 4;
const REFINE_MS = 200;
const MINUTE_MS = 60_000;
// The bands by the Sun's altitude, from the top: day, the golden hour (-4 to 6 degrees, as photographers count it),
// the blue hour (-6 to -4), then the three twilights; below -18 degrees it is night, the page's own background.
const BANDS: [threshold: number, cls: string][] = [
    [6, "daylight-day"],
    [-4, "daylight-golden"],
    [-6, "daylight-blue"],
    [-12, "daylight-nautical"],
    [-18, "daylight-astronomical"],
];
// Sunrise and sunset: the refracted upper limb on the horizon, as every almanac counts them.
const SUNRISE = -0.833;
const MARGIN = { ...STRIP_MARGIN, right: 1 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const svgEl = find<SVGSVGElement>(".daylight-panel > svg");
const latitudeInput = find<HTMLInputElement>('#daylight [data-field="latitude"]');
const latitudeValue = find('#daylight [data-field="latitudeValue"]');
const f = (n: number) => n.toFixed(1);

// Where the Sun is at or above a threshold on a day, in rows from its midnight, around its highest sample: the
// crossings interpolated between samples, read as a circle (a day later the sky is nearly the same), so a span may
// run past either midnight; a day it stays below is a span of nothing at noon.
type Span = [start: number, end: number];

function span(altitudes: number[], peak: number, threshold: number): Span {
    const n = altitudes.length;
    // In ROWS whatever the samples, so the drawing need not know how finely the day was sampled.
    const scale = ROWS / n;
    const at = (i: number) => altitudes[(i + n) % n] ?? Number.NaN;
    if (at(peak) < threshold) return [(peak + 0.5) * scale, (peak + 0.5) * scale];
    const edge = (direction: number) => {
        for (let k = 1; k <= n / 2; k++) {
            const [inside, outside] = [at(peak + direction * (k - 1)), at(peak + direction * k)];
            if (outside < threshold)
                return (peak + 0.5 + direction * (k - 1 + (inside - threshold) / (inside - outside))) * scale;
        }
        // Above all day: closed where it is lowest, half a day off its peak, as a day it dips below there briefly is;
        // a row further, so the copies a day apart overlap instead of meeting in a seam.
        return (peak + 0.5) * scale + direction * (ROWS / 2 + 1);
    };
    return [edge(-1), edge(1)];
}

// The year's bands, a span of rows per day and band; recomputed only when the year, the place or the clock changes.
let key = "";
type Day = { dayMs: number; offset: number; spans: Span[]; sun: Span };
type Year = { shownYear: number; first: number; days: Day[] };
let year: Year | null = null;
let refine: ReturnType<typeof setTimeout> | undefined;

function computeYear(): Year {
    const wallDay = wallDayOf(precise.dateFromJulianDay(state.jd).getTime());
    const shownYear = new Date(wallDay * DAY_MS).getUTCFullYear();
    const next = [shownYear, state.latitude, state.longitude, state.heightM, state.timeZone].join();
    if (next === key && year) return year;
    key = next;
    clearTimeout(refine);
    year = sampleYear(shownYear, COARSE_ROWS, COARSE_DAY_STEP);
    refine = setTimeout(() => {
        if (key !== next) return;
        year = sampleYear(shownYear, ROWS);
        requestRender();
    }, REFINE_MS);
    return year;
}

/** The year's days, every `dayStep`th and the last sampled `rows` times, those between interpolated. */
function sampleYear(shownYear: number, rows: number, dayStep = 1): Year {
    const first = Date.UTC(shownYear, 0, 1) / DAY_MS;
    const count = Date.UTC(shownYear + 1, 0, 1) / DAY_MS - first;
    const observer = { latitude: state.latitude, longitude: state.longitude, heightM: state.heightM };
    const days: Day[] = [];
    for (let d = 0; d < count; d++) {
        const dayMs = (first + d) * DAY_MS;
        // The clock's offset at noon: it changes at night, so the day switching to or from summer time is off by an
        // hour for those few hours only.
        const offset = clockOffsetMs(new Date(dayMs + DAY_MS / 2));
        if (d % dayStep !== 0 && d !== count - 1) {
            days.push({ dayMs, offset, spans: [], sun: [0, 0] });
            continue;
        }
        const altitudes = Array.from({ length: rows }, (_, row) => {
            const ms = dayMs + ((row + 0.5) / rows) * DAY_MS - offset;
            return approx.sun.horizontalPosition(
                precise.fromJulianDay(precise.julianDayFromDate(new Date(ms))),
                observer,
            ).altitude;
        });
        const peak = altitudes.indexOf(Math.max(...altitudes));
        days.push({
            dayMs,
            offset,
            spans: BANDS.map(([threshold]) => span(altitudes, peak, threshold)),
            sun: span(altitudes, peak, SUNRISE),
        });
    }
    // The days between, along a straight line from the sampled one before to the one after: in UT, then onto the day's
    // own clock, so a switch to or from summer time still steps where it happens.
    for (let d = 0; d < count; d++) {
        if (d % dayStep === 0 || d === count - 1) continue;
        const [a, b] = [Math.floor(d / dayStep) * dayStep, Math.min(Math.ceil(d / dayStep) * dayStep, count - 1)];
        const [before, after, day] = [days[a], days[b], days[d]];
        if (!before || !after || !day) continue;
        const t = (d - a) / (b - a);
        const rowsOf = (ms: number) => (ms / DAY_MS) * ROWS;
        const [from, to] = [rowsOf(day.offset - before.offset), rowsOf(day.offset - after.offset)];
        const lerp = (x: Span, y: Span): Span => [
            x[0] + from + (y[0] + to - x[0] - from) * t,
            x[1] + from + (y[1] + to - x[1] - from) * t,
        ];
        day.spans = before.spans.map((s, i) => lerp(s, after.spans[i] ?? s));
        day.sun = lerp(before.sun, after.sun);
    }
    return { shownYear, first, days };
}

function layout(year: Year) {
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 140];
    // The hours flush with the text's left edge, the plot after them: two monospace digits, some 0.6 em each, and the gap.
    const left = 1.2 * parseFloat(getComputedStyle(svgEl).fontSize) + LABEL_GAP;
    const plot = { left, right: width - MARGIN.right, top: MARGIN.top, bottom: height - MARGIN.bottom };
    const column = (plot.right - plot.left) / year.days.length;
    const rowHeight = (plot.bottom - plot.top) / ROWS;
    return { width, height, plot, column, rowHeight };
}

function render() {
    const year = computeYear();
    const { width, height, plot, column, rowHeight } = layout(year);
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

    let svg = `<rect x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}" class="daylight-night"/>`;
    // Each band one shape over the year, from the darkest up, each painted over the one before. A span past midnight
    // shows on the other edge too, so each is drawn a day earlier and later as well, clipped to the plot.
    svg += `<clipPath id="daylight-clip"><rect x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/></clipPath><g clip-path="url(#daylight-clip)">`;
    const xs = year.days.map((_, d) => plot.left + (d + 0.5) * column);
    xs[0] = plot.left;
    xs[xs.length - 1] = plot.right;
    for (let b = BANDS.length - 1; b >= 0; b--) {
        for (const shift of [-ROWS, 0, ROWS]) {
            // Where the clock jumps to or from summer time, the edge steps straight up or down between the two days.
            const edge = (i: 0 | 1) =>
                year.days.flatMap(({ spans, offset }, d) => {
                    const y = (spans: Span[]) => f(plot.top + ((spans[b]?.[i] ?? 0) + shift) * rowHeight);
                    const point = `${f(xs[d] ?? 0)},${y(spans)}`;
                    const before = year.days[d - 1];
                    if (!before || before.offset === offset) return [point];
                    const x = f(plot.left + d * column);
                    return [`${x},${y(before.spans)}`, `${x},${y(spans)}`, point];
                });
            svg += `<polygon points="${[...edge(0), ...edge(1).reverse()].join(" ")}" class="${BANDS[b]?.[1]}"/>`;
        }
    }
    // Sunrise and sunset as two lines, broken off on the days the Sun never rises or never sets, and where the clock
    // jumps to or from summer time.
    for (const shift of [-ROWS, 0, ROWS]) {
        for (const i of [0, 1] as const) {
            let [d, pen] = ["", "M"];
            year.days.forEach(({ sun, offset }, day) => {
                const rises = sun[1] - sun[0] > 0 && sun[1] - sun[0] < ROWS;
                if (day > 0 && offset !== year.days[day - 1]?.offset) pen = "M";
                if (rises) d += `${pen}${f(xs[day] ?? 0)},${f(plot.top + (sun[i] + shift) * rowHeight)}`;
                pen = rises ? "L" : "M";
            });
            if (d) svg += `<path d="${d}" class="daylight-sunrise"/>`;
        }
    }
    svg += "</g>";
    for (const hour of [0, 6, 12, 18, 24]) {
        const y = plot.top + (hour / 24) * (plot.bottom - plot.top);
        svg += `<line x1="${plot.left}" y1="${f(y)}" x2="${plot.right}" y2="${f(y)}" class="figure-grid daylight-grid"/>`;
    }
    for (const x of [plot.left, plot.right]) {
        svg += `<line x1="${f(x)}" y1="${plot.top}" x2="${f(x)}" y2="${plot.bottom}" class="figure-grid daylight-grid"/>`;
    }
    for (const hour of [0, 6, 12, 18, 24]) {
        const y = plot.top + (hour / 24) * (plot.bottom - plot.top);
        svg += svgText(0, y, String(hour).padStart(2, "0"), "figure-grid-label strip-tick");
    }
    MONTHS.forEach((name, month) => {
        const start = (Date.UTC(year.shownYear, month, 1) / DAY_MS - year.first) * column;
        const end = (Date.UTC(year.shownYear, month + 1, 1) / DAY_MS - year.first) * column;
        svg += svgText(plot.left + (start + end) / 2, height - MARGIN.bottom / 2, name, "figure-label");
        if (month > 0) {
            svg += `<line x1="${f(plot.left + start)}" y1="${plot.bottom}" x2="${f(plot.left + start)}" y2="${plot.bottom + 4}" class="daylight-tick"/>`;
        }
    });

    // The moment: its day and time on the clock, a dot where the two meet.
    const ms = precise.dateFromJulianDay(state.jd).getTime();
    const d = wallDayOf(ms) - year.first;
    if (d >= 0 && d < year.days.length) {
        const wallMinutes = (ms + clockOffsetMs(new Date(ms)) - (year.first + d) * DAY_MS) / MINUTE_MS;
        const [mx, my] = [
            plot.left + (d + 0.5) * column,
            plot.top + (wallMinutes / (24 * 60)) * (plot.bottom - plot.top),
        ];
        svg += stripMoment(mx, my, plot.top, plot.bottom);
    }
    // Where a click would take the moment, while the pointer is over the plot, labeled on the side with more room.
    if (hovered) {
        const [hx, hy] = [
            plot.left + (hovered.day + 0.5) * column,
            plot.top + (hovered.minutes / (24 * 60)) * (plot.bottom - plot.top),
        ];
        const left = hx > (plot.left + plot.right) / 2;
        const date = new Date((year.first + hovered.day) * DAY_MS).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "short",
            timeZone: "UTC",
        });
        const time = `${String(Math.floor(hovered.minutes / 60) % 24).padStart(2, "0")}:${String(hovered.minutes % 60).padStart(2, "0")}`;
        const ly = hy < (plot.top + plot.bottom) / 2 ? hy + 12 : hy - 10;
        svg += stripMoment(hx, hy, plot.top, plot.bottom, "daylight-hover");
        svg += svgText(
            hx + (left ? -LABEL_GAP : LABEL_GAP),
            ly,
            `${date} ${time}`,
            `figure-note figure-anchor-${left ? "end" : "start"} daylight-hover`,
        );
    }
    drawSvg(svgEl, svg, 1);
}

// The day and the minute on the clock under the pointer, or null off the plot.
let hovered: { day: number; minutes: number } | null = null;
function pointAt(event: MouseEvent) {
    if (!year) return null;
    const { plot, column } = layout(year);
    const box = svgEl.getBoundingClientRect();
    const [px, py] = [event.clientX - box.left, event.clientY - box.top];
    if (px < plot.left || px > plot.right || py < plot.top || py > plot.bottom) return null;
    const day = Math.min(year.days.length - 1, Math.floor((px - plot.left) / column));
    return { day, minutes: Math.round(((py - plot.top) / (plot.bottom - plot.top)) * 24 * 60) };
}

// The slider sets the place's latitude, whole degrees at a time; the longitude stays.
latitudeInput.addEventListener("input", () => update({ latitude: Number(latitudeInput.value) }));
function renderLatitude() {
    latitudeInput.value = String(state.latitude);
    paintRange(latitudeInput);
    latitudeValue.textContent = `${Math.abs(state.latitude).toFixed(1)}° ${state.latitude < 0 ? "S" : "N"}`;
}

// A click moves the moment to that day and time of day on the clock.
svgEl.addEventListener("click", (event) => {
    const at = pointAt(event);
    const day = at && year?.days[at.day];
    if (!at || !day) return;
    const ms = day.dayMs + at.minutes * MINUTE_MS - day.offset;
    update({ jd: Number(precise.julianDayFromDate(new Date(ms)).toFixed(7)), live: false, animate: false });
});

const requestRender = onDemand(render, svgEl);
// Hovering shows where a click would go, without touching the page's moment.
svgEl.addEventListener("pointermove", (event) => {
    hovered = pointAt(event);
    requestRender();
});
svgEl.addEventListener("pointerleave", () => {
    hovered = null;
    requestRender();
});
onChange(requestRender);
onChange(renderLatitude);
new ResizeObserver(requestRender).observe(svgEl);
render();
renderLatitude();
