import { MOON_MAPS } from "@himmelszelt/nachtgestirn";
import { fromJulianDay, julianEphemerisDay, moon } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { save } from "../dunstkreis/download";
import { onDemand } from "../frame";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";

const DEG = Math.PI / 180;
// The librations' reach, in degrees of longitude and latitude: what Earth ever sees, some 59% of the Moon.
const REACH = { longitude: 7.9, latitude: 6.7 };
// What the librations ever show: a point within a quarter turn of the mean sub-Earth point, and as far again past it as
// the librations reach towards it, the ellipse's support in that direction.
const reachTowards = (psi: number) => Math.hypot(REACH.longitude * Math.cos(psi), REACH.latitude * Math.sin(psi)) * DEG;
// The edge of it, as longitude and latitude, from the south pole's side round the east and back, and round the west.
function everEdge(east: boolean) {
    const points: [number, number][] = [];
    for (let i = 0; i <= 180; i++) {
        const psi = ((east ? -90 : 270) + (east ? i : -i)) * DEG;
        const d = Math.PI / 2 + reachTowards(psi);
        const p = [Math.cos(d), Math.sin(d) * Math.cos(psi), Math.sin(d) * Math.sin(psi)];
        let lon = Math.atan2(p[1] ?? 0, p[0] ?? 0);
        // Over the pole the edge lies on the far meridian, on its own side of the map.
        if (Math.abs(Math.abs(lon) - Math.PI) < 1e-6) lon = east ? Math.PI : -Math.PI;
        points.push([lon, Math.asin(Math.max(-1, Math.min(1, p[2] ?? 0)))]);
    }
    return points;
}

// The hatches as canvas patterns, a diagonal line every `period` pixels: drawn by the canvas inside a clip, not per pixel.
function hatch(context: CanvasRenderingContext2D, period: number, line: number, alpha: number) {
    const tile = document.createElement("canvas");
    Object.assign(tile, { width: period, height: period });
    const t = tile.getContext("2d");
    if (!t) return null;
    const pixels = t.createImageData(period, period);
    for (let y = 0; y < period; y++)
        for (let x = 0; x < period; x++)
            if ((x + y) % period < line) pixels.data.set([20, 22, 28, alpha], (y * period + x) * 4);
    t.putImageData(pixels, 0, 0);
    return context.createPattern(tile, "repeat");
}

const drawnFor = new WeakMap<HTMLCanvasElement, string>();

/**
 * Hatches over a map on `canvas` what Earth does not see of the Moon with Earth over `subEarth`, longitude and latitude
 * in degrees: sparsely what is turned away now, densely what no libration ever shows; the limb as a line, and the edge
 * of what is ever seen as a lighter one. Both regions are bounded by curves known in closed form, so the canvas fills
 * them with a pattern inside a clip; nothing is redrawn while neither the size nor the librations change.
 */
function drawSeen(canvas: HTMLCanvasElement, subEarth: { longitude: number; latitude: number }) {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (width === 0 || height === 0) return;
    const key = `${width} ${height} ${subEarth.longitude.toFixed(2)} ${subEarth.latitude.toFixed(2)}`;
    if (drawnFor.get(canvas) === key) return;
    drawnFor.set(canvas, key);
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    const period = 2 * Math.round(4 * ratio);
    const line = Math.max(1, Math.round(ratio));
    const px = (lon: number) => (lon / (2 * Math.PI) + 0.5) * width;
    const py = (lat: number) => (0.5 - lat / Math.PI) * height;
    // The limb: the great circle a quarter turn from the point under Earth, through every longitude; Earth's side of it
    // lies above it with Earth over the north, below with Earth over the south.
    const tanB = Math.tan(subEarth.latitude * DEG) || 1e-9;
    const limb = new Path2D();
    for (let x = 0; x <= width; x++) {
        const lat = Math.atan(-Math.cos((x / width - 0.5) * 2 * Math.PI - subEarth.longitude * DEG) / tanB);
        if (x === 0) limb.moveTo(x, py(lat));
        else limb.lineTo(x, py(lat));
    }
    const hidden = new Path2D(limb);
    const edge = tanB > 0 ? height : 0;
    hidden.lineTo(width, edge);
    hidden.lineTo(0, edge);
    hidden.closePath();
    // What no libration shows: between the edge of what is ever seen and the far meridian, east and west.
    const never = new Path2D();
    for (const east of [true, false]) {
        for (const [i, [lon, lat]] of everEdge(east).entries()) {
            if (i === 0) never.moveTo(px(lon), py(lat));
            else never.lineTo(px(lon), py(lat));
        }
        never.closePath();
    }
    for (const [region, step, alpha] of [
        [hidden, period, 170],
        [never, period / 2, 210],
    ] as const) {
        const pattern = hatch(context, step, line, alpha);
        if (!pattern) continue;
        context.save();
        context.clip(region);
        context.fillStyle = pattern;
        context.fillRect(0, 0, width, height);
        context.restore();
    }
    context.strokeStyle = "rgba(20, 22, 28, 0.9)";
    context.lineWidth = 1.5 * ratio;
    context.stroke(limb);
    context.strokeStyle = "rgba(20, 22, 28, 0.5)";
    context.lineWidth = ratio;
    for (const east of [true, false]) {
        const path = new Path2D();
        for (const [i, [lon, lat]] of everEdge(east).entries()) {
            if (i === 0) path.moveTo(px(lon), py(lat));
            else path.lineTo(px(lon), py(lat));
        }
        context.stroke(path);
    }
}

/**
 * The maps figure on `root`: NASA's color map as shipped, and the heights, which the package packs into two bytes of a
 * WebP, decoded here into gray, the lowest ground black and the highest white.
 */
export function mapsFigure(root: HTMLElement) {
    const color = find<HTMLImageElement>("[data-field=color]", root);
    const heights = find<HTMLCanvasElement>("[data-field=heights]", root);
    const note = find("[data-field=note]", root);
    const seen = [...root.querySelectorAll<HTMLCanvasElement>("[data-field=seen]")];
    const files = MOON_MAPS.medium;
    let texels = "";
    const requestRender = onDemand(() => {
        const libration = moon.librations(julianEphemerisDay(fromJulianDay(state.jd)));
        for (const canvas of seen) drawSeen(canvas, libration);
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
        texels = `${width} × ${height} texels each, the heights from ${low.toFixed(1)} km to ${high.toFixed(1)} km about the mean radius; `;
        requestRender();
    };
    image.src = files.heights ? String(files.heights) : "";
    // One map at a time, the color or the heights.
    const choices = [...root.querySelectorAll<HTMLButtonElement>("[data-map]")];
    for (const choice of choices)
        choice.addEventListener("click", () => {
            for (const other of choices) other.setAttribute("aria-pressed", String(other === choice));
            color.hidden = choice.dataset.map !== "color";
            heights.hidden = choice.dataset.map !== "heights";
            requestRender();
        });
    // The map shown at its own size, what Earth sees over it, the moment and the place in a corner.
    find("[data-field=download]", root).addEventListener("click", () => {
        const map = color.hidden ? heights : color;
        const [width, height] = color.hidden
            ? [heights.width, heights.height]
            : [color.naturalWidth, color.naturalHeight];
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
        const which = color.hidden ? "heights" : "color";
        copy.toBlob((blob) => save(blob, `himmelszelt-${root.id}-${which}-${momentStamp()}.png`), "image/png");
    });
    onChange(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
