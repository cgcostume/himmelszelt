import { MOON_RADIUS_KM, surfaceCircle, surfacePoint, viewFrame } from "@himmelszelt/nachtgestirn";
import { fromDate, julianDayUT } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, svgText } from "../sternzeit/figure";
import { noGpu } from "./laws";
import { PHOTOS, type Photo } from "./photo-options";
import { type MoonAt, moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { createTiles, type TileFrame, tileFrame } from "./tiles";

// The disc's radius as a share of the square's width, and the circle both are cut to, a little wider.
const DISC = 0.42;
const CUT = DISC * 1.07;
// Craters and a sea to mark, as the IAU's Gazetteer of Planetary Nomenclature has them: selenographic longitude east
// positive and latitude, in degrees, and diameter, in km.
const MARKS: readonly [string, number, number, number][] = [
    ["Tycho", -11.22, -43.3, 85.3],
    ["Copernicus", -20.08, 9.62, 96.1],
    ["Aristarchus", -47.49, 23.73, 40.0],
    ["Plato", -9.38, 51.62, 100.7],
    ["Crisium", 59.1, 16.18, 555.9],
];
const f = (n: number) => n.toFixed(1);
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);

/**
 * The view the square shows `m` in: by night the sky's north up, by day, through the air, the zenith up, as the tiles
 * draw it. The tiles turn the view from the zenith by the axis' position angle less the parallactic angle, so a
 * position angle of 0 turns it to the sky's north.
 */
function viewOf(m: MoonAt, photo: Photo) {
    if (photo.air) {
        const { right, up, toward } = viewFrame(m.direction);
        return { moon: m, right, up, toward };
    }
    const moon = { ...m, positionAngleOfAxis: 0 };
    return { moon, ...tileFrame(moon) };
}

/** The photograph figure on `root`: photographs laid onto nachtgestirn's Moon for their moments and places, one at a time. */
export function photoFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const img = find<HTMLImageElement>("img", root);
    const pair = find<HTMLElement>(".photo-compare", root);
    const marks = find<SVGSVGElement>("[data-field=marks]", root);
    const slider = find<HTMLInputElement>("[data-field=split]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    pair.style.setProperty("--photo-cut", `${CUT * 100}%`);
    // The finest maps the GPU holds: the 8K where it takes textures that wide, else the 4K.
    const finest = (shared.device?.limits.maxTextureDimension2D ?? 0) >= 8192 ? "8k" : "4k";
    const resolution = mapResolutions(root, finest, requestRender);
    const stage = find("[data-field=stage]", root);
    const fullscreen = find("[data-field=fullscreen]", root);
    fullscreen.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () =>
        fullscreen.setAttribute("aria-pressed", String(document.fullscreenElement === stage)),
    );

    const picks = [...root.querySelectorAll<HTMLButtonElement>("[data-pick]")];
    let chosen = 0;
    const photo = () => PHOTOS[chosen] ?? (PHOTOS[0] as Photo);
    function pick(i: number) {
        chosen = i;
        img.src = photo().src;
        for (const button of picks) button.setAttribute("aria-pressed", String(Number(button.dataset.pick) === i));
        requestRender();
    }
    for (const button of picks) button.addEventListener("click", () => pick(Number(button.dataset.pick)));

    // The photograph scaled, moved and turned until its disc lies on nachtgestirn's, the square `size` pixels wide.
    function placePhoto(p: Photo, size: number) {
        const scale = (DISC * size) / (p.radius * p.width);
        Object.assign(img.style, {
            width: `${p.width}px`,
            height: `${p.height}px`,
            transform: `translate(${size / 2}px, ${size / 2}px) rotate(${p.turn}deg) scale(${scale}) translate(${-p.center[0] * p.width}px, ${-p.center[1] * p.height}px)`,
        });
    }

    // The split line, the cut, the up mark and the craters where nachtgestirn puts them, over both.
    function drawMarks(m: MoonAt, p: Photo, view: ReturnType<typeof viewOf>, size: number) {
        const at = Number(slider.value) / 100;
        const [c, r, cut] = [size / 2, DISC * size, CUT * size];
        const half = Math.sqrt(Math.max(cut * cut - (at * size - c) ** 2, 0));
        let svg = `<circle cx="${f(c)}" cy="${f(c)}" r="${f(cut)}" class="photo-cut"/>`;
        svg += `<line x1="${f(at * size)}" y1="${f(c - half)}" x2="${f(at * size)}" y2="${f(c + half)}" class="photo-split-line"/>`;
        // Which way is up, inside the cut, clear of the bar over the square.
        svg += `<line x1="${f(c)}" y1="${f(c - cut)}" x2="${f(c)}" y2="${f(c - cut + 8)}" class="photo-north-tick"/>`;
        svg += svgText(c, c - cut + 21, p.air ? "zenith" : "N", "photo-north");
        // Each rim at its true size, on the sphere, foreshortened as the disc is; only on the side facing the viewer, and
        // not too close to the limb to read.
        const onDisc = (n: readonly number[]) => [c + dot(n, view.right) * r, c - dot(n, view.up) * r] as const;
        for (const [name, longitude, latitude, diameterKm] of MARKS) {
            const { normal } = surfacePoint(
                { orientation: m.orientation, direction: m.trueDirection, sunDirection: m.moonSunDirection },
                longitude,
                latitude,
            );
            if (dot(normal, view.toward) < 0.15) continue;
            const [x, y] = onDisc(normal);
            const rim = surfaceCircle(m, longitude, latitude, diameterKm, 48).map((n) => onDisc(n).map(f).join(","));
            const across = (diameterKm / (2 * MOON_RADIUS_KM)) * r;
            svg +=
                across >= 6
                    ? `<polygon points="${rim.join(" ")}" class="photo-mark"/>`
                    : `<circle cx="${f(x)}" cy="${f(y)}" r="6" class="photo-mark"/>`;
            // Beside the rim, on its left near the right limb, where the cut would clip it.
            const left = x + Math.max(across, 6) + 80 > c + cut;
            const gap = Math.max(across, 6) + 4;
            svg += svgText(
                left ? x - gap : x + gap,
                y + 4,
                name,
                `photo-mark-label ${left ? "figure-anchor-end" : "figure-anchor-start"}`,
            );
        }
        marks.setAttribute("viewBox", `0 0 ${size} ${size}`);
        drawSvg(marks, svg, 1);
        canvas.style.clipPath = `inset(0 0 0 ${at * 100}%)`;
        find("[data-field=splitValue]", root).textContent = `${(at * 100).toFixed(0)}%`;
        paintRange(slider);
    }

    let last: { m: MoonAt; view: ReturnType<typeof viewOf> } | null = null;
    function split() {
        if (last) drawMarks(last.m, photo(), last.view, pair.clientWidth || 600);
    }

    function render() {
        const table = tables();
        if (!table) return;
        const p = photo();
        const m = moonAt(julianDayUT(fromDate(new Date(p.date))), p.place, table.luts.model);
        const size = pair.clientWidth || 600;
        const px = Math.round(size * (window.devicePixelRatio || 1));
        // Through the air the disc shows as wide as from the observer; above it, from Earth's center.
        const diameter = p.air ? m.angularDiameter : m.geocentricDiameter;
        const view = viewOf(m, p);
        const frame: TileFrame = {
            moon: view.moon,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: resolution(),
            ev100: null,
            albedo: true,
            relief: true,
            shadows: true,
            earthshine: true,
            eclipse: false,
            law: "hapke2012",
            nightVision: false,
            // Everything at its finest, whatever the disc's size: the relief displaced, the shadows soft, the maps
            // read along the footprint; the rays per pixel are the 4×MSAA switch's.
            displacementFrom: 0,
            softShadowsFrom: 0,
            filter: "anisotropic",
            ...(p.air ? { air: true } : {}),
        };
        tiles?.draw({ count: 1, width: px, degreesAcross: diameter / (2 * DISC) }, () => frame);
        placePhoto(p, size);
        last = { m, view };
        drawMarks(m, p, view, size);
        const ew = m.libration.longitude >= 0 ? "E" : "W";
        const ns = m.libration.latitude >= 0 ? "N" : "S";
        const { latitude, longitude } = p.place;
        const utc = new Date(p.date).toISOString().slice(11, 16);
        note.textContent =
            `${p.when} (${utc} UTC), ${p.where}, ${Math.abs(latitude).toFixed(2)}° ${latitude >= 0 ? "N" : "S"} ` +
            `${Math.abs(longitude).toFixed(2)}° ${longitude >= 0 ? "E" : "W"} · the Moon ${m.horizontal.altitude.toFixed(0)}° up, ` +
            `phase angle ${m.phaseAngle.toFixed(1)}°, libration ${Math.abs(m.libration.longitude).toFixed(1)}° ${ew}, ` +
            `${Math.abs(m.libration.latitude).toFixed(1)}° ${ns} · the photograph turned ${Math.abs(p.turn).toFixed(1)}° ` +
            `to match · the ${RESOLUTION_NAMES[resolution()]}`;
    }

    slider.addEventListener("input", split);
    // The line dragged on the picture itself, which full screen needs, as the slider is outside it.
    const drag = (event: PointerEvent) => {
        const box = pair.getBoundingClientRect();
        slider.value = String(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
        split();
    };
    pair.addEventListener("pointerdown", (event) => {
        pair.setPointerCapture(event.pointerId);
        drag(event);
    });
    pair.addEventListener("pointermove", (event) => {
        if (pair.hasPointerCapture(event.pointerId)) drag(event);
    });
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(pair);
    requestRender();
}
