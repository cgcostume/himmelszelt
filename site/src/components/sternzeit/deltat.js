import * as precise from "@himmelszelt/sternzeit";
import { onDemand } from "../frame.js";
import { drawSvg, LABEL_GAP as GAP, STRIP_MARGIN as MARGIN, stripMoment, svgText } from "./figure.js";
import { onChange, state } from "./state.js";
import "./export.js";

// Far back on the long-term parabola of Espenak and Meeus, beyond their canon's −2000, to the end of their polynomials,
// and where the measurements take over from them.
const FIRST_YEAR = -8000;
const LAST_YEAR = 2150;
const MEASURED_SINCE = 1962;
const YEAR_STEP = 2;
// ΔT from a minute below zero to ten hours, where the parabola leaves the plot: a logarithm of its size, its sign kept.
const SCALE_MIN = -60;
const SCALE_MAX = 36_000;
// The ticks, minor ones (those in between the units) dimmed.
const TICKS = [
    [-10, "\u221210 s", true],
    [0, "0"],
    [10, "10 s", true],
    [60, "1 m"],
    [600, "10 m", true],
    [3600, "1 h"],
    [36_000, "10 h", true],
];
// Where Espenak and Meeus switch from one polynomial to the next, between -500 and 1962.
const POLYNOMIAL_JOINS = [500, 1600, 1700, 1800, 1860, 1900, 1920, 1941];
const YEAR_TICKS = [-8000, -2000, 0, 500, 1600, 1700, 1800, 1860, 1920, MEASURED_SINCE];
// From this year on, time runs linearly over this share of the width; before it, the years back from it are compressed
// on a logarithm, at a scale chosen so the two meet at the same pace, without a kink.
const LINEAR_SINCE = 1800;
const LINEAR_SHARE = 0.5;
const LOG_SCALE_YEARS = 71;
const LOG_SPAN = Math.log1p((LINEAR_SINCE - FIRST_YEAR) / LOG_SCALE_YEARS);

const svgEl = document.querySelector(".deltat-panel > svg");
// The year under the pointer, while it hovers the plot.
let hovered = null;
const requestRender = onDemand(() => render());
const f = (n) => n.toFixed(1);
const yearOf = (jd) => 2000 + (jd - precise.J2000) / 365.25;
const jdOf = (year) => precise.J2000 + (year - 2000) * 365.25;
const yearText = (year) => `${String(year).replace("-", "\u2212")}:`;
const log = (seconds) => Math.sign(seconds) * Math.log10(1 + Math.abs(seconds));
const deltaT = (year) => precise.deltaT(jdOf(year));
// The year this year: where the measurements end and the extrapolation begins, give or take the last table update.
const today = new Date().getUTCFullYear();

/** ΔT as people read it: seconds, minutes, or hours and minutes. */
function duration(seconds) {
    const s = Math.abs(seconds);
    const sign = seconds < 0 ? "−" : "";
    if (s < 120) return `${sign}${s.toFixed(1)} s`;
    if (s < 3600) return `${sign}${(s / 60).toFixed(1)} min`;
    return `${sign}${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function layout() {
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 140];
    // The plot runs the full width, so its left edge is 0 and its right the width.
    const plot = { top: MARGIN.top, bottom: height - MARGIN.bottom };
    const split = (1 - LINEAR_SHARE) * width;
    const x = (year) =>
        year >= LINEAR_SINCE
            ? split + ((year - LINEAR_SINCE) / (LAST_YEAR - LINEAR_SINCE)) * (width - split)
            : split * (1 - Math.log1p((LINEAR_SINCE - year) / LOG_SCALE_YEARS) / LOG_SPAN);
    const y = (seconds) =>
        plot.bottom - ((log(seconds) - log(SCALE_MIN)) / (log(SCALE_MAX) - log(SCALE_MIN))) * (plot.bottom - plot.top);
    const yearAt = (px) =>
        px >= split
            ? LINEAR_SINCE + ((px - split) / (width - split)) * (LAST_YEAR - LINEAR_SINCE)
            : LINEAR_SINCE - LOG_SCALE_YEARS * Math.expm1((1 - px / split) * LOG_SPAN);
    return { width, height, plot, x, y, yearAt };
}

function path(from, to, { x, y }) {
    const points = [];
    for (let year = from; year < to; year += YEAR_STEP) points.push(`${f(x(year))},${f(y(deltaT(year)))}`);
    points.push(`${f(x(to))},${f(y(deltaT(to)))}`);
    return points.join(" ");
}

function render() {
    const view = layout();
    const { width, height, plot, x, y } = view;
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

    let svg = "";
    const line = (x1, y1, x2, y2, cls) =>
        `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" class="${cls}"/>`;
    for (const [seconds, label, minor] of TICKS) {
        if (seconds !== 0)
            svg += line(0, y(seconds), width, y(seconds), `figure-grid deltat-row${minor ? " deltat-minor" : ""}`);
        svg += svgText(0, y(seconds), label.padStart(5, "\u2007"), "figure-grid-label strip-tick");
    }
    // Narrow, the years crowd: those that are only details left out.
    const crowded = [-2000, 500, 1600, 1700, 1860, 1920, MEASURED_SINCE];
    const years = width < 480 ? YEAR_TICKS.filter((year) => !crowded.includes(year)) : YEAR_TICKS;
    // A labeled join gets a line up through the plot.
    for (const year of POLYNOMIAL_JOINS.filter((year) => years.includes(year))) {
        svg += line(x(year), plot.top, x(year), plot.bottom, "figure-grid deltat-minor");
    }
    for (const year of years) {
        // The first one starts at the plot's edge rather than centered on it, so it stays whole.
        const cls = year === FIRST_YEAR ? "figure-label figure-anchor-start" : "figure-label";
        svg += svgText(x(year), height - MARGIN.bottom / 2, String(year).replace("-", "\u2212"), cls);
    }
    // Today in place of 2000, which it would crowd.
    svg += svgText(
        x(yearOf(precise.julianDayFromDate(new Date()))),
        height - MARGIN.bottom / 2,
        "today",
        "figure-label",
    );
    // Where the pieces hand over, a line from the curve down to the years, a bubble on top (drawn over the curve, below).
    const handovers = [-500, MEASURED_SINCE, today];
    for (const year of handovers) svg += line(x(year), y(deltaT(year)), x(year), plot.bottom, "deltat-axis");
    // The zero line in front of them.
    svg += line(0, y(0), width, y(0), "deltat-zero deltat-row");
    // The parabola climbs past the top long before the first year: the curve clipped to the plot.
    svg += `<clipPath id="deltat-clip"><rect y="${plot.top}" width="${width}" height="${plot.bottom - plot.top}"/></clipPath>`;
    svg += `<polyline points="${path(FIRST_YEAR, MEASURED_SINCE, view)}" class="deltat-line" clip-path="url(#deltat-clip)"/>`;
    svg += `<polyline points="${path(MEASURED_SINCE, today, view)}" class="deltat-line deltat-measured"/>`;
    svg += `<polyline points="${path(today, LAST_YEAR, view)}" class="deltat-line deltat-extrapolated"/>`;

    // Where ΔT dipped below zero, the area between the curve and the zero line hatched, as the moon calendar hatches a
    // Moon below the horizon.
    const negative = [];
    for (let year = 1860; year <= 1910; year += 0.25) if (deltaT(year) < 0) negative.push(year);
    if (negative.length > 1) {
        const points = negative.map((year) => `${f(x(year))},${f(y(deltaT(year)))}`).join(" ");
        const [first, last] = [x(negative[0]), x(negative.at(-1))].map(f);
        svg += `<defs><pattern id="deltat-hatch" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="2" class="calendar-hatch-line"/></pattern></defs>`;
        svg += `<polygon points="${first},${f(y(0))} ${points} ${last},${f(y(0))}" class="deltat-negative"/>`;
    }

    // A small dot where one of Espenak and Meeus' polynomials hands over to the next.
    const dot = (year, r, cls) => `<circle cx="${f(x(year))}" cy="${f(y(deltaT(year)))}" r="${r}" class="${cls}"/>`;
    for (const year of POLYNOMIAL_JOINS) svg += dot(year, 2.2, "deltat-join");
    for (const year of handovers) svg += dot(year, 3, "deltat-bubble");

    // What the curve is made of, named in one row along the bottom, where the curve only dips once.
    const row = (y(0) + y(-10)) / 2;
    svg += svgText(x(-500) + GAP, row, "polynomials \u203A", "figure-label figure-anchor-start");
    // Narrow, the parabola and the measurements are left to their bubbles, and the extrapolation keeps to the edge.
    if (width < 480) svg += svgText(width, row, "extrapolated \u203A", "figure-label figure-anchor-end");
    else {
        svg += svgText(x(-500) - GAP, row, "\u2039 parabola", "figure-label figure-anchor-end");
        svg += svgText((x(MEASURED_SINCE) + x(today)) / 2, row, "measured", "figure-label");
        svg += svgText(x(today) + GAP, row, "extrapolated \u203A", "figure-label figure-anchor-start");
    }

    // A year marked on the curve. The moment's label keeps to the row between the 1 h and 10 h lines, the same height
    // wherever it is; the hovered year's sits by its dot, on the side with more room, below it in the upper half and
    // above it in the lower one.
    const mark = (year, name, cls, labelY = null) => {
        if (year < FIRST_YEAR || year > LAST_YEAR) return "";
        const seconds = deltaT(year);
        const [mx, my] = [x(year), y(seconds)];
        const left = mx > width / 2;
        const label = `${name} ${duration(seconds)}`;
        const ly = labelY ?? (my < (plot.top + plot.bottom) / 2 ? my + 12 : my - 10);
        return (
            stripMoment(mx, my, plot.top, plot.bottom, cls) +
            svgText(mx + (left ? -GAP : GAP), ly, label, `figure-note figure-anchor-${left ? "end" : "start"} ${cls}`)
        );
    };
    // The page's moment always, the hovered year besides while there is one.
    const year = yearOf(state.jd);
    svg += mark(year, yearText(Math.floor(year)), "", (y(3600) + y(36_000)) / 2);
    if (hovered !== null) svg += mark(hovered, yearText(Math.round(hovered)), "deltat-hover");
    drawSvg(svgEl, svg, 1);
    // The rows stop a gap short of their labels, measured once drawn.
    const labels = [...svgEl.querySelectorAll(".strip-tick")].map((text) => text.getBBox());
    const edge = Math.max(...labels.map((box) => box.x + box.width)) + GAP;
    for (const row of svgEl.querySelectorAll(".deltat-row")) row.setAttribute("x1", f(edge));
}

// Hovering reads the curve off at the pointer, without touching the page's moment.
svgEl.addEventListener("pointermove", (event) => {
    const { width, yearAt } = layout();
    const px = event.clientX - svgEl.getBoundingClientRect().left;
    hovered = px < 0 || px > width ? null : yearAt(px);
    requestRender();
});
svgEl.addEventListener("pointerleave", () => {
    hovered = null;
    requestRender();
});

onChange(requestRender);
new ResizeObserver(requestRender).observe(svgEl);
render();
