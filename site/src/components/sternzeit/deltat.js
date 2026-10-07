import * as precise from "@himmelszelt/sternzeit";
import { onDemand } from "../frame.js";
import { drawSvg, svgText } from "./figure.js";
import { onChange, state } from "./state.js";
import "./export.js";

// From the start of the Five Millennium Canon, as far as the long-term parabola of Espenak and Meeus reaches back,
// to the end of their polynomials, and where the measurements take over from them.
const FIRST_YEAR = -2000;
const LAST_YEAR = 2150;
const MEASURED_SINCE = 1962;
const YEAR_STEP = 2;
// Room around the plot, the years below it, in screen pixels; the ΔT axis stands at the year 0.
const MARGIN = { left: 8, right: 8, top: 8, bottom: 20 };
const AXIS_YEAR = 0;
// ΔT runs from a few seconds below zero to nearly five hours: a logarithm of its size, its sign kept, shows both ends.
const SCALE_MIN = -10;
const SCALE_MAX = 50_000;
const TICKS = [
    [0, "0"],
    [10, "10 s"],
    [60, "1 m"],
    [600, "10 m"],
    [3600, "1 h"],
    [36_000, "10 h"],
];
// Where Espenak and Meeus switch from one polynomial to the next, between -500 and 1962.
const POLYNOMIAL_JOINS = [500, 1600, 1700, 1800, 1860, 1900, 1920, 1941];
const YEAR_TICKS = [-2000, 0, 500, 1000, 1500, 1750, 1900, 2000];
// From this year on, time runs linearly over this share of the width; before it, the years back from it are compressed
// on a logarithm, at a scale chosen so the two meet at the same pace, without a kink.
const LINEAR_SINCE = 1750;
const LINEAR_SHARE = 0.5;
const LOG_SCALE_YEARS = 113;

const svgEl = document.querySelector(".deltat-panel > svg");
// The year under the pointer, while it hovers the plot.
let hovered = null;
const requestRender = onDemand(() => render());
const f = (n) => n.toFixed(1);
const yearOf = (jd) => 2000 + (jd - precise.J2000) / 365.25;
const jdOf = (year) => precise.J2000 + (year - 2000) * 365.25;
const yearText = (year) => `${String(year).replace("-", "\u2212")}:`;
const log = (seconds) => Math.sign(seconds) * Math.log10(1 + Math.abs(seconds));
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
    const plot = { left: MARGIN.left, right: width - MARGIN.right, top: MARGIN.top, bottom: height - MARGIN.bottom };
    const span = plot.right - plot.left;
    const split = plot.right - LINEAR_SHARE * span;
    const back = (year) =>
        Math.log1p((LINEAR_SINCE - year) / LOG_SCALE_YEARS) / Math.log1p((LINEAR_SINCE - FIRST_YEAR) / LOG_SCALE_YEARS);
    const x = (year) =>
        year >= LINEAR_SINCE
            ? split + ((year - LINEAR_SINCE) / (LAST_YEAR - LINEAR_SINCE)) * LINEAR_SHARE * span
            : split - back(year) * (split - plot.left);
    const y = (seconds) =>
        plot.bottom - ((log(seconds) - log(SCALE_MIN)) / (log(SCALE_MAX) - log(SCALE_MIN))) * (plot.bottom - plot.top);
    const yearAt = (px) =>
        px >= split
            ? LINEAR_SINCE + ((px - split) / (LINEAR_SHARE * span)) * (LAST_YEAR - LINEAR_SINCE)
            : LINEAR_SINCE -
              LOG_SCALE_YEARS *
                  Math.expm1(
                      ((split - px) / (split - plot.left)) * Math.log1p((LINEAR_SINCE - FIRST_YEAR) / LOG_SCALE_YEARS),
                  );
    return { width, height, plot, x, y, yearAt };
}

function path(from, to, { x, y }) {
    const points = [];
    for (let year = from; year < to; year += YEAR_STEP)
        points.push(`${f(x(year))},${f(y(precise.deltaT(jdOf(year))))}`);
    points.push(`${f(x(to))},${f(y(precise.deltaT(jdOf(to))))}`);
    return points.join(" ");
}

function render() {
    const view = layout();
    const { width, height, plot, x, y } = view;
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);

    let svg = "";
    const axis = x(AXIS_YEAR);
    for (const [seconds, label] of TICKS) {
        svg += `<line x1="${plot.left}" y1="${f(y(seconds))}" x2="${plot.right}" y2="${f(y(seconds))}" class="figure-grid"/>`;
        svg += svgText(axis - 6, y(seconds), label, "figure-grid-label deltat-tick");
    }
    svg += `<line x1="${f(axis)}" y1="${plot.top}" x2="${f(axis)}" y2="${plot.bottom}" class="deltat-axis"/>`;
    for (const year of YEAR_TICKS) {
        // The first one starts at the plot's edge rather than centered on it, so it stays whole.
        const cls = year === FIRST_YEAR ? "figure-label figure-anchor-start" : "figure-label";
        svg += svgText(x(year), height - MARGIN.bottom / 2, String(year).replace("-", "\u2212"), cls);
    }
    // The era of measurements, a band behind the curve.
    svg += `<rect x="${f(x(MEASURED_SINCE))}" y="${plot.top}" width="${f(x(today) - x(MEASURED_SINCE))}" height="${plot.bottom - plot.top}" class="strip-band"/>`;
    svg += `<polyline points="${path(FIRST_YEAR, MEASURED_SINCE, view)}" class="deltat-line"/>`;
    svg += `<polyline points="${path(MEASURED_SINCE, today, view)}" class="deltat-line deltat-measured"/>`;
    svg += `<polyline points="${path(today, LAST_YEAR, view)}" class="deltat-line deltat-extrapolated"/>`;

    // Where ΔT dipped below zero, the area between the curve and the zero line hatched, as the moon calendar hatches a
    // Moon below the horizon.
    const negative = [];
    for (let year = 1860; year <= 1910; year += 0.25) {
        const seconds = precise.deltaT(jdOf(year));
        if (seconds < 0) negative.push(`${f(x(year))},${f(y(seconds))}`);
    }
    if (negative.length > 1) {
        const [first, last] = [negative[0], negative.at(-1)].map((point) => point.split(",")[0]);
        svg += `<defs><pattern id="deltat-hatch" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="2" class="calendar-hatch-line"/></pattern></defs>`;
        svg += `<polygon points="${first},${f(y(0))} ${negative.join(" ")} ${last},${f(y(0))}" class="deltat-negative"/>`;
    }

    // Where the pieces join: a bubble at each end of the parabola, the polynomials, the measurements and the
    // extrapolation, and a small dot where one of Espenak and Meeus' polynomials hands over to the next.
    for (const year of POLYNOMIAL_JOINS) {
        svg += `<circle cx="${f(x(year))}" cy="${f(y(precise.deltaT(jdOf(year))))}" r="2.2" class="deltat-join"/>`;
    }
    for (const year of [FIRST_YEAR, -500, MEASURED_SINCE, today, LAST_YEAR]) {
        svg += `<circle cx="${f(x(year))}" cy="${f(y(precise.deltaT(jdOf(year))))}" r="3" class="deltat-bubble"/>`;
    }

    // What the curve is made of, and the one stretch where the clock ran ahead, all named in one row along the bottom,
    // where the curve only dips once.
    const row = y(-3);
    svg += svgText(x(-500) - 6, row, "parabola", "figure-label figure-anchor-end");
    svg += svgText(x(1150), row, "polynomials", "figure-label");
    svg += svgText(x(today) + 6, row, "extrapolated", "figure-label figure-anchor-start");
    svg += svgText(x(today) - 6, row, "measured", "figure-label figure-anchor-end");
    svg += svgText(x(1868) - 6, row, "below 0, 1871\u20131902", "figure-label figure-anchor-end");

    // A year marked on the curve: a line down to the years, a dot, and its ΔT beside the line, on the side with more room.
    // A year marked on the curve. The moment's label keeps to the row of the 1 h line, the same height wherever it is;
    // the hovered year's sits by its dot, on the side with more room, below it in the upper half and above it in the
    // lower one.
    const mark = (year, name, cls, labelY = null) => {
        if (year < FIRST_YEAR || year > LAST_YEAR) return "";
        const seconds = precise.deltaT(jdOf(year));
        const [mx, my] = [x(year), y(seconds)];
        const left = mx > (plot.left + plot.right) / 2;
        const label = `${name} ${duration(seconds)}`;
        const ly = labelY ?? (my < (plot.top + plot.bottom) / 2 ? my + 12 : my - 10);
        return (
            `<line x1="${f(mx)}" y1="${plot.top}" x2="${f(mx)}" y2="${plot.bottom}" class="strip-moment ${cls}"/>` +
            `<circle cx="${f(mx)}" cy="${f(my)}" r="3" class="strip-moment-dot ${cls}"/>` +
            svgText(mx + (left ? -6 : 6), ly, label, `figure-note figure-anchor-${left ? "end" : "start"} ${cls}`)
        );
    };
    // The page's moment always, the hovered year besides while there is one.
    const year = yearOf(state.jd);
    svg += mark(year, yearText(Math.floor(year)), "", y(3600));
    if (hovered !== null) svg += mark(hovered, yearText(Math.round(hovered)), "deltat-hover");
    drawSvg(svgEl, svg, 1);
}

// Hovering reads the curve off at the pointer, without touching the page's moment.
svgEl.addEventListener("pointermove", (event) => {
    const { plot, yearAt } = layout();
    const px = event.clientX - svgEl.getBoundingClientRect().left;
    hovered = px < plot.left || px > plot.right ? null : yearAt(px);
    requestRender();
});
svgEl.addEventListener("pointerleave", () => {
    hovered = null;
    requestRender();
});

onChange(requestRender);
new ResizeObserver(requestRender).observe(svgEl);
render();
