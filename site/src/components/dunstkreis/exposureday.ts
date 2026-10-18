import type { AutoExposureKey, SkyPass } from "@himmelszelt/dunstkreis";
import {
    autoExposureCompensation,
    clampObserverHeight,
    createSkyPass,
    DEFAULT_AUTO_EXPOSURE_KEYS,
} from "@himmelszelt/dunstkreis";
import type { Direction } from "@himmelszelt/sternzeit";
import { fromJulianDay, julianDayFromDate, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, LABEL_GAP, svgText } from "../sternzeit/figure";
import { onChange, state, update } from "../sternzeit/state";
import { momentOnClock } from "../sternzeit/timeofday";
import { DAY_MS, instantOf } from "../sternzeit/zone";
import { gpu, gpuDevice, onTables, quality, tables } from "./atmosphere";

// The exposure over the chosen day: the sky pass's own light meter, run by a pass of the figure's own on the page's
// tables every ten minutes of the day, then the ramp's compensation and the range applied on the CPU, as the pass does.

const DEG = Math.PI / 180;
const MINUTE_MS = 60_000;
const STEP_MINUTES = 10;
const SAMPLES = (24 * 60) / STEP_MINUTES + 1;
// Readings per submission, so the page's own frames keep their pace while a day is metered.
const CHUNK = 24;
// The pass's default `autoExposureRange`, and one wide enough to read the meter as it is.
const RANGE = [4, 20] as const;
const UNCLAMPED = [-1000, 1000] as const;
// The plot's EV100s, and the anchors a reader can picture.
const EV_AXIS = [-6, 18] as const;
const EV_TICKS = [-5, 0, 5, 10, 15];
const ANCHORS: [ev: number, label: string][] = [
    [15, "sunny day"],
    [0, "twilight"],
];
// Variant B's sun altitudes and its ramp's compensations.
const ALTITUDE_AXIS = [-18, 90] as const;
const ALTITUDE_TICKS = [-18, -6, 0, 30, 60, 90];
const COMPENSATION_AXIS = [-2.5, 1] as const;
// The daylight figure's bands, by the Sun's altitude, drawn under the hours.
const BANDS: [threshold: number, cls: string][] = [
    [6, "daylight-day"],
    [-4, "daylight-golden"],
    [-6, "daylight-blue"],
    [-12, "daylight-nautical"],
    [-18, "daylight-astronomical"],
];
const BAND_HEIGHT = 6;
const MARGIN = { top: 10, right: 8, bottom: 26 };
// The space between the meter's plot and the ramp's, and the ramp's share of the height in each variant.
const GAP = 12;
const RAMP_SHARE_A = 0.18;
const RAMP_SHARE_B = 0.34;
const HANDLE_RADIUS = 5;

const root = find("#exposure-day");
const svgEl = find<SVGSVGElement>(".exposureday-panel > svg", root);
const f = (n: number) => n.toFixed(1);
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** The day metered: per sample its minute on the clock, the Sun's direction and altitude, and the meter's EV100. */
type Day = {
    dip: number;
    minutes: number[];
    directions: Direction[];
    altitudes: number[];
    meter: number[];
};
let metered: Day | null = null;
let metering = "";

// The ramp, local to the figure: dragged in variant B, it changes this plot only.
let keys: AutoExposureKey[] = structuredClone([...DEFAULT_AUTO_EXPOSURE_KEYS]);
let variant: "a" | "b" = "a";

let pass: SkyPass | null = null;
let passFor: unknown = null;
// Counts the tables the pass was made for, so new ones meter the day anew.
let generation = 0;

function dayKey() {
    return [momentOnClock().day, state.latitude, state.longitude, state.heightM, state.timeZone, generation].join();
}

async function meterDay(pass: SkyPass, key: string, groundRadiusKm: number) {
    const { day } = momentOnClock();
    const minutes = Array.from({ length: SAMPLES }, (_, i) => i * STEP_MINUTES);
    const directions = minutes.map((m) => {
        const ms = instantOf(day * DAY_MS + m * MINUTE_MS);
        return sun.direction(fromJulianDay(julianDayFromDate(new Date(ms))), state);
    });
    // The horizon's dip below the horizontal, which the ramp's sun altitudes count from, as the pass does.
    const heightKm = clampObserverHeight(state.heightM) / 1000;
    const dip = Math.acos(groundRadiusKm / (groundRadiusKm + heightKm)) / DEG;
    const meter: number[] = [];
    pass.update({ observerHeightM: state.heightM, autoExposureKeys: [], autoExposureRange: UNCLAMPED });
    for (let start = 0; start < SAMPLES; start += CHUNK) {
        // Each reading is queued right behind its table, so a chunk needs one wait, not one per reading.
        const readings = directions.slice(start, start + CHUNK).map((sunDirection) => {
            pass.update({ sunDirection });
            return pass.meteredEV100();
        });
        // A pass destroyed for new tables fails its readings; the new one meters the day again.
        const read = await Promise.all(readings).catch(() => null);
        if (!read || metering !== key) return;
        meter.push(...read);
        await new Promise(requestAnimationFrame);
    }
    const altitudes = directions.map(([, , z]) => Math.asin(z) / DEG);
    metered = { dip, minutes, directions, altitudes, meter };
    requestRender();
}

function ensureMetered() {
    const table = tables();
    if (!gpu.device || !table) return;
    if (passFor !== table.luts) {
        passFor = table.luts;
        generation++;
        const luts = table.luts;
        pass?.destroy();
        pass = null;
        metering = "";
        // Its own pass, never drawn: only its meter is read.
        const options = { luts, format: "rgba8unorm" as const, groundLight: quality.groundLight };
        createSkyPass(gpuDevice(), options).then((next) => {
            if (passFor !== luts) return next.destroy();
            pass = next;
            requestRender();
        });
        return;
    }
    const key = dayKey();
    if (!pass || key === metering) return;
    metering = key;
    meterDay(pass, key, table.luts.model.planet.groundRadiusKm);
}

/** The day's three curves: the meter, the ramp's compensation applied, and the exposure in its range. */
function curves(day: Day) {
    const compensation = day.directions.map((d) => autoExposureCompensation(keys, d, day.dip));
    // The pass subtracts the compensation from the EV100: +1 exposes twice as bright.
    const compensated = day.meter.map((ev, i) => ev - (compensation[i] ?? 0));
    const exposure = compensated.map((ev) => clamp(ev, RANGE[0], RANGE[1]));
    return { compensation, compensated, exposure };
}

/** A value of a series at a minute of the day, between its samples. */
function at(series: number[], minutes: number) {
    const i = clamp(minutes / STEP_MINUTES, 0, SAMPLES - 1);
    const i0 = Math.min(Math.floor(i), SAMPLES - 2);
    const t = i - i0;
    return (series[i0] ?? 0) * (1 - t) + (series[i0 + 1] ?? 0) * t;
}

function path(points: [number, number][], cls: string) {
    if (points.length < 2) return "";
    return `<path d="M${points.map(([x, y]) => `${f(x)},${f(y)}`).join("L")}" class="${cls}"/>`;
}

type Box = { left: number; right: number; top: number; bottom: number };

function layout(rampShare: number) {
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 220];
    // The EV100s flush with the text's left edge, the plot after them: a sign and two monospace digits.
    const left = 1.8 * parseFloat(getComputedStyle(svgEl).fontSize) + LABEL_GAP;
    const [top, bottom] = [MARGIN.top, height - MARGIN.bottom];
    // The meter above, the ramp's compensation below, on one axis of time or of sun altitudes.
    const split = bottom - (bottom - top) * rampShare;
    const upper = { left, right: width - MARGIN.right, top, bottom: split - GAP / 2 };
    const lower = { ...upper, top: split + GAP / 2, bottom };
    return { width, height, upper, lower };
}

// The plots as last laid out, for the pointer.
let upperBox: Box = { left: 0, right: 1, top: 0, bottom: 1 };
let lowerBox: Box = { left: 0, right: 1, top: 0, bottom: 1 };
let handles: { key: number; phase: "rising" | "setting" | null; x: number; y: number }[] = [];

const minus = (n: number | string) => String(n).replace("-", "−");
const hline = (y: number, box: Box, cls = "figure-grid") =>
    `<line x1="${f(box.left)}" y1="${f(y)}" x2="${f(box.right)}" y2="${f(y)}" class="${cls}"/>`;
const vline = (x: number, top: number, bottom: number, cls = "figure-grid") =>
    `<line x1="${f(x)}" y1="${f(top)}" x2="${f(x)}" y2="${f(bottom)}" class="${cls}"/>`;

function evAxis(box: Box, [lo, hi]: readonly [number, number]) {
    const y = (ev: number) => box.bottom - ((ev - lo) / (hi - lo)) * (box.bottom - box.top);
    // Below the range's floor, the exposure never goes.
    let svg = `<rect x="${f(box.left)}" y="${f(y(RANGE[0]))}" width="${f(box.right - box.left)}" height="${f(box.bottom - y(RANGE[0]))}" class="exposureday-floor"/>`;
    for (const ev of EV_TICKS.filter((ev) => ev >= lo && ev <= hi)) {
        svg += hline(y(ev), box) + svgText(0, y(ev), minus(ev), "figure-grid-label strip-tick");
    }
    svg += svgText(box.left + 4, y(RANGE[0]) + 9, "floor", "figure-label figure-anchor-start exposureday-anchor");
    return { y, svg };
}

function rampAxis(box: Box, ticks: number[]) {
    const [c0, c1] = COMPENSATION_AXIS;
    const y = (c: number) => box.bottom - ((c - c0) / (c1 - c0)) * (box.bottom - box.top);
    let svg = "";
    for (const c of ticks) {
        svg += hline(y(c), box, c === 0 ? "exposureday-zero" : "figure-grid");
        svg += svgText(0, y(c), c > 0 ? `+${c}` : minus(c), "figure-grid-label strip-tick");
    }
    return { y, svg };
}

function clip(id: string, box: Box) {
    return `<clipPath id="${id}"><rect x="${f(box.left)}" y="${f(box.top)}" width="${f(box.right - box.left)}" height="${f(box.bottom - box.top)}"/></clipPath>`;
}

/** The moment's value next to its line, on the side with more room, at the top of the plot. */
// Roughly how wide a character of the small text is, to keep the labels apart.
const CHAR_PX = 7;

/**
 * The moment's value next to its line, on the side with more room, at the top of the plot, and the anchors at the
 * right edge, but for one it would overlap.
 */
function labels(x: number, box: Box, y: (ev: number) => number, text: string) {
    const right = x < (box.left + box.right) / 2;
    const cls = `figure-note exposureday-value figure-anchor-${right ? "start" : "end"}`;
    const lx = x + (right ? LABEL_GAP : -LABEL_GAP);
    let svg = text ? svgText(lx, box.top + 6, text, cls) : "";
    const [from, to] = right ? [lx, lx + text.length * CHAR_PX] : [lx - text.length * CHAR_PX, lx];
    for (const [ev, label] of ANCHORS) {
        const [ax, ay] = [box.right - 2, y(ev) - 7];
        if (Math.abs(ay - box.top - 6) < 14 && to > ax - label.length * CHAR_PX && from < ax) continue;
        svg += svgText(ax, ay, label, "figure-label figure-anchor-end exposureday-anchor");
    }
    return svg;
}

function renderByTime(day: Day | null) {
    const { upper, lower } = layout(RAMP_SHARE_A);
    [upperBox, lowerBox] = [upper, lower];
    const x = (minutes: number) => upper.left + (minutes / (24 * 60)) * (upper.right - upper.left);
    const ev = evAxis(upper, EV_AXIS);
    const ramp = rampAxis(lower, [-2, 0]);
    let svg = ev.svg + ramp.svg;
    // The hours, under the band of the Sun's altitude.
    const bandTop = lower.bottom + 3;
    for (const hour of [0, 6, 12, 18, 24]) {
        const hx = x(hour * 60);
        svg += vline(hx, upper.top, upper.bottom) + vline(hx, lower.top, lower.bottom);
        const anchor = hour === 0 ? "figure-anchor-start" : hour === 24 ? "figure-anchor-end" : "";
        svg += svgText(
            hx,
            bandTop + BAND_HEIGHT + 9,
            String(hour).padStart(2, "0"),
            `figure-label exposureday-tick ${anchor}`,
        );
    }
    if (!day) return svg + labels(Number.NaN, upper, ev.y, "");
    svg += `<rect x="${f(upper.left)}" y="${f(bandTop)}" width="${f(upper.right - upper.left)}" height="${BAND_HEIGHT}" class="daylight-night"/>`;
    day.altitudes.forEach((altitude, i) => {
        const band = BANDS.find(([threshold]) => altitude >= threshold);
        if (!band) return;
        const [x0, x1] = [x(Math.max(0, (i - 0.5) * STEP_MINUTES)), x(Math.min(24 * 60, (i + 0.5) * STEP_MINUTES))];
        svg += `<rect x="${f(x0)}" y="${f(bandTop)}" width="${f(x1 - x0 + 0.5)}" height="${BAND_HEIGHT}" class="${band[1]}"/>`;
    });
    const { compensation, compensated, exposure } = curves(day);
    const line = (series: number[], y: (v: number) => number) =>
        series.map((v, i): [number, number] => [x(day.minutes[i] ?? 0), y(v)]);
    svg += `${clip("exposureday-clip", upper)}<g clip-path="url(#exposureday-clip)">`;
    svg += path(line(day.meter, ev.y), "exposureday-meter");
    svg += path(line(compensated, ev.y), "exposureday-compensated");
    svg += path(line(exposure, ev.y), "exposureday-exposure");
    svg += "</g>";
    svg += path(line(compensation, ramp.y), "exposureday-ramp");
    // The moment: a line through the day, a dot on the exposure and one on the ramp, and the exposure's value.
    const minutes = momentOnClock().timeOfDay / MINUTE_MS;
    const [mx, value] = [x(minutes), at(exposure, minutes)];
    svg += vline(mx, upper.top, bandTop + BAND_HEIGHT, "strip-moment");
    svg += `<circle cx="${f(mx)}" cy="${f(ev.y(value))}" r="3.5" class="exposureday-dot"/>`;
    svg += `<circle cx="${f(mx)}" cy="${f(ramp.y(at(compensation, minutes)))}" r="3" class="exposureday-dot"/>`;
    return svg + labels(mx, upper, ev.y, `EV ${minus(value.toFixed(1))}`);
}

function renderByAltitude(day: Day | null) {
    const { upper, lower } = layout(RAMP_SHARE_B);
    [upperBox, lowerBox] = [upper, lower];
    const [a0, a1] = ALTITUDE_AXIS;
    const x = (altitude: number) => upper.left + ((altitude - a0) / (a1 - a0)) * (upper.right - upper.left);
    const ev = evAxis(upper, EV_AXIS);
    const ramp = rampAxis(lower, [-2, -1, 0]);
    let svg = ev.svg + ramp.svg;
    for (const altitude of ALTITUDE_TICKS) {
        const ax = x(altitude);
        const cls = altitude === 0 ? "exposureday-horizon" : "figure-grid";
        svg += vline(ax, upper.top, upper.bottom, cls) + vline(ax, lower.top, lower.bottom, cls);
        const anchor = altitude === a0 ? "figure-anchor-start" : altitude === a1 ? "figure-anchor-end" : "";
        svg += svgText(ax, lower.bottom + 12, `${minus(altitude)}°`, `figure-label exposureday-tick ${anchor}`);
    }

    // The ramp for the rising and the setting Sun, and its keys as handles.
    const rampCurve = (east: number) =>
        Array.from({ length: 217 }, (_, i): [number, number] => {
            const altitude = a0 + (i / 216) * (a1 - a0);
            const c = Math.cos(altitude * DEG);
            return [x(altitude), ramp.y(autoExposureCompensation(keys, [east * c, 0, Math.sin(altitude * DEG)]))];
        });
    svg += path(rampCurve(1), "exposureday-ramp");
    svg += path(rampCurve(-1), "exposureday-ramp exposureday-setting");
    handles = [];
    keys.forEach(({ sunAltitude, compensation }, k) => {
        const phases = typeof compensation === "number" ? [null] : (["rising", "setting"] as const);
        for (const phase of phases) {
            const value = typeof compensation === "number" ? compensation : compensation[phase ?? "rising"];
            const [hx, hy] = [x(sunAltitude), ramp.y(value)];
            handles.push({ key: k, phase, x: hx, y: hy });
            const cls = `exposureday-handle${phase === "setting" ? " exposureday-handle-setting" : ""}`;
            svg += `<circle cx="${f(hx)}" cy="${f(hy)}" r="${HANDLE_RADIUS}" class="${cls}"/>`;
        }
    });
    if (!day) return svg + labels(Number.NaN, upper, ev.y, "");

    const { exposure } = curves(day);
    // Each half of the day by its own Sun, as the ramp tells them: east of the meridian rising, west of it setting.
    const series = (values: number[], east: boolean) =>
        day.altitudes
            .map((altitude, i): [number, number, boolean] => [
                altitude + day.dip,
                values[i] ?? 0,
                (day.directions[i]?.[0] ?? 0) >= 0,
            ])
            .filter(([, , e]) => e === east)
            .sort(([p], [q]) => p - q)
            .map(([altitude, value]): [number, number] => [x(altitude), ev.y(value)]);
    svg += `${clip("exposureday-clip", upper)}<g clip-path="url(#exposureday-clip)">`;
    for (const east of [true, false]) {
        const setting = east ? "" : " exposureday-setting";
        svg += path(series(day.meter, east), `exposureday-meter${setting}`);
        svg += path(series(exposure, east), `exposureday-exposure${setting}`);
    }
    svg += "</g>";
    // The Sun now, by its altitude above the observer's horizon, as the ramp reads it.
    const direction = sun.direction(fromJulianDay(state.jd), state);
    const altitude = Math.asin(direction[2]) / DEG + day.dip;
    if (altitude < a0 || altitude > a1) return svg + labels(Number.NaN, upper, ev.y, "");
    const mx = x(altitude);
    const value = at(exposure, momentOnClock().timeOfDay / MINUTE_MS);
    svg += vline(mx, upper.top, lower.bottom, "strip-moment");
    svg += `<circle cx="${f(mx)}" cy="${f(ev.y(value))}" r="3.5" class="exposureday-dot"/>`;
    svg += `<circle cx="${f(mx)}" cy="${f(ramp.y(autoExposureCompensation(keys, direction, day.dip)))}" r="3" class="exposureday-dot"/>`;
    return svg + labels(mx, upper, ev.y, `EV ${minus(value.toFixed(1))}`);
}

function render() {
    ensureMetered();
    root.dataset.variant = variant;
    // The day metered last, until the next one is in.
    const svg = variant === "a" ? renderByTime(metered) : renderByAltitude(metered);
    const { width, height } = layout(0);
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    drawSvg(svgEl, svg, 1);
}

const requestRender = onDemand(render, svgEl);

// Variant A: a press or a drag on the plot sets the time of day. Variant B: a drag moves a key of the ramp up or down.
let dragging: { kind: "time" } | { kind: "key"; key: number; phase: "rising" | "setting" | null } | null = null;

function pointer(event: PointerEvent) {
    const rect = svgEl.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top] as const;
}

function setTime(px: number) {
    const minutes = Math.round(clamp((px - upperBox.left) / (upperBox.right - upperBox.left), 0, 1) * 24 * 60);
    const ms = instantOf(momentOnClock().day * DAY_MS + minutes * MINUTE_MS);
    update({ jd: Number(julianDayFromDate(new Date(ms)).toFixed(7)), live: false, animate: false });
}

function setKey(py: number) {
    if (dragging?.kind !== "key") return;
    const [c0, c1] = COMPENSATION_AXIS;
    const t = (lowerBox.bottom - py) / (lowerBox.bottom - lowerBox.top);
    const value = Math.round(clamp(c0 + t * (c1 - c0), c0, c1) * 10) / 10;
    const key = keys[dragging.key];
    if (!key) return;
    const c = key.compensation;
    key.compensation = typeof c === "number" || !dragging.phase ? value : { ...c, [dragging.phase]: value };
    resetButton?.removeAttribute("hidden");
    requestRender();
}

svgEl.addEventListener("pointerdown", (event) => {
    const [px, py] = pointer(event);
    if (variant === "a") {
        if (px < upperBox.left - 4 || px > upperBox.right + 4) return;
        dragging = { kind: "time" };
        setTime(px);
    } else {
        const near = handles.map((h) => ({ ...h, d: Math.hypot(h.x - px, h.y - py) })).sort((a, b) => a.d - b.d)[0];
        if (!near || near.d > 3 * HANDLE_RADIUS) return;
        dragging = { kind: "key", key: near.key, phase: near.phase };
    }
    svgEl.setPointerCapture(event.pointerId);
    event.preventDefault();
});
svgEl.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    const [px, py] = pointer(event);
    if (dragging.kind === "time") setTime(px);
    else setKey(py);
});
for (const type of ["pointerup", "pointercancel"]) svgEl.addEventListener(type, () => (dragging = null));

const variantButtons = root.querySelectorAll<HTMLButtonElement>("button[data-variant]");
const resetButton = root.querySelector<HTMLButtonElement>('[data-field="reset"]');
for (const button of variantButtons) {
    button.addEventListener("click", () => {
        variant = button.dataset.variant === "b" ? "b" : "a";
        for (const other of variantButtons) other.setAttribute("aria-pressed", String(other === button));
        requestRender();
    });
}
resetButton?.addEventListener("click", () => {
    keys = structuredClone([...DEFAULT_AUTO_EXPOSURE_KEYS]);
    resetButton.setAttribute("hidden", "");
    requestRender();
});

if (gpu.error) {
    svgEl.insertAdjacentHTML("afterend", `<p class="note">${gpu.error}</p>`);
} else {
    onChange(requestRender);
    onTables(requestRender);
    new ResizeObserver(requestRender).observe(svgEl);
    requestRender();
}
