import * as precise from "@himmelszelt/sternzeit";
import * as approx from "@himmelszelt/sternzeit/approx";
import { onDemand } from "../frame.js";
import { drawSvg, LABEL_GAP, STRIP_MARGIN, svgText } from "./figure.js";
import { onChange, state, update } from "./state.js";
import { clockOffsetMs, DAY_MS, wallDayOf } from "./zone.js";
import "./export.js";

// Ten-minute rows: a pixel or so each at the strip's height. The approximate Sun is a few thousandths of a degree off,
// far below that, and some fifty thousand positions a year are then quick.
const STEP_MINUTES = 10;
const ROWS = (24 * 60) / STEP_MINUTES;
const MINUTE_MS = 60_000;
const UNIX_EPOCH_JD = 2440587.5;
// The bands by the Sun's altitude, from the top: day, the golden hour (-4 to 6 degrees, as photographers count it),
// the blue hour (-6 to -4), then the three twilights; below -18 degrees it is night, the page's own background.
const BANDS = [
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

const svgEl = document.querySelector(".daylight-panel > svg");
const f = (n) => n.toFixed(1);

// Where the Sun is at or above a threshold on a day, in rows from its midnight, around its highest sample: the
// crossings interpolated between samples, read as a circle (a day later the sky is nearly the same), so a span may
// run past either midnight; a day it stays below is a span of nothing at noon.
function span(altitudes, peak, threshold) {
    if (altitudes[peak] < threshold) return [peak + 0.5, peak + 0.5];
    const at = (i) => altitudes[(i + ROWS) % ROWS];
    const edge = (direction) => {
        for (let k = 1; k <= ROWS / 2; k++) {
            const [inside, outside] = [at(peak + direction * (k - 1)), at(peak + direction * k)];
            if (outside < threshold)
                return peak + 0.5 + direction * (k - 1 + (inside - threshold) / (inside - outside));
        }
        // Above all day: a whole day either way, so the copies a day apart overlap instead of meeting in a seam.
        return peak + 0.5 + direction * ROWS;
    };
    return [edge(-1), edge(1)];
}

// The year's bands, a span of rows per day and band; recomputed only when the year, the place or the clock changes.
let key = "";
let year = null;

function computeYear() {
    const wallDay = wallDayOf(precise.toDate(precise.fromJulianDay(state.jd)).getTime());
    const shownYear = new Date(wallDay * DAY_MS).getUTCFullYear();
    const next = [shownYear, state.latitude, state.longitude, state.heightM, state.timeZone].join();
    if (next === key) return;
    key = next;
    const first = Date.UTC(shownYear, 0, 1) / DAY_MS;
    const count = Date.UTC(shownYear + 1, 0, 1) / DAY_MS - first;
    const observer = { latitude: state.latitude, longitude: state.longitude, heightM: state.heightM };
    const days = [];
    for (let d = 0; d < count; d++) {
        const dayMs = (first + d) * DAY_MS;
        // The clock's offset at noon: it changes at night, so the day switching to or from summer time is off by an
        // hour for those few hours only.
        const offset = clockOffsetMs(new Date(dayMs + DAY_MS / 2));
        const altitudes = Array.from({ length: ROWS }, (_, row) => {
            const ms = dayMs + (row + 0.5) * STEP_MINUTES * MINUTE_MS - offset;
            return approx.sun.horizontalPosition(precise.fromJulianDay(UNIX_EPOCH_JD + ms / DAY_MS), observer).altitude;
        });
        const peak = altitudes.indexOf(Math.max(...altitudes));
        days.push({
            dayMs,
            offset,
            spans: BANDS.map(([threshold]) => span(altitudes, peak, threshold)),
            sun: span(altitudes, peak, SUNRISE),
        });
    }
    year = { shownYear, first, days };
}

function layout() {
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 140];
    // The hours flush with the text's left edge, the plot after them: two monospace digits, some 0.6 em each, and the gap.
    const left = 1.2 * parseFloat(getComputedStyle(svgEl).fontSize) + LABEL_GAP;
    const plot = { left, right: width - MARGIN.right, top: MARGIN.top, bottom: height - MARGIN.bottom };
    const column = (plot.right - plot.left) / year.days.length;
    const rowHeight = (plot.bottom - plot.top) / ROWS;
    return { width, height, plot, column, rowHeight };
}

function render() {
    computeYear();
    const { width, height, plot, column, rowHeight } = layout();
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

    let svg = `<rect x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}" class="daylight-night"/>`;
    // Each band one shape over the year, from the darkest up, each painted over the one before. A span past midnight
    // shows on the other edge too, so each is drawn a day earlier and later as well, clipped to the plot.
    svg += `<clipPath id="daylight-clip"><rect x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/></clipPath><g clip-path="url(#daylight-clip)">`;
    const xs = year.days.map((_, d) => plot.left + (d + 0.5) * column);
    [xs[0], xs[xs.length - 1]] = [plot.left, plot.right];
    for (let b = BANDS.length - 1; b >= 0; b--) {
        for (const shift of [-ROWS, 0, ROWS]) {
            // Where the clock jumps to or from summer time, the edge steps straight up or down between the two days.
            const edge = (i) =>
                year.days.flatMap(({ spans, offset }, d) => {
                    const y = (span) => f(plot.top + (span[b][i] + shift) * rowHeight);
                    const point = `${f(xs[d])},${y(spans)}`;
                    const before = year.days[d - 1];
                    if (!before || before.offset === offset) return [point];
                    const x = f(plot.left + d * column);
                    return [`${x},${y(before.spans)}`, `${x},${y(spans)}`, point];
                });
            svg += `<polygon points="${[...edge(0), ...edge(1).reverse()].join(" ")}" class="${BANDS[b][1]}"/>`;
        }
    }
    // Sunrise and sunset as two lines, broken off on the days the Sun never rises or never sets, and where the clock
    // jumps to or from summer time.
    for (const shift of [-ROWS, 0, ROWS]) {
        for (const i of [0, 1]) {
            let [d, pen] = ["", "M"];
            year.days.forEach(({ sun, offset }, day) => {
                const rises = sun[1] - sun[0] > 0 && sun[1] - sun[0] < ROWS;
                if (day > 0 && offset !== year.days[day - 1].offset) pen = "M";
                if (rises) d += `${pen}${f(xs[day])},${f(plot.top + (sun[i] + shift) * rowHeight)}`;
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
    const ms = precise.toDate(precise.fromJulianDay(state.jd)).getTime();
    const d = wallDayOf(ms) - year.first;
    if (d >= 0 && d < year.days.length) {
        const wallMinutes = (ms + clockOffsetMs(new Date(ms)) - (year.first + d) * DAY_MS) / MINUTE_MS;
        const [mx, my] = [
            plot.left + (d + 0.5) * column,
            plot.top + (wallMinutes / (24 * 60)) * (plot.bottom - plot.top),
        ];
        svg += `<line x1="${f(mx)}" y1="${plot.top}" x2="${f(mx)}" y2="${plot.bottom}" class="strip-moment"/>`;
        svg += `<circle cx="${f(mx)}" cy="${f(my)}" r="3" class="strip-moment-dot"/>`;
    }
    drawSvg(svgEl, svg, 1);
}

// A click moves the moment to that day and time of day on the clock.
svgEl.addEventListener("click", (event) => {
    if (!year) return;
    const { plot, column } = layout();
    const box = svgEl.getBoundingClientRect();
    const [px, py] = [event.clientX - box.left, event.clientY - box.top];
    if (px < plot.left || px > plot.right || py < plot.top || py > plot.bottom) return;
    const day = year.days[Math.min(year.days.length - 1, Math.floor((px - plot.left) / column))];
    const minutes = Math.round(((py - plot.top) / (plot.bottom - plot.top)) * 24 * 60);
    const ms = day.dayMs + minutes * MINUTE_MS - day.offset;
    update({ jd: Number((UNIX_EPOCH_JD + ms / DAY_MS).toFixed(7)), live: false, animate: false });
});

const requestRender = onDemand(render);
onChange(requestRender);
new ResizeObserver(requestRender).observe(svgEl);
render();
