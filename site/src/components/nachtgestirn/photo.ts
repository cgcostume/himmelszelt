import { viewFrame } from "@himmelszelt/nachtgestirn";
import { fromDate, julianDayUT } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { display, onDisplay, onTables, gpu as shared, tables } from "../dunstkreis/atmosphere";
import { save } from "../dunstkreis/download";
import { figureInfo } from "../figure-info";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, selenographic, splitLine, svgText, toScreen, visibleRuns } from "../sternzeit/figure";
import { linkedSearch } from "../sternzeit/state";
import { noGpu } from "./laws";
import { PHOTOS, type Photo } from "./photo-options";
import { type MoonAt, moonAt, onUmbraTable, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { standaloneSvg } from "./snapshot";
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
 *  its nearest edge where that comes sooner, so the frame's edge never shows; never inside the limb, though, for a
 *  mosaic whose frame cuts the disc itself, where the frame's edge runs through a sky as black as the ground. */
function fadeOf(p: Photo) {
    const [cx, cy, r] = [p.center[0] * p.width, p.center[1] * p.height, p.radius * p.width];
    const end = Math.max(1.04, Math.min(1.3, Math.min(cx, p.width - cx, cy, p.height - cy) / r - 0.01));
    return [Math.min(1.06, end - 0.05), end] as const;
}

/** The photograph's sky around its disc, as sRGB colors every 15° clockwise from up, for what it fades into: the middle
 *  of each sector of a ring where the fade ends, so the photograph's own sky there runs on into it, gradient and all. */
function skyOf(img: HTMLImageElement, p: Photo) {
    const [size, sectors] = [256, 24];
    const canvas = Object.assign(document.createElement("canvas"), { width: size, height: size });
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || !img.naturalWidth) return ["#000"];
    try {
        context.drawImage(img, 0, 0, size, size);
        const pixels = context.getImageData(0, 0, size, size).data;
        // In the photograph's own pixels: the sample squeezes it to a square.
        const [sx, sy] = [p.width / size, p.height / size];
        const [cx, cy, r] = [p.center[0] * p.width, p.center[1] * p.height, p.radius * p.width];
        const end = fadeOf(p)[1];
        const rings: number[][][] = Array.from({ length: sectors }, () => []);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const [dx, dy] = [(x + 0.5) * sx - cx, (y + 0.5) * sy - cy];
                const d = Math.hypot(dx, dy);
                if (d < r * (end - 0.04) || d > r * (end + 0.04)) continue;
                const i = (y * size + x) * 4;
                const k = Math.floor(((Math.atan2(dx, -dy) / (2 * Math.PI) + 1) % 1) * sectors) % sectors;
                rings[k]?.push([pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0]);
            }
        }
        const sum = (u: number[]) => (u[0] ?? 0) + (u[1] ?? 0) + (u[2] ?? 0);
        const middle = (ring: number[][]) => ring.sort((u, v) => sum(u) - sum(v))[Math.floor(ring.length / 2)];
        const all = middle(rings.flat());
        if (!all) return ["#000"];
        return rings.map((ring) => `rgb(${(middle(ring) ?? all).join(" ")})`);
    } catch {
        return ["#000"];
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
    const tiles = createTiles(canvas, requestRender, false);
    if (!tiles) noGpu(canvas);
    // The finest maps the GPU holds: the 8K where it takes textures that wide, else the 4K.
    const finest = (shared.device?.limits.maxTextureDimension2D ?? 0) >= 8192 ? "8k" : "4k";
    const resolution = mapResolutions(root, finest, requestRender);
    const roughness = find("[data-field=roughness]", root);
    roughness.addEventListener("click", () => {
        roughness.setAttribute("aria-pressed", String(roughness.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });
    const sharpen = find("[data-field=sharpen]", root);
    sharpen.addEventListener("click", () => {
        sharpen.setAttribute("aria-pressed", String(sharpen.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });
    const grid = find("[data-field=annotations]", root);
    grid.addEventListener("click", () => {
        grid.setAttribute("aria-pressed", String(grid.getAttribute("aria-pressed") !== "true"));
        split();
    });
    const [blur, composite] = [find("feGaussianBlur", root), find("feComposite", root)];
    const bounds = [...root.querySelectorAll("feMorphology")];
    // The photograph's unsharp mask over the canvas, as wide on the screen as on the disc, or none. Held within the
    // neighborhood's darkest and brightest, as far as the blur reaches, so it rings no dark halo into the sky at the limb.
    function sharpenAs(p: Photo, w: number, h: number) {
        if (sharpen.getAttribute("aria-pressed") !== "true") {
            canvas.style.filter = "";
            return;
        }
        const sigma = p.sharpen.radius * DISC * Math.min(w, h);
        blur.setAttribute("stdDeviation", sigma.toFixed(2));
        for (const b of bounds) b.setAttribute("radius", String(Math.max(1, Math.ceil(2 * sigma))));
        composite.setAttribute("k2", String(1 + p.sharpen.amount));
        composite.setAttribute("k3", String(-p.sharpen.amount));
        canvas.style.filter = `url(#${root.id}-sharpen)`;
    }
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
    let sky = ["#000"];
    img.addEventListener("load", () => {
        sky = skyOf(img, photo());
        const stops = [...sky, sky[0]].map((c, k) => `${c} ${(k * 360) / sky.length}deg`);
        disc.style.background = `conic-gradient(from ${180 / sky.length}deg, ${stops.join(", ")})`;
    });

    // The face figure's grid every 30°, the limb, the Moon's north and the center of its face, turned as the photograph is.
    function gridOf(m: MoonAt, p: Photo, c: number, cy: number, r: number) {
        const { longitude: l, latitude: b } = m.libration;
        // The Moon's north counterclockwise from the screen's up: the photograph's turn from the sky's north, or with
        // the air from the zenith, and the axis' position angle from there.
        const tilt = p.turn + m.positionAngleOfAxis - (p.air ? m.parallacticAngle : 0);
        const line = (points: readonly (readonly number[])[], cls: string) =>
            `<polyline points="${points.map(([x, y]) => `${f(c + x)},${f(cy + y)}`).join(" ")}" class="${cls}"/>`;
        let svg = "";
        for (let lon = -180; lon < 180; lon += 30) {
            const meridian = Array.from({ length: 37 }, (_, i) => selenographic(lon, -90 + i * 5, l, b));
            for (const run of visibleRuns(meridian, tilt, r))
                svg += line(run, lon ? "moon-grid" : "moon-grid moon-grid-main");
        }
        for (let lat = -60; lat <= 60; lat += 30) {
            const parallel = Array.from({ length: 73 }, (_, i) => selenographic(-180 + i * 5, lat, l, b));
            for (const run of visibleRuns(parallel, tilt, r))
                svg += line(run, lat ? "moon-grid" : "moon-grid moon-grid-main");
        }
        const [nx, ny] = toScreen([0, 1], tilt, 1);
        svg += `<line x1="${f(c + nx * r)}" y1="${f(cy + ny * r)}" x2="${f(c + nx * r * 1.06)}" y2="${f(cy + ny * r * 1.06)}" class="moon-axis"/>`;
        svg += svgText(c + nx * r * 1.1, cy + ny * r * 1.1, "N", "photo-north");
        svg += `<circle cx="${f(c)}" cy="${f(cy)}" r="${f(r)}" class="moon-limb"/>`;
        return `<g class="photo-grid">${svg}<circle cx="${f(c)}" cy="${f(cy)}" r="2" class="moon-center"/></g>`;
    }

    // The split line and the up mark, over both, and the grid where asked for.
    let shown: MoonAt | null = null;
    function drawMarks(p: Photo, w: number, h: number) {
        const at = Number(slider.value) / 100;
        const [c, cy, r] = [w / 2, h / 2, DISC * Math.min(w, h)];
        let svg = shown && grid.getAttribute("aria-pressed") === "true" ? gridOf(shown, p, c, cy, r) : "";
        // The split line, but not at either end, where one side shows alone; a slider's thumb on it to drag.
        svg += at > 0 && at < 1 ? splitLine(at * w, 0, h, cy, "photo-split-line") : "";
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

    // The Moon as the last frame drew it, for the copy.
    let seen: Record<string, unknown> = {};
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
            roughness: roughness.getAttribute("aria-pressed") === "true",
            earthshine: true,
            eclipse: false,
            law: "hapke2012",
            darkAdapted: false,
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
        sharpenAs(p, w, h);
        shown = m;
        drawn = true;
        drawMarks(p, w, h);
        seen = {
            altitudeDeg: m.horizontal.altitude,
            phaseAngle: m.phaseAngle,
            libration: { longitudeDeg: m.libration.longitude, latitudeDeg: m.libration.latitude },
            degreesAcross,
        };
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

    // The copy: the photograph's own moment and place in place of the page's, and its source, author and license.
    figureInfo(
        root,
        () => {
            const { label, thumb: _, ...p } = photo();
            const jd = julianDayUT(fromDate(new Date(p.date)));
            return {
                utc: new Date(p.date).toISOString(),
                julianDay: jd,
                latitude: p.place.latitude,
                longitude: p.place.longitude,
                heightM: p.place.heightM,
                photograph: { label, ...p },
                moon: seen,
            };
        },
        () => `${location.origin}${location.pathname}?photo=${chosen}#${root.id}`,
    );
    // A link copied from here opens the same photograph.
    const linked = Number(linkedSearch.get("photo"));
    if (location.hash === `#${root.id}` && Number.isInteger(linked) && PHOTOS[linked]) pick(linked);

    // The comparison as shown, as PNG: the photograph faded into its sky, nachtgestirn's Moon right of the split, sharpened
    // as on the page, and the marks over both. The canvas is drawn just before it is copied: WebGPU keeps it only for that task.
    async function download() {
        const p = photo();
        const [w, h] = stage();
        const ratio = window.devicePixelRatio || 1;
        const canvasOf = () =>
            Object.assign(document.createElement("canvas"), {
                width: Math.round(w * ratio),
                height: Math.round(h * ratio),
            });
        const out = canvasOf();
        const layer = canvasOf();
        const context = out.getContext("2d");
        const faded = layer.getContext("2d");
        if (!context || !faded) return;
        context.scale(ratio, ratio);
        const around = context.createConicGradient(Math.PI / sky.length - Math.PI / 2, w / 2, h / 2);
        for (const [k, c] of [...sky, sky[0] ?? "#000"].entries()) around.addColorStop(k / sky.length, c);
        context.fillStyle = around;
        context.fillRect(0, 0, w, h);
        const scale = (DISC * Math.min(w, h)) / (p.radius * p.width);
        const [cx, cy, r] = [p.center[0] * p.width, p.center[1] * p.height, p.radius * p.width];
        const [from, to] = fadeOf(p);
        faded.scale(ratio, ratio);
        faded.translate(w / 2, h / 2);
        faded.scale(scale, scale);
        faded.translate(-cx, -cy);
        faded.drawImage(img, 0, 0, p.width, p.height);
        const fade = faded.createRadialGradient(cx, cy, r * from, cx, cy, r * to);
        fade.addColorStop(0, "#000");
        fade.addColorStop(1, "transparent");
        faded.globalCompositeOperation = "destination-in";
        faded.fillStyle = fade;
        faded.fillRect(0, 0, p.width, p.height);
        context.drawImage(layer, 0, 0, w, h);
        const marksImage = new Image();
        marksImage.src = URL.createObjectURL(new Blob([standaloneSvg(marks, w, h)], { type: "image/svg+xml" }));
        await marksImage.decode();
        const at = Number(slider.value) / 100;
        render();
        context.save();
        context.beginPath();
        context.rect(at * w, 0, w - at * w, h);
        context.clip();
        context.filter = canvas.style.filter || "none";
        context.drawImage(canvas, 0, 0, w, h);
        context.restore();
        context.drawImage(marksImage, 0, 0, w, h);
        URL.revokeObjectURL(marksImage.src);
        const name = p.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        out.toBlob((blob) => save(blob, `himmelszelt-${root.id}-${name}.png`), "image/png");
    }
    find("[data-field=download]", root).addEventListener("click", download);

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
