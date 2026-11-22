import { MOON_MAPS, MOON_ROUGHNESS } from "@himmelszelt/nachtgestirn";
import { fromJulianDay, julianEphemerisDay, moon } from "@himmelszelt/sternzeit";
import { find, fixed } from "../dom";
import { save } from "../dunstkreis/download";
import { figureInfo } from "../figure-info";
import { onDemand } from "../frame";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";

const DEG = Math.PI / 180;
// The librations' reach, in degrees of longitude and latitude: what Earth ever sees, some 59% of the Moon.
const REACH = { longitude: 7.9, latitude: 6.7 };
// Past that edge, as `seenFade` in the package's `scripts/common.mjs` makes the seen maps: the daily libration's slack,
// then the margin before they fade, the color into its mean and the relief to none, and the feather it takes.
const SLACK = 1.25;
const MARGIN = 2;
const FEATHER = 4;
// What the librations ever show: a point within a quarter turn of the mean sub-Earth point, and as far again past it as
// the librations reach towards it. Longitude and latitude swing over different months, so over the years every pair
// within reach comes round: the support of a rectangle, not an ellipse, or a limb at both near their ends crosses it.
const reachTowards = (psi: number) =>
    (REACH.longitude * Math.abs(Math.cos(psi)) + REACH.latitude * Math.abs(Math.sin(psi))) * DEG;
// The edge of it, or a curve `beyond` degrees past it, as longitude and latitude, from the south pole's side round the
// east and back, and round the west.
function everEdge(east: boolean, beyond = 0) {
    const points: [number, number][] = [];
    for (let i = 0; i <= 180; i++) {
        const psi = ((east ? -90 : 270) + (east ? i : -i)) * DEG;
        const d = Math.PI / 2 + reachTowards(psi) + beyond * DEG;
        const p = [Math.cos(d), Math.sin(d) * Math.cos(psi), Math.sin(d) * Math.sin(psi)];
        let lon = Math.atan2(p[1] ?? 0, p[0] ?? 0);
        // Over the pole the edge lies on the far meridian, on its own side of the map.
        if (Math.abs(Math.abs(lon) - Math.PI) < 1e-6) lon = east ? Math.PI : -Math.PI;
        points.push([lon, Math.asin(Math.max(-1, Math.min(1, p[2] ?? 0)))]);
    }
    return points;
}

// The hatches as canvas patterns, a diagonal line every `period` pixels: drawn by the canvas inside a clip, not per pixel.
function hatch(context: CanvasRenderingContext2D, period: number, line: number, ink: number[], alpha: number) {
    const tile = document.createElement("canvas");
    Object.assign(tile, { width: period, height: period });
    const t = tile.getContext("2d");
    if (!t) return null;
    const pixels = t.createImageData(period, period);
    for (let y = 0; y < period; y++)
        for (let x = 0; x < period; x++)
            if ((x + y) % period < line) pixels.data.set([...ink, alpha], (y * period + x) * 4);
    t.putImageData(pixels, 0, 0);
    return context.createPattern(tile, "repeat");
}

const drawnFor = new WeakMap<HTMLCanvasElement, string>();

// The ink the overlay draws in and the halo round its labels: dark over the maps, light over the roughness' dark fill.
const INKS = { dark: [20, 22, 28], light: [236, 238, 242] };

/**
 * Over a map on `canvas`, with Earth over `subEarth`, longitude and latitude in degrees, the moment faintly: the limb as
 * a line, hatched what Earth does not see, sparsely what is turned away now, densely what no libration ever shows; and,
 * `annotated`, over it where the seen maps fade, the color into its mean, the relief to none: the edge of what Earth ever sees with the daily
 * libration, the margin past it and the feather, labeled in `family` on the east, `fill` naming what the maps hold past the feather, in `light` ink over a dark one. All are bounded by curves known
 * in closed form, so the canvas fills them inside a clip; nothing is redrawn while neither the size nor the librations
 * change.
 */
function drawSeen(
    canvas: HTMLCanvasElement,
    subEarth: { longitude: number; latitude: number },
    annotated: boolean,
    family: string,
    fill: string,
    light: boolean,
) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (width === 0 || height === 0) return;
    const key = `${width} ${height} ${subEarth.longitude.toFixed(2)} ${subEarth.latitude.toFixed(2)} ${annotated} ${fill} ${light}`;
    if (drawnFor.get(canvas) === key) return;
    drawnFor.set(canvas, key);
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const context = canvas.getContext("2d");
    if (!context) return;
    const ink = light ? INKS.light : INKS.dark;
    const INK = ink.join(", ");
    const HALO = light ? "rgba(0, 0, 0, 0.75)" : "rgba(255, 255, 255, 0.75)";
    context.clearRect(0, 0, width, height);
    const period = 2 * Math.round(4 * ratio);
    const line = Math.max(1, Math.round(ratio));
    const px = (lon: number) => (lon / (2 * Math.PI) + 0.5) * width;
    const py = (lat: number) => (0.5 - lat / Math.PI) * height;
    // A curve `beyond` degrees past the edge of what is ever seen, east or west, in pixels.
    const curve = (east: boolean, beyond = 0) =>
        everEdge(east, beyond).map(([lon, lat]) => [px(lon), py(lat)] as const);
    // The part of the map past such a curve, east and west, closed along the far meridian.
    const past = (beyond = 0, path = new Path2D()) => {
        for (const east of [true, false]) {
            for (const [i, [x, y]] of curve(east, beyond).entries()) {
                if (i === 0) path.moveTo(x, y);
                else path.lineTo(x, y);
            }
            path.closePath();
        }
        return path;
    };
    const stroke = (beyond: number, alpha: number, lineWidth: number, dash: number[] = []) => {
        Object.assign(context, { strokeStyle: `rgba(${INK}, ${alpha})`, lineWidth: lineWidth * ratio });
        context.setLineDash(dash.map((d) => d * ratio));
        for (const east of [true, false]) {
            const path = new Path2D();
            for (const [i, [x, y]] of curve(east, beyond).entries()) {
                if (i === 0) path.moveTo(x, y);
                else path.lineTo(x, y);
            }
            context.stroke(path);
        }
        context.setLineDash([]);
    };
    // The limb: the great circle a quarter turn from the point under Earth, through every longitude; Earth's side of it
    // lies above it with Earth over the north, below with Earth over the south.
    const tanB = Math.tan(subEarth.latitude * DEG) || 1e-9;
    const limb = new Path2D();
    for (let x = 0; x <= width; x++) {
        const lat = Math.atan(-Math.cos((x / width - 0.5) * 2 * Math.PI - subEarth.longitude * DEG) / tanB);
        if (x === 0) limb.moveTo(x, py(lat));
        else limb.lineTo(x, py(lat));
    }
    // The moment, clear alone and faint under the annotations: hatched what Earth does not see now, densely what it never
    // sees, and the limb as a line.
    const hidden = new Path2D(limb);
    const edge = tanB > 0 ? height : 0;
    hidden.lineTo(width, edge);
    hidden.lineTo(0, edge);
    hidden.closePath();
    for (const [region, step, alpha] of [
        [hidden, period, annotated ? 25 : 70],
        [past(), period / 2, annotated ? 40 : 100],
    ] as const) {
        const pattern = hatch(context, step, line, ink, alpha);
        if (!pattern) continue;
        context.save();
        context.clip(region);
        context.fillStyle = pattern;
        context.fillRect(0, 0, width, height);
        context.restore();
    }
    Object.assign(context, {
        strokeStyle: `rgba(${INK}, ${annotated ? 0.4 : 0.85})`,
        lineWidth: (annotated ? 1 : 2) * ratio,
    });
    context.stroke(limb);
    if (!annotated) {
        stroke(0, 0.15, 1);
        return;
    }
    // What always holds, over the moment: the feather faintly filled, past the margin less what lies past the feather.
    const [from, to] = [SLACK + MARGIN, SLACK + MARGIN + FEATHER];
    context.fillStyle = `rgba(${INK}, 0.22)`;
    context.fill(past(to, past(from)), "evenodd");
    stroke(SLACK, 0.9, 1.5);
    stroke(from, 0.8, 1, [4, 3]);
    stroke(to, 0.8, 1, [1.5, 2.5]);
    // The labels in a column on the east, past the feather, around the equator, each led to its line or band.
    const size = (canvas.clientWidth < 500 ? 10 : 12) * ratio;
    const row = 1.5 * size;
    const xAt = (beyond: number, y: number) => {
        const points = curve(true, beyond);
        for (let i = 1; i < points.length; i++) {
            const [[x0, y0], [x1, y1]] = [points[i - 1] ?? [0, 0], points[i] ?? [0, 0]];
            if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) return x0 + ((x1 - x0) * (y - y0)) / (y1 - y0);
        }
        return width;
    };
    const labels: [string, number | null][] = [
        ["ever seen", SLACK],
        [`${MARGIN}° margin`, SLACK + MARGIN / 2],
        [`${FEATHER}° feather`, SLACK + MARGIN + FEATHER / 2],
        [fill, null],
    ];
    const ys = labels.map((_, i) => height / 2 + (i - (labels.length - 1) / 2) * row);
    const column = Math.max(...ys.map((y) => xAt(SLACK + MARGIN + FEATHER, y))) + 10 * ratio;
    Object.assign(context, { font: `${size}px ${family}`, textBaseline: "middle", lineJoin: "round" });
    for (const [i, [text, beyond]] of labels.entries()) {
        const y = ys[i] ?? 0;
        if (beyond !== null) {
            Object.assign(context, { strokeStyle: `rgba(${INK}, 0.8)`, lineWidth: ratio });
            context.beginPath();
            context.moveTo(xAt(beyond, y), y);
            context.lineTo(column - 3 * ratio, y);
            context.stroke();
        }
        Object.assign(context, { strokeStyle: HALO, lineWidth: 3 * ratio, fillStyle: `rgba(${INK}, 0.95)` });
        context.strokeText(text, column, y);
        context.fillText(text, column, y);
    }
}

/**
 * The maps figure on `root`, the seen ones: NASA's color map as shipped, the heights, which the package packs into two
 * bytes of a WebP, decoded here into gray, the lowest ground black and the highest white, and the roughness as gray.
 */
export function mapsFigure(root: HTMLElement) {
    const color = find<HTMLImageElement>("[data-field=color]", root);
    const heights = find<HTMLCanvasElement>("[data-field=heights]", root);
    const roughness = find<HTMLCanvasElement>("[data-field=roughness]", root);
    const note = find("[data-field=note]", root);
    const seen = [...root.querySelectorAll<HTMLCanvasElement>("[data-field=seen]")];
    // The package's default set, the seen 1K, which `pnpm dev` has without the asset mirror.
    const files = MOON_MAPS["1k"];
    const annotations = find("[data-field=annotations]", root);
    const family = getComputedStyle(root).fontFamily;
    let texels = "";
    const requestRender = onDemand(() => {
        const libration = moon.librations(julianEphemerisDay(fromJulianDay(state.jd)));
        const annotated = annotations.getAttribute("aria-pressed") === "true";
        // Past the feather the color holds its mean, the relief none: no height, no slope.
        const fill = !color.hidden ? "mean" : heights.hidden ? "smooth" : "0 m";
        for (const canvas of seen) drawSeen(canvas, libration, annotated, family, fill, fill === "smooth");
        const lon = `${Math.abs(libration.longitude).toFixed(1)}° ${libration.longitude >= 0 ? "east" : "west"}`;
        const lat = `${Math.abs(libration.latitude).toFixed(1)}° ${libration.latitude >= 0 ? "north" : "south"}`;
        note.textContent = `${texels}Earth over ${lon}, ${lat}`;
    }, root);
    color.src = String(files.color);
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
        const { width, height } = image;
        Object.assign(heights, { width, height });
        const context = heights.getContext("2d");
        if (!context) return;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, width, height);
        const { data } = pixels;
        // LOLA's half meters, offset by 20,000: red the high byte, green the low one.
        const km = new Float32Array(width * height);
        let low = Number.POSITIVE_INFINITY;
        let high = Number.NEGATIVE_INFINITY;
        for (let i = 0; i < km.length; i++) {
            const v = ((data[i * 4] ?? 0) * 256 + (data[i * 4 + 1] ?? 0) - 20000) * 0.0005;
            km[i] = v;
            if (v < low) low = v;
            if (v > high) high = v;
        }
        for (let i = 0; i < km.length; i++) {
            const g = Math.round((((km[i] ?? 0) - low) / (high - low)) * 255);
            data[i * 4] = g;
            data[i * 4 + 1] = g;
            data[i * 4 + 2] = g;
            data[i * 4 + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
        texels = `${width} × ${height} texels each, the heights from ${fixed(low, 1)} km to ${fixed(high, 1)} km about the mean radius; `;
        requestRender();
    };
    image.src = files.heights ? String(files.heights) : "";
    // The roughness map's median slope over 57 m, red in tenths of a degree, as gray from flat to 15°.
    const rough = new Image();
    rough.crossOrigin = "anonymous";
    rough.onload = () => {
        const { width, height } = rough;
        Object.assign(roughness, { width, height });
        const context = roughness.getContext("2d");
        if (!context) return;
        context.drawImage(rough, 0, 0);
        const pixels = context.getImageData(0, 0, width, height);
        const { data } = pixels;
        for (let i = 0; i < width * height; i++) {
            const g = Math.round(Math.min((data[i * 4] ?? 0) / 150, 1) * 255);
            data[i * 4] = g;
            data[i * 4 + 1] = g;
            data[i * 4 + 2] = g;
            data[i * 4 + 3] = 255;
        }
        context.putImageData(pixels, 0, 0);
    };
    rough.src = String(MOON_ROUGHNESS["1k"]);
    // One map at a time, the color, the heights or the roughness.
    const choices = [...root.querySelectorAll<HTMLButtonElement>("[data-map]")];
    for (const choice of choices)
        choice.addEventListener("click", () => {
            for (const other of choices) other.setAttribute("aria-pressed", String(other === choice));
            color.hidden = choice.dataset.map !== "color";
            heights.hidden = choice.dataset.map !== "heights";
            roughness.hidden = choice.dataset.map !== "roughness";
            requestRender();
        });
    annotations.addEventListener("click", () => {
        annotations.setAttribute("aria-pressed", String(annotations.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });
    // The map shown at its own size, what Earth sees over it, the moment and the place in a corner.
    figureInfo(root);
    find("[data-field=download]", root).addEventListener("click", () => {
        const map = !color.hidden ? color : roughness.hidden ? heights : roughness;
        const [width, height] = map === color ? [color.naturalWidth, color.naturalHeight] : [map.width, map.height];
        const copy = Object.assign(document.createElement("canvas"), { width, height });
        const context = copy.getContext("2d");
        if (!context || !width) return;
        context.drawImage(map, 0, 0, width, height);
        if (seen[0]) context.drawImage(seen[0], 0, 0, width, height);
        Object.assign(context, {
            font: `${Math.round(height / 40)}px ${getComputedStyle(root).fontFamily}`,
            fillStyle: "rgb(255 255 255 / 0.85)",
            textBaseline: "bottom",
        });
        context.fillText(momentAndPlace(), width / 100, height - height / 100);
        const which = map === color ? "color" : map === heights ? "heights" : "roughness";
        copy.toBlob((blob) => save(blob, `himmelszelt-${root.id}-${which}-${momentStamp()}.png`), "image/png");
    });
    onChange(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
