import { airTable, createAirTexture, DEFAULT_ATMOSPHERE_MODEL, liftedDirection } from "@himmelszelt/dunstkreis";
import type { DeepStars, MilkyWay, PackedStars, StarCatalog, StarsPass } from "@himmelszelt/sternenheer";
import {
    createStarsPass,
    loadCatalog,
    loadFaintStars,
    loadMilkyWay,
    MILKY_WAY_LUMINANCE,
} from "@himmelszelt/sternenheer";
import { fromDate, julianEphemerisDay, stars } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { configureCanvas, display, gpuDevice, onDisplay, SDR, gpu as shared } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, splitLine } from "../sternzeit/figure";
import { GPU_MISSING } from "../webgpu";
import { deepStarsOnce, mapForPixel, milkyWayOnce, pixelAngle } from "./renderer";
import { bindStarGroups, offsetOf, picked } from "./stargroups";
import STARMAP from "./starmap.json";

type Vec3 = [number, number, number];
const DEG = Math.PI / 180;
// Deneb rising in the northeast, 25° up over Berlin.
const MOMENT = new Date("2026-03-20T00:40:00Z");
const PLACE = { latitude: 52.52, longitude: 13.405 };
// A fixed exposure: the band and the stars both read at it, either side of the line.
const EV100 = -6;
const TEXEL_DEGREES = 360 / STARMAP.width;

const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
    const l = Math.hypot(...a);
    return [a[0] / l, a[1] / l, a[2] / l];
};

/** A pinhole along `forward` with the zenith up, `fov` degrees across a target `aspect` times as wide as high. */
function pinhole(forward: Vec3, fov: number, aspect: number): Float32Array {
    const right = normalize(cross(forward, [0, 0, 1]));
    const up = cross(right, forward);
    const tx = Math.tan((fov * DEG) / 2);
    const ty = tx / aspect;
    return new Float32Array([...right.map((c) => c * tx), 0, ...up.map((c) => c * ty), 0, 0, 0, 0, 1, ...forward, 0]);
}

/**
 * The Milky Way with and without its stars on `root`, a `figure[data-starred]`: the same sky around Deneb twice, wide
 * or zoomed in, the catalogs' stars on both sides of the line: left over the starless map, as sternenheer draws them,
 * right over NASA's starred map, as a renderer that puts a starred backdrop under its own stars would, or over NASA's
 * starless layer as published, before sternenheer's cleanup.
 */
export function starredFigure(root: HTMLElement) {
    const field = <T extends Element = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const split = field<HTMLInputElement>("split");
    const zoom = field<HTMLInputElement>("zoom");
    const panels = (["wide"] as const).map((name) => {
        const stage = field(name);
        return {
            name,
            stage,
            drawn: find<HTMLCanvasElement>('canvas[data-side="drawn"]', stage),
            backdrop: find<HTMLCanvasElement>('canvas[data-side="backdrop"]', stage),
            marks: find<SVGSVGElement>("svg", stage),
        };
    });
    // The zoom as a texel of the maps on the screen, from 1 to 32 pixels, whatever the figure's width.
    const fov = () => (TEXEL_DEGREES * (panels[0]?.stage.clientWidth || 640)) / 2 ** Number(zoom.value);

    if (shared.error) {
        for (const { stage } of panels) {
            const note = Object.assign(document.createElement("p"), { className: "tiles-empty" });
            note.innerHTML = GPU_MISSING;
            stage.replaceChildren(note);
        }
        return;
    }
    const device = gpuDevice();
    const contexts = panels.map(({ drawn, backdrop }) => {
        const pair = [drawn, backdrop].map((canvas) => canvas.getContext("webgpu") as GPUCanvasContext);
        for (const context of pair) configureCanvas(context, SDR);
        return { drawn: pair[0] as GPUCanvasContext, backdrop: pair[1] as GPUCanvasContext };
    });

    // The sky at the moment, and the air over Berlin: Deneb where the air lifts it, the view's center.
    const time = fromDate(MOMENT);
    const skyRotation = stars.horizontalMatrix(time, PLACE);
    const years = (julianEphemerisDay(time) - 2451545) / 365.25;
    const table = airTable(DEFAULT_ATMOSPHERE_MODEL, 0);
    const air = { texture: createAirTexture(device, table), horizon: table.horizon };
    const { rightAscension, declination } = STARMAP.center;
    const deneb = stars.applyMatrix3(skyRotation, stars.equatorialToVector({ rightAscension, declination })) as Vec3;
    const forward = normalize(liftedDirection(table, deneb) as Vec3);

    // The two passes, drawn and backdrop. The drawn side's map is the 4K one, or the 8K one where the view's pixels need
    // it, its pass made again when that changes.
    type Pair = { drawn: StarsPass | null; backdrop: StarsPass | null; made: string; making: string };
    const passes: Pair[] = panels.map(() => ({ drawn: null, backdrop: null, made: "", making: "" }));
    // NASA's two maps, each loaded when first picked: the starred layer holds the background at half the Milky Way
    // layer's value, twice the light a texel; the starless one as published, at the shipped map's.
    const backdropMaps = new Map<string, MilkyWay>();
    const backdropAsked = new Set<string>();
    function backdropOnce(name: string) {
        if (backdropAsked.has(name)) return;
        backdropAsked.add(name);
        const starred = name === "starred";
        loadMilkyWay(device, {
            url: `${root.dataset.base}stars/${starred ? "starmap" : "starless"}-cygnus.webp`,
            width: STARMAP.width,
            stops: STARMAP.stops,
            luminance: starred ? MILKY_WAY_LUMINANCE / STARMAP.background : MILKY_WAY_LUMINANCE,
        }).then((map) => {
            backdropMaps.set(name, map);
            requestRender();
        });
    }
    const options = () => ({ format: SDR, toneMap: display.toneCurve, dither: true }) as const;
    // The drawn side's passes, made again with the deep stars once they are first picked, and with the 8K map once the
    // view needs it and it is there; the pass before draws until then.
    let loaded: [StarCatalog, PackedStars | null, MilkyWay | null] | null = null;
    let sharp: MilkyWay | null = null;
    let sharpAsked = false;
    let deepStars: DeepStars | null = null;
    let deepAsked = false;
    function makeDrawn(pair: Pair, needsSharp: boolean) {
        if (!loaded) return;
        const [catalog, faintStars, large] = loaded;
        const milkyWay = needsSharp && sharp ? sharp : large;
        const key = `${needsSharp && sharp ? "8k" : "4k"} ${deepStars ? "deep" : ""} ${display.toneCurve}`;
        if (pair.made === key || pair.making === key) return;
        pair.making = key;
        createStarsPass(device, { ...options(), catalog, faintStars, deepStars, milkyWay, capacity: 256 }).then(
            (pass) => {
                if (pair.making !== key) return pass.destroy();
                pair.drawn?.destroy();
                Object.assign(pair, { drawn: pass, made: key, making: "" });
                requestRender();
            },
        );
    }
    Promise.all([loadCatalog(), loadFaintStars().catch(() => null), milkyWayOnce(device, "large")]).then((all) => {
        loaded = all;
        requestRender();
    });
    // The backdrop's passes: the same stars over NASA's map, made again with the deep stars or the other map.
    const backdropMade = passes.map(() => ({ made: "", making: "" }));
    function makeBackdrop(pair: Pair, state: { made: string; making: string }) {
        const map = picked(root, "backdrop");
        const milkyWay = backdropMaps.get(map);
        if (!loaded || !milkyWay) return backdropOnce(map);
        const [catalog, faintStars] = loaded;
        const key = `${map} ${deepStars ? "deep" : "plain"} ${display.toneCurve}`;
        if (state.made === key || state.making === key) return;
        state.making = key;
        createStarsPass(device, { ...options(), catalog, faintStars, deepStars, milkyWay, capacity: 256 }).then(
            (pass) => {
                if (state.making !== key) return pass.destroy();
                pair.backdrop?.destroy();
                pair.backdrop = pass;
                Object.assign(state, { made: key, making: "" });
                requestRender();
            },
        );
    }

    // One still frame a change, both sides drawn alike.
    function render() {
        const catalog = picked(root, "catalog");
        if (catalog === "tycho" && !deepAsked) {
            deepAsked = true;
            deepStarsOnce().then((found) => {
                deepStars = found;
                if (found) requestRender();
            });
        }
        const starOffset = offsetOf(root, "stars");
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (const [i, panel] of panels.entries()) {
            const width = Math.max(1, Math.round(panel.stage.clientWidth * dpr));
            const height = Math.max(1, Math.round(panel.stage.clientHeight * dpr));
            for (const canvas of [panel.drawn, panel.backdrop]) {
                if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
            }
            const view = {
                skyRotation,
                years,
                inverseViewProjection: pinhole(forward, fov(), width / height),
                projectionDistance: 0,
                ev100: EV100,
                air,
            };
            const context = contexts[i];
            const pair = passes[i];
            if (!context || !pair) continue;
            const needsSharp = mapForPixel(pixelAngle(view.inverseViewProjection, height)) === "8k";
            if (needsSharp && !sharpAsked) {
                sharpAsked = true;
                milkyWayOnce(device, "8k").then((map) => {
                    sharp = map;
                    if (map) requestRender();
                });
            }
            makeDrawn(pair, needsSharp);
            const made = backdropMade[i];
            if (made) makeBackdrop(pair, made);
            const draws: [StarsPass | null, GPUCanvasContext][] = [
                [pair.drawn, context.drawn],
                [pair.backdrop, context.backdrop],
            ];
            for (const [pass, target] of draws) {
                if (!pass) continue;
                pass.update({
                    ...view,
                    starLight: starOffset.light,
                    starCompensation: starOffset.stops,
                    faintStars: catalog === "yale" ? 0 : Number.POSITIVE_INFINITY,
                    deepStars: catalog === "tycho" ? Number.POSITIVE_INFINITY : 0,
                });
                const encoder = device.createCommandEncoder({ label: "sternwarte:starred" });
                pass.encode(encoder, target.getCurrentTexture());
                device.queue.submit([encoder.finish()]);
            }
        }
    }
    const requestRender = onDemand(render, root);
    onDisplay(requestRender);

    // The line between the two, and what a texel of the maps spans.
    function drawMarks() {
        const at = Number(split.value) / 100;
        paintRange(split);
        for (const panel of panels) {
            const [w, h] = [panel.stage.clientWidth, panel.stage.clientHeight];
            // The thumb low on the line, clear of Deneb; the names along the foot.
            let svg = at > 0 && at < 1 ? splitLine(at * w, 0, h, 0.8 * h, "photo-split-line") : "";
            const label = (x: number, anchor: string, text: string) =>
                `<text x="${x}" y="${h - 10}" text-anchor="${anchor}" class="starphoto-name">${text}</text>`;
            if (at * w > 90) svg += label(10, "start", "sternenheer");
            const right = picked(root, "backdrop") === "starless" ? "NASA starless" : "NASA starred";
            if ((1 - at) * w > 90) svg += label(w - 10, "end", right);
            panel.marks.setAttribute("viewBox", `0 0 ${w} ${h}`);
            drawSvg(panel.marks, svg, 1);
            panel.drawn.style.clipPath = `inset(0 ${(1 - at) * 100}% 0 0)`;
        }
        const degrees = fov();
        const texel = (TEXEL_DEGREES / degrees) * (panels[0]?.stage.clientWidth ?? 0);
        field("zoomValue").textContent =
            `${degrees < 10 ? degrees.toFixed(1) : degrees.toFixed(0)}°, a texel ${texel.toFixed(texel < 10 ? 1 : 0)} px`;
    }

    bindStarGroups(root, () => {
        drawMarks();
        requestRender();
    });
    paintRange(zoom);
    zoom.addEventListener("input", () => {
        paintRange(zoom);
        drawMarks();
        requestRender();
    });
    split.addEventListener("input", drawMarks);
    // The line dragged on the picture, as the slider is out of sight.
    for (const { stage } of panels) {
        const drag = (event: PointerEvent) => {
            const box = stage.getBoundingClientRect();
            split.value = String(Math.max(0, Math.min(100, ((event.clientX - box.left) / box.width) * 100)));
            drawMarks();
        };
        stage.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            stage.setPointerCapture(event.pointerId);
            drag(event);
        });
        stage.addEventListener("pointermove", (event) => {
            if (stage.hasPointerCapture(event.pointerId)) drag(event);
        });
    }
    new ResizeObserver(() => {
        drawMarks();
        requestRender();
    }).observe(root);
    drawMarks();
}
