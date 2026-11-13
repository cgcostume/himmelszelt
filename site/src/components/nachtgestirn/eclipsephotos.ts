import { eclipse, fromDate, fromJulianDay, julianDayUT, julianEphemerisDay, toDate } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, svgText, THUMB_RADIUS } from "../sternzeit/figure";
import { CLIFTON_PARK, ECLIPSE_PHOTOS, ev100Of } from "./eclipse-photos";
import { noGpu } from "./laws";
import { moonAt, onUmbraTable, type ToneCurveName } from "./renderer";
import { createTiles, type TileFrame } from "./tiles";

// The photographs are 1024 pixels square; the disc's radius as a share of a tile, the photographs' own, about.
const PHOTO_PX = 1024;
const DISC = 0.455;
// The strip under them: as many Moons across the whole eclipse, four under each photograph, eight a row on a phone.
const STRIP = 16;
const MINUTE = 1 / 1440;
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

/**
 * The eclipse photographs figure on `root`: a tile per photograph, nachtgestirn's Moon for its moment and place at its
 * exposure, and over it the photograph, scaled, moved and turned until its disc lies on the tile's, shown left of a line
 * the slider moves.
 */
export function eclipsePhotosFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>(".eclipse-photos > canvas", root);
    const slider = find<HTMLInputElement>("[data-field=split]", root);
    const cells = [...root.querySelectorAll<HTMLElement>(".eclipse-photo")];
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const moments = ECLIPSE_PHOTOS.map((p) => julianDayUT(fromDate(new Date(p.date))));
    const strip = find<HTMLElement>("[data-field=strip]", root);
    const stripCanvas = find<HTMLCanvasElement>("canvas", strip);
    const stripTiles = createTiles(stripCanvas, requestRender);
    if (!stripTiles) noGpu(stripCanvas);
    const stripNote = find("[data-field=stripNote]", root);
    const stripMarks = find<SVGSVGElement>("[data-field=stripMarks]", root);
    // The umbra's first and last contact, either side of the photographs' totality.
    const middle = moments[0] ?? 0;
    const contact = bisect(middle - 0.25, middle, (jd) => umbral(jd) > 0);
    const release = bisect(middle, middle + 0.25, (jd) => umbral(jd) <= 0);
    const stripMoments = Array.from({ length: STRIP }, (_, i) => contact + ((release - contact) * i) / (STRIP - 1));
    const hhmm = (jd: number) => toDate(fromJulianDay(jd)).toISOString().slice(11, 16);
    // Two by two on a phone, a row of four otherwise.
    const narrow = window.matchMedia("(max-width: 40rem)");
    narrow.addEventListener("change", () => requestRender());

    const knobs = find<SVGSVGElement>("[data-field=knobs]", root);
    function split() {
        const at = Number(slider.value);
        for (const cell of cells) cell.style.setProperty("--split", `${at}%`);
        // A slider's thumb on each tile's line, halfway down, but none at either end.
        const panel = canvas.parentElement?.getBoundingClientRect();
        if (panel) {
            knobs.setAttribute("viewBox", `0 0 ${panel.width.toFixed(1)} ${panel.height.toFixed(1)}`);
            const thumbs = cells.map((cell) => {
                const box = cell.getBoundingClientRect();
                const [x, y] = [box.left - panel.left + (at / 100) * box.width, box.top - panel.top + box.height / 2];
                return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${THUMB_RADIUS}" class="figure-thumb split-thumb"/>`;
            });
            drawSvg(knobs, at > 0 && at < 100 ? thumbs.join("") : "", 1);
        }
        // No line at either end, where it would stand alone on the tile's edge.
        root.querySelectorAll<HTMLElement>(".eclipse-photo-line").forEach((line) => {
            line.style.visibility = at > 0 && at < 100 ? "" : "hidden";
        });
        paintRange(slider);
    }

    function render() {
        const table = tables();
        if (!table) return;
        const columns = narrow.matches ? 2 : ECLIPSE_PHOTOS.length;
        const rows = Math.ceil(ECLIPSE_PHOTOS.length / columns);
        const tileCss = (root.clientWidth || 600) / columns;
        const tilePx = Math.round(tileCss * Math.min(window.devicePixelRatio || 1, 2));
        const panel = canvas.parentElement;
        panel?.style.setProperty("--count", String(columns));
        panel?.style.setProperty("--rows", String(rows));
        cells.forEach((cell, i) => {
            cell.style.setProperty("--col", String(i % columns));
            cell.style.setProperty("--row", String(Math.floor(i / columns)));
        });
        const moons = moments.map((jd) => moonAt(jd, CLIFTON_PARK, table.luts.model));
        const degreesAcross = (moons[0]?.geocentricDiameter ?? 0.5) / (2 * DISC);
        tiles?.draw({ count: columns, rows, width: tilePx, degreesAcross }, (i): TileFrame => {
            const m = moons[i] ?? (moons[0] as NonNullable<(typeof moons)[0]>);
            return {
                moon: m,
                luts: table.luts,
                toneMap: "clip",
                maps: "auto",
                ev100: ev100Of(ECLIPSE_PHOTOS[i]?.seconds ?? 1),
                albedo: true,
                relief: true,
                shadows: true,
                earthshine: true,
                eclipse: true,
                law: "hapke2012",
                nightVision: false,
                // Everything at its finest, as in the photo figure: the relief displaced, the maps read along the footprint.
                displacementFrom: 0,
                filter: "anisotropic",
            };
        });
        // Each photograph's disc onto its tile's, as scripts/photo-fit.mjs fits it: the same radius, its center on the
        // tile's, turned as the frames are.
        ECLIPSE_PHOTOS.forEach((p, i) => {
            const img = cells[i]?.querySelector("img");
            if (!img) return;
            const scale = (DISC * tileCss) / p.radius;
            Object.assign(img.style, {
                width: `${PHOTO_PX}px`,
                height: `${PHOTO_PX}px`,
                transform: `translate(${tileCss / 2}px, ${tileCss / 2}px) rotate(${p.turn}deg) scale(${scale}) translate(${-p.center[0]}px, ${-p.center[1]}px)`,
                // Faded out just past the disc, so neither the photograph's sky nor the square's turned corners show.
                maskImage: `radial-gradient(circle at ${p.center[0]}px ${p.center[1]}px, #000 ${(p.radius * 1.005).toFixed(1)}px, transparent ${(p.radius * 1.03).toFixed(1)}px)`,
            });
        });
        split();

        const stripColumns = narrow.matches ? STRIP / 2 : STRIP;
        const stripRows = STRIP / stripColumns;
        strip.style.setProperty("--count", String(stripColumns));
        strip.style.setProperty("--rows", String(stripRows));
        const stripPx = Math.round(
            ((root.clientWidth || 600) / stripColumns) * Math.min(window.devicePixelRatio || 1, 2),
        );
        const stripMoons = stripMoments.map((jd) => moonAt(jd, CLIFTON_PARK, table.luts.model));
        const across = (stripMoons[0]?.geocentricDiameter ?? 0.5) * 1.15;
        stripTiles?.draw({ count: stripColumns, rows: stripRows, width: stripPx, degreesAcross: across }, (i) => ({
            moon: stripMoons[i] ?? (stripMoons[0] as NonNullable<(typeof stripMoons)[0]>),
            luts: table.luts,
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
        }));
        markStrip(stripColumns, stripRows);
        const step = Math.round((release - contact) / (STRIP - 1) / MINUTE);
        stripNote.textContent = `every ${step} minutes from ${hhmm(contact)} to ${hhmm(release)} UTC, the umbra's first contact to its last`;
    }

    // The photographs' moments on the strip, dashed through their row where the time between the Moons puts them, each
    // named once by its time, the two of 04:12 by one mark.
    function markStrip(columns: number, rows: number) {
        const box = strip.getBoundingClientRect();
        const [w, h] = [box.width || 600, box.height || 40];
        const [tileW, tileH] = [w / columns, h / rows];
        let svg = "";
        for (const jd of new Set(moments)) {
            const at = ((jd - contact) / (release - contact)) * (STRIP - 1);
            const row = Math.min(Math.floor((at + 0.5) / columns), rows - 1);
            const x = (at - row * columns + 0.5) * tileW;
            const [top, bottom] = [row * tileH + 2, (row + 1) * tileH - 2];
            svg += `<line x1="${x.toFixed(1)}" y1="${top.toFixed(1)}" x2="${x.toFixed(1)}" y2="${bottom.toFixed(1)}" class="figure-outline"/>`;
            // On the side of the line with more of its tile, clear of the lines between the tiles.
            const right = x % tileW < tileW / 2;
            svg += svgText(
                right ? x + 3 : x - 3,
                top + 10,
                hhmm(jd),
                `figure-note ${right ? "figure-anchor-start" : "figure-anchor-end"}`,
            );
        }
        stripMarks.setAttribute("viewBox", `0 0 ${w.toFixed(1)} ${h.toFixed(1)}`);
        drawSvg(stripMarks, svg, 1);
    }

    slider.addEventListener("input", split);
    // The lines dragged on the photographs themselves, by where the pointer is in the tile it went down on.
    let held: HTMLElement | null = null;
    const drag = (event: PointerEvent) => {
        const box = held?.getBoundingClientRect();
        if (!box) return;
        slider.value = String(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
        split();
    };
    const panel = canvas.parentElement as HTMLElement;
    panel.addEventListener("pointerdown", (event) => {
        if ((event.target as Element).closest("button")) return;
        held =
            cells.find((cell) => {
                const b = cell.getBoundingClientRect();
                return (
                    event.clientX >= b.left &&
                    event.clientX <= b.right &&
                    event.clientY >= b.top &&
                    event.clientY <= b.bottom
                );
            }) ?? null;
        if (!held) return;
        event.preventDefault();
        panel.setPointerCapture(event.pointerId);
        drag(event);
    });
    panel.addEventListener("pointermove", (event) => {
        if (panel.hasPointerCapture(event.pointerId)) drag(event);
    });
    onTables(requestRender);
    onUmbraTable(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
