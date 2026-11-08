import type { AtmosphereLUTs, AtmosphereModel } from "@himmelszelt/dunstkreis";
import { EARTH_RADIUS_KM, MOON_RADIUS_KM, moonEV100 } from "@himmelszelt/nachtgestirn";
import { eclipse, fromJulianDay, julianEphemerisDay, toDate } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { nearestEclipse, SEARCH_YEARS } from "../sternzeit/eclipsesearch";
import { drawSvg, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { clock } from "../sternzeit/zone";
import { moonAt, type ToneCurveName } from "./renderer";
import { createTiles, pxPerRadian, tileFrame } from "./tiles";

const COUNT = 7;
const MINUTE = 1 / 1440;
// The umbra's light exposed as the lit Moon is: a ten thousandth of the sunlight, the lit part burning out.
const UMBRA_EV100 = moonEV100(0, 1, 1e-4);
const f = (n: number) => n.toFixed(1);
const umbral = (jd: number) => eclipse.lunar(julianEphemerisDay(fromJulianDay(jd))).umbralMagnitude;

/** The first minute between a and b where `test` turns true, by halving. */
function bisect(a: number, b: number, test: (jd: number) => boolean) {
    while (b - a > MINUTE) {
        const mid = (a + b) / 2;
        if (test(mid)) b = mid;
        else a = mid;
    }
    return b;
}

/** The sunlight reaching a point `axisKm` from the shadow's axis, per channel, as surface.wgsl's nbShadow has it. */
export function shadowLight(axisKm: number, distanceKm: number, umbraKm: number, sunAngularRadius: number) {
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
    const direct =
        1 - lens(earthRadius, sunAngularRadius, separation) / (Math.PI * sunAngularRadius * sunAngularRadius);
    const depth = axisKm / Math.max(umbraKm, 1);
    const smooth = (a: number, b: number, t: number) => {
        const u = Math.min(Math.max((t - a) / (b - a), 0), 1);
        return u * u * (3 - 2 * u);
    };
    if (depth > 1.5) return [direct, direct, direct];
    const d1 = Math.min(depth, 1);
    const amount = 1e-5 * 10 ** (1.5 * d1 * d1) * (1 - smooth(1, 1.5, depth));
    const t = smooth(0.8, 1.05, depth);
    const copper = [1, 0.32, 0.1];
    const rim = [0.55, 0.8, 1];
    return copper.map((c, i) => direct + (c * (1 - t) + (rim[i] ?? 0) * t) * amount);
}

const BOTTOM = -18;
const MARGIN = { top: 10, bottom: 22, left: 34, right: 8 };

/** The shadow figure on `root`: a row of Moons through the next lunar eclipse, and the shadow's light by the radius. */
export function shadowFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const plot = find<SVGSVGElement>(".tiles-plot > svg", root);
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
        const error = document.createElement("p");
        error.className = "tiles-empty";
        error.textContent = shared.error ?? "WebGPU is not available here.";
        canvas.replaceWith(error);
        big.replaceWith(error.cloneNode(true));
    }
    // The eclipse found last: its greatest moment and the umbra's first and last contact, kept while the chosen
    // moment stays between where the search started and the eclipse's end.
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
        if (!e) {
            note.textContent = `no lunar eclipse within ${SEARCH_YEARS} years after the chosen moment`;
            return;
        }
        const width = root.clientWidth || 600;
        const tilePx = Math.round((width / COUNT) * Math.min(window.devicePixelRatio || 1, 2));
        const moments = Array.from({ length: COUNT }, (_, i) => e.first + ((e.last - e.first) * i) / (COUNT - 1));
        const moons = moments.map((jd) => moonAt(jd, state, table.luts.model));
        const perTile = metered.getAttribute("aria-pressed") === "true";
        const first = moons[0];
        const greatest = moons[Math.floor(COUNT / 2)];
        // One exposure for the row: the umbra's own where the eclipse is total, else the greatest moment's, metered on
        // what the umbra leaves of the lit disc, so a shallow bite still shows.
        const total = (greatest?.shadow.umbralMagnitude ?? 0) >= 1;
        const shared = total
            ? UMBRA_EV100
            : moonEV100(
                  greatest?.phaseAngle ?? 0,
                  greatest?.lit ?? 1,
                  Math.max(1 - Math.max(greatest?.shadow.umbralMagnitude ?? 0, 0), 1e-4),
              );
        tiles?.draw(COUNT, tilePx, (first?.geocentricDiameter ?? 0.5) * 1.12, (i) => ({
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
        renderBig(e.greatest + Number(offset.value) * MINUTE, table.luts.model, table.luts);
        const date = clock(toDate(fromJulianDay(e.greatest)), { day: "numeric", month: "long", year: "numeric" });
        const span = clock(toDate(fromJulianDay(e.first)), { hour: "2-digit", minute: "2-digit" });
        const end = clock(toDate(fromJulianDay(e.last)), { hour: "2-digit", minute: "2-digit" });
        const depth = umbral(e.greatest);
        note.textContent =
            `${date.text}, in the umbra from ${span.text} to ${end.text} ${date.offset} · ` +
            `${depth >= 1 ? "total" : "partial"}, umbral magnitude ${depth.toFixed(2)} · ` +
            `${perTile ? "each disc metered on its own" : `all at EV100 ${shared.toFixed(1)}, ${total ? "the umbra's" : "the greatest moment's"}`}`;
    }

    /** The big Moon at `jd`, metered, and the shadow's edges over it. */
    function renderBig(jd: number, model: AtmosphereModel, luts: AtmosphereLUTs) {
        const m = moonAt(jd, state, model);
        const cssPx = big.clientWidth || 480;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const across = m.geocentricDiameter * 1.7;
        bigTile?.draw(1, Math.round(cssPx * dpr), across, () => ({
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
        }));
        outline.setAttribute("viewBox", `0 0 ${cssPx} ${cssPx}`);
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
            const scale = pxPerRadian(across, cssPx) / m.distanceKm;
            const cx = cssPx / 2 + dotWith(right) * scale;
            const cy = cssPx / 2 - dotWith(up) * scale;
            for (const [km, cls, name] of [
                [shadow.penumbraKm, "shadow-outline shadow-outline-penumbra", "penumbra"],
                [shadow.umbraKm, "shadow-outline", "umbra"],
            ] as const) {
                const r = km * scale;
                svg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" class="${cls}"/>`;
                // Named where its edge is nearest the panel's center, so the name stays in view.
                const toCenter = Math.atan2(cssPx / 2 - cy, cssPx / 2 - cx);
                const [lx, ly] = [cx + Math.cos(toCenter) * (r + 10), cy + Math.sin(toCenter) * (r + 10)];
                svg += svgText(lx, ly, name, "figure-note");
            }
        }
        drawSvg(outline, svg, 1);
        const { text, offset: zone } = clock(toDate(m.time), { hour: "2-digit", minute: "2-digit" });
        const depth = m.shadow.umbralMagnitude;
        offsetValue.textContent = `${text} ${zone} · ${depth >= 1 ? "total" : depth > 0 ? `umbra ${Math.round(depth * 100)}%` : m.shadow.penumbralMagnitude > 0 ? "penumbra" : "clear"}`;
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
        const samples = Array.from({ length: 241 }, (_, i) => {
            const km = (i / 240) * reach;
            return { km, light: shadowLight(km, m.distanceKm, umbraRadiusKm, sunRadius) };
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
        const now = eclipse.lunar(julianEphemerisDay(fromJulianDay(state.jd)));
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
    onChange(requestRender);
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
