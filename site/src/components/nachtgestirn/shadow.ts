import type { AtmosphereLUTs, AtmosphereModel } from "@himmelszelt/dunstkreis";
import { EARTH_RADIUS_KM, MOON_RADIUS_KM, moonEV100 } from "@himmelszelt/nachtgestirn";
import { eclipse, fromJulianDay, julianEphemerisDay, toDate } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { nearestEclipse } from "../sternzeit/eclipsesearch";
import { drawSvg, svgText } from "../sternzeit/figure";
import { clock } from "../sternzeit/zone";
import { noGpu } from "./laws";
import { ANY_PLACE, julianDayOf } from "./place";
import { type MoonAt, moonAt, onUmbraTable, type ToneCurveName } from "./renderer";
import { createTiles, pxPerRadian, tileFrame } from "./tiles";

const COUNT = 7;
const MINUTE = 1 / 1440;
const YEAR = 365.25;
// How far the timeline reaches either way from its middle, in years, and how near its ends a chosen eclipse may come
// before the strip moves along to center it.
const TIMELINE_YEARS = 12;
const TIMELINE_EDGE_YEARS = 1;
// The figure first looks from the start of New Year's Eve 2028, so it shows that evening's total eclipse.
const START = julianDayOf("2028-12-31T00:00Z");

const f = (n: number) => n.toFixed(1);
const DEG = Math.PI / 180;
const lunar = (jd: number) => eclipse.lunar(julianEphemerisDay(fromJulianDay(jd)));
const umbral = (jd: number) => lunar(jd).umbralMagnitude;

/** The first minute between a and b where `test` turns true, by halving. */
function bisect(a: number, b: number, test: (jd: number) => boolean) {
    while (b - a > MINUTE) {
        const mid = (a + b) / 2;
        if (test(mid)) b = mid;
        else a = mid;
    }
    return b;
}

/** The share of the Sun's disc Earth leaves uncovered, seen from a point `axisKm` from the shadow's axis, as
 *  surface.wgsl's ngShadow has it before the air's light is added. */
export function directSunlight(axisKm: number, distanceKm: number, sunAngularRadius: number) {
    const earthRadius = Math.asin(Math.min(EARTH_RADIUS_KM / distanceKm, 1));
    const separation = Math.atan(axisKm / distanceKm);
    const lens = (a: number, b: number, d: number) => {
        if (d >= a + b) return 0;
        const small = Math.min(a, b);
        if (d <= Math.abs(a - b)) return Math.PI * small * small;
        const x = (d * d + a * a - b * b) / (2 * d);
        const y = Math.sqrt(Math.max(a * a - x * x, 0));
        return (
            a * a * Math.acos(Math.min(Math.max(x / a, -1), 1)) +
            b * b * Math.acos(Math.min(Math.max((d - x) / b, -1), 1)) -
            d * y
        );
    };
    return 1 - lens(earthRadius, sunAngularRadius, separation) / (Math.PI * sunAngularRadius * sunAngularRadius);
}

/**
 * The lunar eclipses around the chosen moment, found once each and kept: `within(from, to)` extends the known span
 * with sternzeit's search as far as asked, a lunation at a time, umbral ones only.
 */
function eclipseList() {
    const known: { jd: number; magnitude: number }[] = [];
    let covered: { from: number; to: number } | null = null;
    const add = (jd: number) => {
        known.push({ jd, magnitude: umbral(jd) });
        known.sort((a, b) => a.jd - b.jd);
    };
    return {
        /** Whether the last `within` found all there is in its span, or ran out of its time first. */
        complete: true,
        within(from: number, to: number, budgetMs = 8) {
            const until = performance.now() + budgetMs;
            if (!covered) covered = { from: (from + to) / 2, to: (from + to) / 2 };
            // Forwards and backwards in turn, so the timeline fills out from its middle.
            let forwards = true;
            while ((covered.to < to || covered.from > from) && performance.now() < until) {
                if (forwards && covered.to < to) {
                    const next = nearestEclipse(covered.to, 1, true);
                    if (next === null || next > to) covered.to = to;
                    else {
                        add(next);
                        covered.to = next;
                    }
                } else if (covered.from > from) {
                    const previous = nearestEclipse(covered.from, -1, true);
                    if (previous === null || previous < from) covered.from = from;
                    else {
                        add(previous);
                        covered.from = previous;
                    }
                }
                forwards = !forwards;
            }
            this.complete = covered.to >= to && covered.from <= from;
            return known.filter((e) => e.jd >= from && e.jd <= to);
        },
    };
}

// The timeline strip: its height, the room over the bars for the shown eclipse's date, and under them for the years.
const TIMELINE = { height: 76, top: 22, bottom: 18 };
// The umbral magnitude the bars reach at the strip's top: the deepest eclipses come to some 1.9.
const DEEPEST = 1.9;

/** The shadow figure on `root`: the Moon through a lunar eclipse, a timeline of the eclipses around it to choose
 *  another, and a row of discs across the eclipse. It follows no moment of the page's: Earth's shadow is the same from
 *  everywhere the Moon is up. */
export function shadowFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("[data-field=row]", root);
    const timeline = find<SVGSVGElement>("[data-field=timeline]", root);
    const labels = root.querySelectorAll<HTMLElement>(".tiles-labels > li");
    const note = find("[data-field=note]", root);
    const metered = find("[data-field=metered]", root);
    const big = find<HTMLCanvasElement>("[data-field=big]", root);
    const outline = find<SVGSVGElement>("[data-field=outline]", root);
    const offset = find<HTMLInputElement>("[data-field=offset]", root);
    const offsetValue = find("[data-field=offsetValue]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    const bigTile = createTiles(big, requestRender);
    if (!tiles || !bigTile) {
        noGpu(canvas);
        noGpu(big);
    }
    const eclipses = eclipseList();
    let lastShown: number | null = null;
    // The moment the figure looks from: the next eclipse after it is shown. Moved only by the figure's own buttons and
    // timeline.
    let chosen = START;
    // The timeline's middle: the first eclipse's, and moved only when a choice comes near the strip's ends.
    let center = START;
    const recenter = (jd: number) => {
        if (Math.abs(jd - center) > (TIMELINE_YEARS - TIMELINE_EDGE_YEARS) * YEAR) center = jd;
    };
    const choose = (jd: number) => {
        recenter(jd);
        chosen = jd;
        offset.value = "0";
        paintRange(offset);
        requestRender();
    };
    // The eclipse shown: its greatest moment and the umbra's first and last contact, kept while the chosen moment stays
    // between where the search started and the eclipse's end.
    let found: { from: number; greatest: number; first: number; last: number } | null = null;

    function findEclipse() {
        const from = chosen - 0.5;
        if (found && chosen >= found.from && chosen <= found.last + 0.5) return found;
        const greatest = nearestEclipse(from, 1, true);
        if (greatest === null) {
            found = null;
            return null;
        }
        const first = bisect(greatest - 0.25, greatest, (jd) => umbral(jd) > 0);
        const last = bisect(greatest, greatest + 0.25, (jd) => umbral(jd) <= 0);
        found = { from, greatest, first, last };
        return found;
    }

    let row: { greatest: number; model: AtmosphereModel; moons: MoonAt[] } | null = null;

    function render() {
        const table = tables();
        if (!table) return;
        const e = findEclipse();
        renderTimeline(e?.greatest ?? null);
        if (!e) {
            note.textContent = `no lunar eclipse within ${TIMELINE_YEARS} years`;
            return;
        }
        const width = root.clientWidth || 600;
        const tilePx = Math.round((width / COUNT) * Math.min(window.devicePixelRatio || 1, 2));
        // The row's Moons kept while the eclipse and the air stay: each traces its refraction, too slow for every step of
        // the big Moon's slider.
        if (row?.greatest !== e.greatest || row.model !== table.luts.model) {
            const moments = Array.from({ length: COUNT }, (_, i) => e.first + ((e.last - e.first) * i) / (COUNT - 1));
            row = {
                greatest: e.greatest,
                model: table.luts.model,
                moons: moments.map((jd) => moonAt(jd, ANY_PLACE, table.luts.model)),
            };
        }
        const { moons } = row;
        const perTile = metered.getAttribute("aria-pressed") === "true";
        const first = moons[0];
        const greatest = moons[Math.floor(COUNT / 2)];
        // One exposure for the row, the uneclipsed Moon's: the sunlit part as on any night, the umbra's red barely there.
        const shared = moonEV100(greatest?.phaseAngle ?? 0, greatest?.lit ?? 1);
        tiles?.draw({ count: COUNT, width: tilePx, degreesAcross: (first?.geocentricDiameter ?? 0.5) * 1.3 }, (i) => ({
            moon: moons[i] ?? (first as NonNullable<typeof first>),
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: "auto",
            ev100: perTile ? null : shared,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: true,
            law: "hapke2012",
            nightVision: false,
        }));
        labels.forEach((label, i) => {
            const m = moons[i];
            if (!m) return;
            const { text } = clock(toDate(m.time), { hour: "2-digit", minute: "2-digit" });
            const depth = Math.min(Math.max(m.shadow.umbralMagnitude, 0), 1);
            label.innerHTML = `<span class="tiles-name">${text}</span> <span class="tiles-value">${depth >= 1 ? "total" : `umbra ${Math.round(depth * 100)}%`}</span>`;
        });
        const where = renderBig(e.greatest + Number(offset.value) * MINUTE, table.luts.model, table.luts);
        const date = clock(toDate(fromJulianDay(e.greatest)), { day: "numeric", month: "long", year: "numeric" });
        const span = clock(toDate(fromJulianDay(e.first)), { hour: "2-digit", minute: "2-digit" });
        const end = clock(toDate(fromJulianDay(e.last)), { hour: "2-digit", minute: "2-digit" });
        const depth = umbral(e.greatest);
        note.textContent =
            `${date.text}, in the umbra from ${span.text} to ${end.text} ${date.offset} · ` +
            `${depth >= 1 ? "total" : "partial"}, umbral magnitude ${depth.toFixed(2)} · the big Moon ${where} · ` +
            `${perTile ? "each disc metered on its own" : `all at EV100 ${shared.toFixed(1)}, the uneclipsed Moon's`}`;
    }

    /** The eclipses of the years around the shown one, a bar each as tall as the eclipse is deep, the shown one in the
     *  accent with its date over it. */
    function renderTimeline(shown: number | null) {
        lastShown = shown;
        const width = timeline.clientWidth || 600;
        const height = TIMELINE.height;
        timeline.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const from = center - TIMELINE_YEARS * YEAR;
        const to = center + TIMELINE_YEARS * YEAR;
        const x = (jd: number) => ((jd - from) / (to - from)) * width;
        const base = height - TIMELINE.bottom;
        const y = (magnitude: number) =>
            base - (Math.min(Math.max(magnitude, 0), DEEPEST) / DEEPEST) * (base - TIMELINE.top);
        let svg = `<line x1="0" y1="${base}" x2="${width}" y2="${base}" class="figure-grid"/>`;
        // How deep the bars reach: the line a bar crosses where the Moon is wholly in the umbra.
        svg += `<line x1="0" y1="${f(y(1))}" x2="${width}" y2="${f(y(1))}" class="timeline-total-line"/>`;
        svg += svgText(0, y(1) - 6, "total", "figure-label figure-anchor-start");
        svg += svgText(0, base - 6, "partial", "figure-label figure-anchor-start");
        // A year's first day labeled every other year, so the labels keep apart.
        const firstYear = toDate(fromJulianDay(from)).getUTCFullYear() + 1;
        for (let year = firstYear; year <= firstYear + 2 * TIMELINE_YEARS; year++) {
            const jd = (Date.UTC(year, 0, 1) - Date.UTC(2000, 0, 1, 12)) / 86_400_000 + 2_451_545;
            if (jd > to) break;
            svg += `<line x1="${f(x(jd))}" y1="${base}" x2="${f(x(jd))}" y2="${base + 3}" class="figure-grid"/>`;
            if (year % 2 === 0) svg += svgText(x(jd), height - 4, `${year}`, "figure-label");
        }
        let label = "";
        for (const e of eclipses.within(from, to)) {
            const isShown = shown !== null && Math.abs(e.jd - shown) < 0.5;
            const cls = `timeline-eclipse${isShown ? " timeline-shown" : ""}`;
            const date = clock(toDate(fromJulianDay(e.jd)), { day: "numeric", month: "long", year: "numeric" });
            const kind = e.magnitude >= 1 ? "total" : "partial";
            const title = `${date.text}: ${kind}, umbral magnitude ${e.magnitude.toFixed(2)}`;
            svg += `<g class="${cls}" data-jd="${e.jd.toFixed(5)}"><title>${title}</title><rect x="${f(x(e.jd) - 5)}" y="${TIMELINE.top}" width="10" height="${f(base - TIMELINE.top)}" class="timeline-hit"/><line x1="${f(x(e.jd))}" y1="${base}" x2="${f(x(e.jd))}" y2="${f(y(e.magnitude))}"/></g>`;
            if (isShown) {
                // Its date over the strip, kept inside it at the ends, and a pointer down to its bar.
                const anchor = x(e.jd) < 60 ? "start" : x(e.jd) > width - 60 ? "end" : "middle";
                const short = clock(toDate(fromJulianDay(e.jd)), { day: "numeric", month: "short", year: "numeric" });
                label = svgText(
                    x(e.jd),
                    8,
                    `${short.text}, ${kind}`,
                    anchor === "middle" ? "timeline-label" : `timeline-label figure-anchor-${anchor}`,
                );
                label += `<path d="M${f(x(e.jd) - 4)},${f(y(e.magnitude) - 7)}h8l-4,5z" class="timeline-pointer"/>`;
            }
        }
        svg += label;
        drawSvg(timeline, svg, 1);
        // The rest of the span found a little at a time, the timeline alone drawn again as it fills.
        if (!eclipses.complete) setTimeout(() => renderTimeline(lastShown), 0);
    }

    /** The big Moon at `jd`, metered, and the shadow's edges over it. */
    function renderBig(jd: number, model: AtmosphereModel, luts: AtmosphereLUTs) {
        const m = moonAt(jd, ANY_PLACE, model);
        const cssW = big.clientWidth || 600;
        const cssH = Math.round(cssW / 2);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        // The disc fills most of the panel's height, the shadow's edges either side.
        const across = m.geocentricDiameter * 1.8 * (cssW / cssH);
        bigTile?.draw(
            { count: 1, width: Math.round(cssW * dpr), height: Math.round(cssH * dpr), degreesAcross: across },
            () => ({
                moon: m,
                luts,
                toneMap: display.toneCurve as ToneCurveName,
                maps: "auto",
                ev100: null,
                albedo: true,
                relief: true,
                shadows: true,
                earthshine: true,
                eclipse: true,
                law: "hapke2012",
                nightVision: false,
            }),
        );
        outline.setAttribute("viewBox", `0 0 ${cssW} ${cssH}`);
        let svg = "";
        // The shadow's edges also while the Moon is still clear of them, so they are seen coming: the Moon's center from
        // Earth's, as ANY_PLACE looks, and the axis away from the Sun.
        {
            const [mx, my, mz] = m.trueDirection.map((d) => d * m.distanceKm);
            const [ax, ay, az] = m.sunDirection.map((d) => -d);
            const along = mx * ax + my * ay + mz * az;
            const v = [mx - along * ax, my - along * ay, mz - along * az];
            const { right, up } = tileFrame(m);
            const dotWith = (u: number[]) =>
                -((v[0] ?? 0) * (u[0] ?? 0) + (v[1] ?? 0) * (u[1] ?? 0) + (v[2] ?? 0) * (u[2] ?? 0));
            const scale = pxPerRadian(across, cssW) / m.distanceKm;
            const cx = cssW / 2 + dotWith(right) * scale;
            const cy = cssH / 2 - dotWith(up) * scale;
            for (const [km, cls, name] of [
                [m.shadow.penumbraRadiusKm, "shadow-penumbra", "penumbra"],
                [m.shadow.umbraRadiusKm, "shadow-umbra", "umbra"],
            ] as const) {
                const r = km * scale;
                svg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" class="${cls}"/>`;
                // Named just inside its edge, as high up as the edge is in view and clear of the Moon's disc in the middle.
                const moonPx = MOON_RADIUS_KM * scale;
                let best: [number, number] | null = null;
                for (let a = 0; a < 360; a += 3) {
                    const [lx, ly] = [cx + Math.cos(a * DEG) * (r - 12), cy + Math.sin(a * DEG) * (r - 12)];
                    const inView = lx > 36 && lx < cssW - 36 && ly > 16 && ly < cssH - 50;
                    if (inView && Math.hypot(lx - cssW / 2, ly - cssH / 2) > moonPx + 30 && (!best || ly < best[1]))
                        best = [lx, ly];
                }
                if (best) svg += svgText(best[0], best[1], name, "figure-label");
            }
        }
        drawSvg(outline, svg, 1);
        // The readout keeps one width, so the slider does not shift: the clock alone, the depth in the note.
        offsetValue.textContent = clock(toDate(m.time), { hour: "2-digit", minute: "2-digit" }).text;
        const depth = m.shadow.umbralMagnitude;
        return depth >= 1
            ? "total"
            : depth > 0
              ? `umbra ${Math.round(depth * 100)}%`
              : m.shadow.penumbralMagnitude > 0
                ? "in the penumbra"
                : "clear of the shadow";
    }

    paintRange(offset);
    offset.addEventListener("input", () => {
        paintRange(offset);
        requestRender();
    });
    // A notch of the wheel moves the moment a minute.
    offset.parentElement?.parentElement?.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            offset.value = String(Math.max(-240, Math.min(240, Number(offset.value) + Math.sign(event.deltaY))));
            paintRange(offset);
            requestRender();
        },
        { passive: false },
    );
    metered.addEventListener("click", () => {
        metered.setAttribute("aria-pressed", String(metered.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });
    // A click on an eclipse's bar goes to its greatest moment; the buttons to the one before or after the shown one.
    timeline.addEventListener("click", (event) => {
        const bar = (event.target as Element).closest?.("[data-jd]");
        const jd = Number(bar?.getAttribute("data-jd"));
        if (!bar || Number.isNaN(jd)) return;
        choose(jd - 0.25);
    });
    for (const button of root.querySelectorAll<HTMLElement>("[data-jump]")) {
        button.addEventListener("click", () => {
            const step = Number(button.dataset.jump);
            const from = found ? found.greatest + (step > 0 ? 0 : -0.5) : chosen;
            const jd = nearestEclipse(from, step, true);
            if (jd === null) return;
            choose(jd - 0.25);
        });
    }
    onTables(requestRender);
    onUmbraTable(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
