import { viewFrame } from "@himmelszelt/nachtgestirn";
import { fromDate, julianDayUT } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, splitLine, svgText } from "../sternzeit/figure";
import { noGpu } from "./laws";
import { PHOTOS, type Photo } from "./photo-options";
import { type MoonAt, moonAt, onUmbraTable, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { createTiles, type TileFrame } from "./tiles";

// The disc's radius as a share of the stage's shorter side; past a little more than it the photograph fades into its sky.
const DISC = 0.42;
const DEG = Math.PI / 180;
const f = (n: number) => n.toFixed(1);

/**
 * The view the square shows `m` in, as the photograph shows it: its up the photograph's, `turn` degrees clockwise
 * from the sky's north, or by day from the zenith. Always through the air, so the refraction squeezes the disc along
 * the vertical as it does the photograph's.
 */
function viewOf(m: MoonAt, photo: Photo) {
    const zenith = viewFrame(m.direction);
    let [right, up] = [[...zenith.right], [...zenith.up]];
    if (!photo.air) {
        // From the zenith on to the sky's north, as the tiles turn it with a position angle of 0.
        const t = -m.parallacticAngle * DEG;
        const [c, s] = [Math.cos(t), Math.sin(t)];
        [right, up] = [right.map((r, i) => r * c + (up[i] ?? 0) * s), up.map((u, i) => u * c - (right[i] ?? 0) * s)];
    }
    const t = photo.turn * DEG;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    return {
        right: right.map((r, i) => c * r - s * (up[i] ?? 0)),
        up: up.map((u, i) => s * (right[i] ?? 0) + c * u),
        toward: zenith.toward,
    };
}

/** Where the photograph fades into its sky, in radii of its disc: from a little past the limb to 1.3, or to just inside
 *  its nearest edge where that comes sooner, so the frame's edge never shows. */
function fadeOf(p: Photo) {
    const [cx, cy, r] = [p.center[0] * p.width, p.center[1] * p.height, p.radius * p.width];
    const end = Math.min(1.3, Math.min(cx, p.width - cx, cy, p.height - cy) / r - 0.01);
    return [Math.min(1.06, end - 0.05), end] as const;
}

/** The photograph's sky around its disc, as an sRGB color, for what it fades into: the middle of a ring where the fade
 *  ends, so the photograph's own sky there runs on into it. */
function skyOf(img: HTMLImageElement, p: Photo) {
    const size = 160;
    const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !img.naturalWidth) return "#000";
    try {
        context.drawImage(img, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        // In the photograph's own pixels: the sample squeezes it to a square.
        const [sx, sy] = [p.width / size, p.height / size];
        const [cx, cy, r] = [p.center[0] * p.width, p.center[1] * p.height, p.radius * p.width];
        const end = fadeOf(p)[1];
        const ring: number[][] = [];
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const d = Math.hypot((x + 0.5) * sx - cx, (y + 0.5) * sy - cy);
                if (d < r * (end - 0.04) || d > r * (end + 0.04)) continue;
                const i = (y * size + x) * 4;
                ring.push([pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0]);
            }
        }
        if (!ring.length) return "#000";
        ring.sort((u, v) => (u[0] ?? 0) + (u[1] ?? 0) + (u[2] ?? 0) - ((v[0] ?? 0) + (v[1] ?? 0) + (v[2] ?? 0)));
        const middle = ring[Math.floor(ring.length / 2)] ?? [0, 0, 0];
        return `rgb(${middle.join(" ")})`;
    } catch {
        return "#000";
    }
}

/** The photograph figure on `root`: photographs laid onto nachtgestirn's Moon for their moments and places, one at a time. */
export function photoFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const img = find<HTMLImageElement>(".photo-disc > img", root);
    const pair = find<HTMLElement>(".photo-compare", root);
    const disc = find<HTMLElement>(".photo-disc", root);
    const marks = find<SVGSVGElement>("[data-field=marks]", root);
    const slider = find<HTMLInputElement>("[data-field=split]", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    // The finest maps the GPU holds: the 8K where it takes textures that wide, else the 4K.
    const finest = (shared.device?.limits.maxTextureDimension2D ?? 0) >= 8192 ? "8k" : "4k";
    const resolution = mapResolutions(root, finest, requestRender);
    // Full screen takes the gallery along, so another photograph is a click away there too.
    const full = find("[data-field=full]", root);
    const fullscreen = find("[data-field=fullscreen]", root);
    fullscreen.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : full.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () => {
        fullscreen.setAttribute("aria-pressed", String(document.fullscreenElement === full));
        requestRender();
    });

    const picks = [...root.querySelectorAll<HTMLButtonElement>("[data-pick]")];
    const credit = find("[data-field=credit]", root);
    let chosen = 0;
    const photo = () => PHOTOS[chosen] ?? (PHOTOS[0] as Photo);
    // The chosen photograph's moment, place, author and license, on the bar its tab opens into.
    function credits(p: Photo) {
        const link = (href: string, text: string) =>
            Object.assign(document.createElement("a"), { href, textContent: text });
        const name = Object.assign(document.createElement("span"), {
            className: "photo-credit-name",
            textContent: p.label,
        });
        credit.replaceChildren(
            name,
            ` ${p.when}, ${p.where}, by `,
            link(p.page, p.author),
            ", ",
            link(p.licenseUrl, p.license),
        );
    }
    function pick(i: number) {
        chosen = i;
        img.src = photo().src;
        for (const button of picks) button.setAttribute("aria-pressed", String(Number(button.dataset.pick) === i));
        credits(photo());
        requestRender();
    }
    credits(photo());
    for (const button of picks) button.addEventListener("click", () => pick(Number(button.dataset.pick)));

    // The photograph scaled and moved until its disc lies on nachtgestirn's, in its own orientation, on a stage `w` by
    // `h` pixels; past a little more than the disc faded into its sky, which fills the stage around it.
    function placePhoto(p: Photo, w: number, h: number) {
        const scale = (DISC * Math.min(w, h)) / (p.radius * p.width);
        const [cx, cy, r] = [p.center[0] * p.width, p.center[1] * p.height, p.radius * p.width];
        const [from, to] = fadeOf(p);
        const fade = `radial-gradient(circle at ${f(cx)}px ${f(cy)}px, #000 ${f(r * from)}px, transparent ${f(r * to)}px)`;
        Object.assign(img.style, {
            width: `${p.width}px`,
            height: `${p.height}px`,
            transform: `translate(${w / 2}px, ${h / 2}px) scale(${scale}) translate(${-cx}px, ${-cy}px)`,
            maskImage: fade,
            webkitMaskImage: fade,
        });
    }
    img.addEventListener("load", () => {
        disc.style.backgroundColor = skyOf(img, photo());
    });

    // The split line and the up mark, over both.
    function drawMarks(p: Photo, w: number, h: number) {
        const at = Number(slider.value) / 100;
        const [c, cy, r] = [w / 2, h / 2, DISC * Math.min(w, h)];
        // The split line, but not at either end, where one side shows alone; a slider's thumb on it to drag.
        let svg = at > 0 && at < 1 ? splitLine(at * w, 0, h, cy, "photo-split-line") : "";
        // Where the sky's north is, or by day the zenith, just off the disc: the photograph's turn away from up.
        const [nx, ny] = [-Math.sin(p.turn * DEG), -Math.cos(p.turn * DEG)];
        svg += `<line x1="${f(c + nx * r * 1.03)}" y1="${f(cy + ny * r * 1.03)}" x2="${f(c + nx * r * 1.08)}" y2="${f(cy + ny * r * 1.08)}" class="photo-north-tick"/>`;
        svg += svgText(c + nx * r * 1.13, cy + ny * r * 1.13, p.air ? "zenith" : "N", "photo-north");
        marks.setAttribute("viewBox", `0 0 ${w} ${h}`);
        drawSvg(marks, svg, 1);
        canvas.style.clipPath = `inset(0 0 0 ${at * 100}%)`;
        paintRange(slider);
    }

    let drawn = false;
    // The stage's size in CSS pixels: a square on the page, the screen less the gallery in full screen.
    const stage = (): [number, number] => [pair.clientWidth || 600, pair.clientHeight || pair.clientWidth || 600];
    function split() {
        if (drawn) drawMarks(photo(), ...stage());
    }

    function render() {
        const table = tables();
        if (!table) return;
        const p = photo();
        const m = moonAt(julianDayUT(fromDate(new Date(p.date))), p.place, table.luts.model);
        const [w, h] = stage();
        const ratio = window.devicePixelRatio || 1;
        // Through the air, as wide as from the observer.
        const diameter = m.angularDiameter;
        const view = viewOf(m, p);
        const frame: TileFrame = {
            moon: m,
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
            // Through the air, the photograph's up leaned to; by night over a sky too dark to show at the Moon's exposure.
            air: true,
            up: view.up as [number, number, number],
        };
        const degreesAcross = (diameter / (2 * DISC)) * (w / Math.min(w, h));
        tiles?.draw(
            { count: 1, width: Math.round(w * ratio), height: Math.round(h * ratio), degreesAcross },
            () => frame,
        );
        placePhoto(p, w, h);
        drawn = true;
        drawMarks(p, w, h);
        const ew = m.libration.longitude >= 0 ? "E" : "W";
        const ns = m.libration.latitude >= 0 ? "N" : "S";
        const { latitude, longitude } = p.place;
        const utc = new Date(p.date).toISOString().slice(11, 16);
        note.textContent =
            `${p.when} (${utc} UTC), ${p.where}, ${Math.abs(latitude).toFixed(2)}° ${latitude >= 0 ? "N" : "S"} ` +
            `${Math.abs(longitude).toFixed(2)}° ${longitude >= 0 ? "E" : "W"} · the Moon ${m.horizontal.altitude.toFixed(0)}° up, ` +
            `phase angle ${m.phaseAngle.toFixed(1)}°, libration ${Math.abs(m.libration.longitude).toFixed(1)}° ${ew}, ` +
            `${Math.abs(m.libration.latitude).toFixed(1)}° ${ns} · ${p.air ? "the zenith" : "north"} ` +
            `${Math.abs(p.turn).toFixed(1)}° ${p.turn >= 0 ? "left" : "right"} of up in the photograph · the ${RESOLUTION_NAMES[resolution()]}`;
    }

    slider.addEventListener("input", split);
    // The line dragged on the picture itself, which full screen needs, as the slider is outside it.
    const drag = (event: PointerEvent) => {
        const box = pair.getBoundingClientRect();
        slider.value = String(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
        split();
    };
    // Not the browser's own drag of the photograph or a selection, which a press just beside the line would start.
    pair.addEventListener("dragstart", (event) => event.preventDefault());
    pair.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        pair.setPointerCapture(event.pointerId);
        drag(event);
    });
    pair.addEventListener("pointermove", (event) => {
        if (pair.hasPointerCapture(event.pointerId)) drag(event);
    });
    onTables(requestRender);
    onUmbraTable(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(pair);
    requestRender();
}
