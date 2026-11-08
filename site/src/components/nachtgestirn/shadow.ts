import type { AtmosphereLUTs, AtmosphereModel } from "@himmelszelt/dunstkreis";
import { EARTH_RADIUS_KM, MOON_RADIUS_KM, moonEV100, typicalUmbra, umbraLightAt } from "@himmelszelt/nachtgestirn";
import { eclipse, fromJulianDay, julianEphemerisDay, toDate } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { nearestEclipse } from "../sternzeit/eclipsesearch";
import { drawSvg, svgText } from "../sternzeit/figure";
import { onChange, state, update } from "../sternzeit/state";
import { clock } from "../sternzeit/zone";
import { noGpu } from "./laws";
import { moonAt, onUmbraTable, type ToneCurveName, umbraTable } from "./renderer";
import { createTiles, pxPerRadian, tileFrame } from "./tiles";

const COUNT = 7;
const MINUTE = 1 / 1440;
const YEAR = 365.25;
// How far the timeline reaches either way from its middle, in years, and the years at each end where choosing an
// eclipse moves the strip along.
const TIMELINE_YEARS = 12;
const TIMELINE_EDGE_YEARS = 2;

const f = (n: number) => n.toFixed(1);
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
 *  surface.wgsl's nbShadow has it before the air's light is added. */
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

const BOTTOM = -18;
const MARGIN = { top: 10, bottom: 22, left: 34, right: 8 };
// The timeline strip: its height, and the room its labels take under it.
const TIMELINE = { height: 54, top: 6, bottom: 18 };

/** The shadow figure on `root`: the Moon through the next lunar eclipse, a timeline of the eclipses around the chosen
 *  moment, a row of discs across the eclipse, and the shadow's light by the radius. */
export function shadowFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("[data-field=row]", root);
    const plot = find<SVGSVGElement>(".tiles-plot > svg", root);
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
    // The timeline's middle: the chosen moment when the figure is made, and after a jump to its ends, never by itself.
    let center = state.jd;
    const recenter = (jd: number) => {
        if (Math.abs(jd - center) > (TIMELINE_YEARS - TIMELINE_EDGE_YEARS) * YEAR) center = jd;
    };
    // The eclipse shown: its greatest moment and the umbra's first and last contact, kept while the chosen moment stays
    // between where the search started and the eclipse's end.
    let found: { from: number; greatest: number; first: number; last: number } | null = null;

    function findEclipse() {
        const from = state.jd - 0.5;
        if (found && state.jd >= found.from && state.jd <= found.last + 0.5) return found;
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

    function render() {
        const table = tables();
        if (!table) return;
        const e = findEclipse();
        renderTimeline(e?.greatest ?? null);
        if (!e) {
            note.textContent = `no lunar eclipse within ${TIMELINE_YEARS} years after the chosen moment`;
            return;
        }
        const width = root.clientWidth || 600;
        const tilePx = Math.round((width / COUNT) * Math.min(window.devicePixelRatio || 1, 2));
        const moments = Array.from({ length: COUNT }, (_, i) => e.first + ((e.last - e.first) * i) / (COUNT - 1));
        const moons = moments.map((jd) => moonAt(jd, state, table.luts.model));
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
            law: "hapke",
            nightVision: false,
        }));
        labels.forEach((label, i) => {
            const m = moons[i];
            if (!m) return;
            const { text } = clock(toDate(m.time), { hour: "2-digit", minute: "2-digit" });
            const depth = Math.min(Math.max(m.shadow.umbralMagnitude, 0), 1);
            label.innerHTML = `<span class="tiles-name">${text}</span> <span class="tiles-value">${depth >= 1 ? "total" : `umbra ${Math.round(depth * 100)}%`}</span>`;
        });
        if (greatest) renderPlot(greatest);
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

    /** The eclipses of the years around the chosen moment, a bar each as tall as the eclipse is deep. */
    function renderTimeline(shown: number | null) {
        lastShown = shown;
        const width = timeline.clientWidth || 600;
        const height = TIMELINE.height;
        timeline.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const from = center - TIMELINE_YEARS * YEAR;
        const to = center + TIMELINE_YEARS * YEAR;
        const x = (jd: number) => ((jd - from) / (to - from)) * width;
        const base = height - TIMELINE.bottom;
        let svg = `<line x1="0" y1="${base}" x2="${width}" y2="${base}" class="figure-grid"/>`;
        // The ends, where a choice carries the strip along, dimmed and named.
        const edge = (TIMELINE_EDGE_YEARS / (2 * TIMELINE_YEARS)) * width;
        svg += `<rect x="0" y="0" width="${f(edge)}" height="${base}" class="timeline-edge"/>`;
        svg += `<rect x="${f(width - edge)}" y="0" width="${f(edge)}" height="${base}" class="timeline-edge"/>`;
        svg += svgText(4, TIMELINE.top + 8, "earlier", "figure-grid-label figure-anchor-start");
        svg += svgText(width - 4, TIMELINE.top + 8, "later", "figure-grid-label figure-anchor-end");
        // A year's first day labeled every other year, so the labels keep apart.
        const firstYear = toDate(fromJulianDay(from)).getUTCFullYear() + 1;
        for (let year = firstYear; year <= firstYear + 2 * TIMELINE_YEARS; year++) {
            const jd = (Date.UTC(year, 0, 1) - Date.UTC(2000, 0, 1, 12)) / 86_400_000 + 2_451_545;
            if (jd > to) break;
            svg += `<line x1="${f(x(jd))}" y1="${base}" x2="${f(x(jd))}" y2="${base + 3}" class="figure-grid"/>`;
            if (year % 2 === 0) svg += svgText(x(jd), height - 4, `${year}`, "figure-grid-label");
        }
        for (const e of eclipses.within(from, to)) {
            const depth = Math.min(Math.max(e.magnitude, 0), 1.9) / 1.9;
            const top = base - TIMELINE.top - depth * (base - TIMELINE.top - 4);
            const cls = `timeline-eclipse${e.magnitude >= 1 ? " timeline-total" : ""}${shown !== null && Math.abs(e.jd - shown) < 0.5 ? " timeline-shown" : ""}`;
            const date = clock(toDate(fromJulianDay(e.jd)), { day: "numeric", month: "long", year: "numeric" });
            const title = `${date.text}: ${e.magnitude >= 1 ? "total" : "partial"}, umbral magnitude ${e.magnitude.toFixed(2)}`;
            svg += `<g class="${cls}" data-jd="${e.jd.toFixed(5)}"><title>${title}</title><rect x="${f(x(e.jd) - 5)}" y="${TIMELINE.top}" width="10" height="${f(base - TIMELINE.top)}" class="timeline-hit"/><line x1="${f(x(e.jd))}" y1="${base}" x2="${f(x(e.jd))}" y2="${f(top)}"/></g>`;
        }
        if (state.jd >= from && state.jd <= to) {
            svg += `<line x1="${f(x(state.jd))}" y1="${TIMELINE.top}" x2="${f(x(state.jd))}" y2="${base}" class="plot-now"/>`;
        }
        drawSvg(timeline, svg, 1);
        // The rest of the span found a little at a time, the timeline alone drawn again as it fills.
        if (!eclipses.complete) setTimeout(() => renderTimeline(lastShown), 0);
    }

    /** The big Moon at `jd`, metered, and the shadow's edges over it. */
    function renderBig(jd: number, model: AtmosphereModel, luts: AtmosphereLUTs) {
        const m = moonAt(jd, state, model);
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
                law: "hapke",
                nightVision: false,
            }),
        );
        outline.setAttribute("viewBox", `0 0 ${cssW} ${cssH}`);
        let svg = "";
        const shadow = m.earthShadow;
        if (shadow) {
            // From the shadow's axis to the Moon's center, the part of the center's vector across the axis; the shadow's
            // center is that far the other way, projected onto the tile's right and up.
            const [mx, my, mz] = shadow.moonCenterKm;
            const [ax, ay, az] = shadow.axis;
            const along = mx * ax + my * ay + mz * az;
            const v = [mx - along * ax, my - along * ay, mz - along * az];
            const { right, up } = tileFrame(m);
            const dotWith = (u: number[]) =>
                -((v[0] ?? 0) * (u[0] ?? 0) + (v[1] ?? 0) * (u[1] ?? 0) + (v[2] ?? 0) * (u[2] ?? 0));
            const scale = pxPerRadian(across, cssW) / m.distanceKm;
            const cx = cssW / 2 + dotWith(right) * scale;
            const cy = cssH / 2 - dotWith(up) * scale;
            for (const [km, cls, name] of [
                [shadow.penumbraKm, "shadow-outline", "penumbra"],
                [shadow.umbraKm, "shadow-outline", "umbra"],
            ] as const) {
                const r = km * scale;
                svg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" class="${cls}"/>`;
                // Named where its edge is nearest the panel's center, so the name stays in view.
                const toCenter = Math.atan2(cssH / 2 - cy, cssW / 2 - cx);
                const [lx, ly] = [cx + Math.cos(toCenter) * (r + 10), cy + Math.sin(toCenter) * (r + 10)];
                svg += svgText(lx, ly, name, "figure-note");
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

    function renderPlot(m: ReturnType<typeof moonAt>) {
        const width = plot.clientWidth || 600;
        const height = plot.clientHeight || 180;
        plot.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const { umbraRadiusKm, penumbraRadiusKm } = m.shadow;
        const reach = penumbraRadiusKm * 1.08;
        const x = (km: number) => MARGIN.left + (km / reach) * (width - MARGIN.left - MARGIN.right);
        const y = (s: number) => MARGIN.top + (Math.max(s, BOTTOM) / BOTTOM) * (height - MARGIN.top - MARGIN.bottom);
        const stops = (v: number) => Math.log2(Math.max(v, 1e-9));
        let svg = "";
        for (let s = 0; s >= BOTTOM; s -= 3) {
            svg += `<line x1="${f(MARGIN.left)}" y1="${f(y(s))}" x2="${f(width - MARGIN.right)}" y2="${f(y(s))}" class="figure-grid"/>`;
            svg += svgText(MARGIN.left - 6, y(s), `${s}`, "figure-grid-label figure-anchor-end");
        }
        for (const km of [0, 2000, 4000, 6000, 8000]) {
            svg += svgText(x(km), height - 6, km === 0 ? "axis" : `${km.toLocaleString("en-US")} km`, "figure-label");
        }
        const sunRadius = (m.sunAngularDiameter / 2) * (Math.PI / 180);
        // The typical umbra until this eclipse's own is integrated.
        const table = umbraTable(m.model, umbraRadiusKm, penumbraRadiusKm, m.distanceKm) ?? typicalUmbra();
        const samples = Array.from({ length: 241 }, (_, i) => {
            const km = (i / 240) * reach;
            const direct = directSunlight(km, m.distanceKm, sunRadius);
            const air = umbraLightAt(table, km, penumbraRadiusKm);
            return { km, light: air.map((a) => Math.max(direct + a, 0)) };
        });
        for (const [channel, cls] of [
            [2, "plot-line-blue"],
            [1, "plot-line-green"],
            [0, "plot-line-red"],
        ] as const) {
            const points = samples.map((s) => `${f(x(s.km))},${f(y(stops(s.light[channel] ?? 0)))}`).join(" ");
            svg += `<polyline points="${points}" class="plot-line ${cls}"/>`;
        }
        for (const [km, name] of [
            [umbraRadiusKm, "umbra"],
            [penumbraRadiusKm, "penumbra"],
        ] as const) {
            svg += `<line x1="${f(x(km))}" y1="${f(MARGIN.top)}" x2="${f(x(km))}" y2="${f(y(BOTTOM))}" class="plot-mark"/>`;
            svg += svgText(x(km) - 4, MARGIN.top + 10, name, "figure-note figure-anchor-end");
        }
        // The Moon's own width, for scale, and where its center stands at the chosen moment if it is in the shadow.
        const barY = y(BOTTOM) - 6;
        svg += `<line x1="${f(x(0))}" y1="${f(barY)}" x2="${f(x(2 * MOON_RADIUS_KM))}" y2="${f(barY)}" class="plot-bar"/>`;
        svg += svgText(x(2 * MOON_RADIUS_KM) + 4, barY, "the Moon's width", "figure-note figure-anchor-start");
        const now = lunar(state.jd);
        if (now.penumbralMagnitude > 0) {
            const px = x(now.axisOffsetKm);
            svg += `<line x1="${f(px)}" y1="${f(MARGIN.top)}" x2="${f(px)}" y2="${f(y(BOTTOM))}" class="plot-now"/>`;
            svg += svgText(px + 4, MARGIN.top + 24, "the Moon's center now", "figure-note figure-anchor-start");
        }
        drawSvg(plot, svg, 1);
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
        recenter(jd);
        update({ jd, live: false, animate: false });
    });
    for (const button of root.querySelectorAll<HTMLElement>("[data-jump]")) {
        button.addEventListener("click", () => {
            const step = Number(button.dataset.jump);
            const from = found ? found.greatest + (step > 0 ? 0 : -0.5) : state.jd;
            const jd = nearestEclipse(from, step, true);
            if (jd === null) return;
            recenter(jd);
            update({ jd, live: false, animate: false });
        });
    }
    onChange(requestRender);
    onTables(requestRender);
    onUmbraTable(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
