import { coneShare, darkAdaptedEye } from "@himmelszelt/helldunkel";
import { colorFromColorIndex, illuminanceFromMagnitude, type Rgb } from "@himmelszelt/sternenheer";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { svgText } from "../sternzeit/figure";
import { type BuiltPatch, MARKS } from "./nightblue-data";

const NAMED: [number, string][] = [
    [MARKS.white, "a display's white"],
    [MARKS.fullMoon, "full Moon's sky"],
    [MARKS.moonless, "moonless sky"],
];
// A star's core in the view of the whole sky, 180° down 1,080 pixels, with the pass' default width of 0.7 pixels: its
// peak luminance per lux, which grows with the square of the zoom.
const PIXELS_PER_RADIAN = 1080 / Math.PI;
const PSF_PIXELS = 0.7;
const PEAK_PER_LUX = PIXELS_PER_RADIAN ** 2 / (2 * Math.PI * PSF_PIXELS ** 2);
const ZOOMS = [1, 10, 100];
// Photopic white at this share of display white in every row; a color brighter than white keeps its hue.
const EXPOSURE = 0.6;

const f = (v: number) => v.toFixed(1);
const luminanceOf = (c: readonly number[]) => 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);
const encode = (v: number) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));

/** Linear sRGB at a luminance of 1 for a column. */
function colorOf(patch: BuiltPatch): Rgb {
    if (patch.rgb) {
        const y = luminanceOf(patch.rgb);
        return patch.rgb.map((c) => c / y) as unknown as Rgb;
    }
    return colorFromColorIndex(patch.bv ?? 0);
}

/** A color at luminance 1 as the eye sees it at `luminance`, exposed for that level, as CSS; `null` as a camera. */
function seen(color: Rgb, luminance: number | null): string {
    const rgb =
        luminance === null
            ? [...color]
            : darkAdaptedEye([color[0] * luminance, color[1] * luminance, color[2] * luminance]).map(
                  (c) => c / luminance,
              );
    const exposed = rgb.map((c) => c * EXPOSURE);
    const over = Math.max(1, ...exposed);
    const [r, g, b] = exposed.map((c) => encode(Math.max(c / over, 0)));
    return `rgb(${r} ${g} ${b})`;
}

const cdText = (v: number) =>
    v >= 100
        ? Math.round(v).toLocaleString("en-US")
        : v >= 1
          ? v.toPrecision(2)
          : v.toFixed(Math.max(0, 1 - Math.floor(Math.log10(v))));
const percent = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The night-blue figure on `root`: (a) the cones' share over the luminance, (b) the colors as the eye sees them from
 * daylight down to starlight, (c) each color as recorded and as seen at the chosen luminance. The slider, a click on
 * either panel, or a color moves the choice.
 */
export function nightBlueFigure(root: HTMLElement) {
    const share = find<SVGSVGElement>("svg[data-field=share]", root);
    const field = find<SVGSVGElement>("svg[data-field=field]", root);
    const slider = find<HTMLInputElement>("input[data-field=luminance]", root);
    const output = find("output[data-field=value]", root);
    const status = find("[data-field=status]", root);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("[data-index]")];
    const patches = JSON.parse(root.dataset.patches ?? "[]") as BuiltPatch[];
    const colors = patches.map(colorOf);
    let log = Number(slider.value);
    let chosen = Math.max(
        0,
        patches.findIndex((p) => p.name === "Canopus"),
    );
    const requestRender = onDemand(render, root);
    const HEIGHT = 300;
    const TOP = 10;
    const BOTTOM = HEIGHT - 26;
    const y = (luminance: number) =>
        TOP + ((MARKS.max - Math.log10(luminance)) / (MARKS.max - MARKS.min)) * (BOTTOM - TOP);
    const fromY = (py: number) => MARKS.max - ((py - TOP) / (BOTTOM - TOP)) * (MARKS.max - MARKS.min);
    const cores = () => {
        const magnitude = patches[chosen]?.magnitude;
        return magnitude == null
            ? []
            : ZOOMS.map((zoom) => illuminanceFromMagnitude(magnitude) * PEAK_PER_LUX * zoom ** 2);
    };

    for (const [i, button] of buttons.entries()) {
        const camera = button.querySelector<HTMLElement>("[data-half=camera]");
        const color = colors[i];
        if (camera && color) camera.style.background = seen(color, null);
    }

    // The decades as dotted lines with their labels in the left gutter, and the named levels dashed across.
    function grid(left: number, right: number, labels: boolean) {
        let svg = "";
        for (let d = -4; d <= 4; d += 2) {
            svg += `<line x1="${f(left)}" y1="${f(y(10 ** d))}" x2="${f(right)}" y2="${f(y(10 ** d))}" class="figure-grid"/>`;
            if (labels)
                svg += svgText(
                    left - 6,
                    y(10 ** d),
                    d === 0 ? "1" : d > 0 ? `10${"⁰¹²³⁴"[d]}` : `10⁻${"⁰¹²³⁴"[-d]}`,
                    "figure-grid-label",
                );
        }
        for (const [luminance] of NAMED)
            svg += `<line x1="${f(left)}" y1="${f(y(luminance))}" x2="${f(right)}" y2="${f(y(luminance))}" class="plot-mark"/>`;
        return svg;
    }

    // (a) The cones' share across, the luminance down; the mesopic band shaded.
    function drawShare() {
        const width = share.clientWidth || 320;
        share.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
        share.style.height = `${HEIGHT}px`;
        const left = 40;
        const right = width - 8;
        const x = (s: number) => left + s * (right - left);
        let svg = `<rect x="${f(left)}" y="${f(y(4))}" width="${f(right - left)}" height="${f(y(0.01) - y(4))}" class="nightblue-band"/>`;
        svg += grid(left, right, true);
        for (const s of [0, 0.5, 1]) {
            svg += `<line x1="${f(x(s))}" y1="${TOP}" x2="${f(x(s))}" y2="${BOTTOM}" class="figure-grid"/>`;
            svg += svgText(
                x(s),
                BOTTOM + 14,
                s === 0 ? "rods alone" : s === 1 ? "cones alone" : "half",
                `figure-label${s === 0 ? " figure-anchor-start" : s === 1 ? " figure-anchor-end" : ""}`,
            );
        }
        const points = Array.from({ length: 121 }, (_, i) => {
            const l = MARKS.min + (i / 120) * (MARKS.max - MARKS.min);
            return `${f(x(coneShare(10 ** l)))},${f(y(10 ** l))}`;
        });
        svg += `<polyline points="${points.join(" ")}" class="plot-line"/>`;
        // The named levels: above the band, where the curve runs at the right, named on the left, and below it on the right.
        for (const [luminance, name] of NAMED) {
            const high = luminance > 4;
            svg += svgText(
                high ? left + 4 : right - 4,
                y(luminance) - 8,
                name,
                `figure-note ${high ? "figure-anchor-start" : "figure-anchor-end"}`,
            );
        }
        const now = 10 ** log;
        svg += `<line x1="${f(left)}" y1="${f(y(now))}" x2="${f(right)}" y2="${f(y(now))}" class="plot-now"/>`;
        // The chosen star's core at each zoom, in its color as the eye sees it there, its zoom beside it.
        const color = colors[chosen];
        for (const [i, core] of cores().entries()) {
            if (!color || core > 10 ** MARKS.max) continue;
            const cx = x(coneShare(core));
            svg += `<circle cx="${f(cx)}" cy="${f(y(core))}" r="5" class="nightblue-core" style="fill: ${seen(color, core)}"/>`;
            svg += svgText(cx - 9, y(core), `×${ZOOMS[i]}`, "figure-note figure-anchor-end");
        }
        share.innerHTML = svg;
    }

    // (b) A column a color, the luminance down in strips, each strip exposed for its own level.
    function drawField() {
        const width = field.clientWidth || 320;
        field.setAttribute("viewBox", `0 0 ${width} ${HEIGHT}`);
        field.style.height = `${HEIGHT}px`;
        const left = 40;
        const right = width - 10;
        const gap = 3;
        const column = (right - left + gap) / patches.length;
        const strips = 85;
        let svg = "";
        for (const [i, color] of colors.entries()) {
            const x0 = left + i * column;
            for (let s = 0; s < strips; s++) {
                const top = TOP + (s / strips) * (BOTTOM - TOP);
                const level = 10 ** fromY(top + (BOTTOM - TOP) / strips / 2);
                svg += `<rect x="${f(x0)}" y="${f(top)}" width="${f(column - gap)}" height="${f((BOTTOM - TOP) / strips + 1)}" fill="${seen(color, level)}"/>`;
            }
            const patch = patches[i];
            const label =
                patch?.kind === "star"
                    ? (patch.bv ?? 0).toFixed(2).replace("-", "−")
                    : patch?.kind === "sky"
                      ? "sky"
                      : "D65";
            svg += svgText(x0 + (column - gap) / 2, BOTTOM + 14, label, i === chosen ? "figure-note" : "figure-label");
        }
        svg += grid(left - 4, left, true);
        const now = y(10 ** log);
        const x0 = left + chosen * column;
        svg += `<rect x="${f(x0 - 1.5)}" y="${f(TOP - 1.5)}" width="${f(column - gap + 3)}" height="${f(BOTTOM - TOP + 3)}" class="nightblue-chosen"/>`;
        svg += `<line x1="${f(left)}" y1="${f(now)}" x2="${f(right)}" y2="${f(now)}" class="nightblue-cursor"/>`;
        svg += `<path d="M${f(right + 1)} ${f(now)}l6 -5v10z" class="timeline-pointer"/>`;
        field.innerHTML = svg;
    }

    function drawSwatches() {
        const luminance = 10 ** log;
        for (const [i, button] of buttons.entries()) {
            const eye = button.querySelector<HTMLElement>("[data-half=eye]");
            const color = colors[i];
            if (eye && color) eye.style.background = seen(color, luminance);
            button.setAttribute("aria-checked", String(i === chosen));
        }
        output.textContent = cdText(luminance);
        const patch = patches[chosen];
        let text = `The cones see ${percent(coneShare(luminance))} of the light.`;
        if (patch?.kind === "star") {
            const [whole, ten, hundred] = cores().map(cdText);
            const owner = patch.name.endsWith("s") ? `${patch.name}'` : `${patch.name}'s`;
            text += ` ${owner} core: ${whole} cd/m² in the view of the whole sky, ${ten} zoomed ten times, ${hundred} a hundred.`;
        }
        status.textContent = text;
    }

    function render() {
        drawShare();
        drawField();
        drawSwatches();
    }

    function set(value: number) {
        log = Math.round(Math.min(Math.max(value, MARKS.min), MARKS.max) * 100) / 100;
        slider.value = String(log);
        paintRange(slider);
        requestRender();
    }

    slider.addEventListener("input", () => set(Number(slider.value)));
    for (const [i, button] of buttons.entries())
        button.addEventListener("click", () => {
            chosen = i;
            requestRender();
        });
    for (const svg of [share, field]) {
        const at = (event: PointerEvent) => set(fromY(event.clientY - svg.getBoundingClientRect().top));
        svg.addEventListener("pointerdown", (event) => {
            if (event.button !== 0) return;
            if (event.pointerType === "mouse") svg.setPointerCapture(event.pointerId);
            at(event);
        });
        svg.addEventListener("pointermove", (event) => {
            if (svg.hasPointerCapture(event.pointerId)) at(event);
        });
    }

    new ResizeObserver(requestRender).observe(root);
    paintRange(slider);
    requestRender();
}
