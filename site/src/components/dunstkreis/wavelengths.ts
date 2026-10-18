import type { AtmosphereLUTs, AtmosphereModel, SkyPass, Spectral } from "@himmelszelt/dunstkreis";
import {
    clampObserverHeight,
    createSkyPass,
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_WAVELENGTHS,
    fitSpectrumToRgb,
    luminanceOf,
    ozoneAbsorptionAt,
    precomputeAtmosphere,
    rayleighAt,
    rgbOfSpectrum,
    skySpectrum,
    solarIrradianceAt,
} from "@himmelszelt/dunstkreis";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, LABEL_GAP as GAP, STRIP_MARGIN as MARGIN, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { configureCanvas, display, gpu, gpuDevice, onDisplay, quality, SDR } from "./atmosphere";

// Pick your wavelengths: the samples a sky is computed at, dragged along the spectrum, and what they make of eight
// skies' colors, by the conversion and the error research/wavelengths.ts chose dunstkreis' four with.

type Spectrum = (nm: number) => number;
type Mode = "fitted" | "samples";

const FIRST_NM = 380;
const LAST_NM = 780;
// The markers go anywhere on the strip, to whole nanometers; shift and an arrow key moves one by ten.
const [LOWEST, HIGHEST, STEP, LONG_STEP] = [FIRST_NM, LAST_NM, 1, 10];
const TICKS = [400, 500, 600, 700];
const PRESETS: Record<Mode, number[]> = { fitted: [...DEFAULT_WAVELENGTHS], samples: [680, 550, 440] };
// Room over the plot for the markers' handles and labels, on two levels where they crowd, and under it for the band.
const LEVEL = 20;
const HEADER = 34 + LEVEL;
const BAND = 8;
const HANDLE = 7;

// The spectra research/wavelengths.ts reports on and validates with, rebuilt from the same parts.
const depth = (nm: number, airmass: number, ozone = 1) =>
    airmass * (rayleighAt(nm) * 8 + ozone * ozoneAbsorptionAt(nm) * 15);
const SKIES = (
    [
        { name: "Sun overhead", r: (nm) => Math.exp(-depth(nm, 1)) },
        { name: "blue sky", r: skySpectrum(1.2, 1, 0.1) },
        { name: "hazy sky", r: skySpectrum(1.5, 1, 0.5) },
        { name: "horizon at noon", r: skySpectrum(1.2, 6, 0.4) },
        { name: "Sun 5° up", r: (nm) => Math.exp(-depth(nm, 10)) },
        { name: "sky at sunset", r: skySpectrum(25, 1, 0.2) },
        { name: "Sun on the horizon", r: (nm) => Math.exp(-depth(nm, 38)) },
        { name: "twilight zenith", r: skySpectrum(60, 1, 0) },
    ] as { name: string; r: Spectrum }[]
).map((sky) => ({ ...sky, truth: rgbOfSpectrum(sky.r) }));
const HELD_OUT: { r: Spectrum; truth: number[] }[] = [];
for (const sunAirmass of [0.5, 3, 7, 14, 28, 50])
    for (const viewAirmass of [0.2, 1, 4])
        for (const ozone of [0.5, 1.5])
            for (const [haze, angstrom] of [
                [0.1, 0],
                [0.5, -1.3],
            ] as const) {
                const r: Spectrum = (nm) =>
                    Math.exp(-depth(nm, sunAirmass + viewAirmass, ozone)) *
                    ((1 - haze) * (rayleighAt(nm) / rayleighAt(550)) + haze * (nm / 550) ** angstrom);
                HELD_OUT.push({ r, truth: rgbOfSpectrum(r) });
            }

// The samples taken as RGB, white balanced: each channel scaled so the Sun above the air comes out at its true color.
const SUN_RGB = rgbOfSpectrum(() => 1);
const balanced = (marks: readonly number[]) =>
    marks.map((nm, i) => marks.map((_, j) => (i === j ? (SUN_RGB[i] ?? 0) / solarIrradianceAt(nm) : 0)));

const convert = (matrix: number[][], marks: readonly number[], r: Spectrum) => {
    const samples = marks.map((nm) => solarIrradianceAt(nm) * r(nm));
    return matrix.map((row) => row.reduce((sum, m, j) => sum + m * (samples[j] ?? 0), 0));
};
/** The color error of research/wavelengths.ts: the distance to the true color at equal luminance, relative to it. */
function colorError(converted: number[], truth: number[]) {
    const k = luminanceOf(truth) / luminanceOf(converted);
    return Math.hypot(...converted.map((v, i) => v * k - (truth[i] ?? 0))) / Math.hypot(...truth);
}

// The linear sRGB one nanometer of light adds, whatever the Sun sends there, as in the scattering figure.
const range = (step: number) => Array.from({ length: (LAST_NM - FIRST_NM) / step + 1 }, (_, i) => FIRST_NM + i * step);
const MATCHING = range(1).map((nm) => rgbOfSpectrum((w) => (w === nm ? 1 / solarIrradianceAt(w) : 0)));
const matching = (nm: number) => MATCHING[Math.round(nm) - FIRST_NM] ?? [0, 0, 0];
const TOP = Math.max(...MATCHING.flat());
const BOTTOM = Math.min(...MATCHING.flat());

const encode = (c: number) =>
    Math.round(255 * Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
/** Into the gamut as dunstkreis' dkToRgb does: towards the gray of its own luminance until no channel is negative. */
function inGamut(rgb: readonly number[]) {
    const gray = luminanceOf(rgb);
    const low = Math.min(...rgb);
    const t = low < 0 ? gray / (gray - low) : 1;
    return rgb.map((c) => Math.max(0, gray + t * (c - gray)));
}
const css = (rgb: readonly number[], scale: number) => `rgb(${rgb.map((c) => encode(c * scale)).join(" ")})`;

const root = find<HTMLElement>("#wavelengths");
const svgEl = find<SVGSVGElement>(".wavelengths-strip > svg", root);
const skiesEl = find<HTMLElement>(".wavelengths-skies", root);
const scoreEl = find<HTMLElement>(".wavelengths-score", root);
const matrixEl = find<HTMLTableElement>(".wavelengths-matrix", root);
const liveEl = find<HTMLElement>(".wavelengths-live", root);
const presets = [...root.querySelectorAll<HTMLInputElement>('input[name="wavelengths-preset"]')];
const variants = [...root.querySelectorAll<HTMLInputElement>('input[name="wavelengths-variant"]')];

let mode: Mode = "fitted";
let marks = [...PRESETS.fitted];
let matrix = fitSpectrumToRgb(marks);
let chosen = SKIES.findIndex((sky) => sky.name === "sky at sunset");
let dragging: number | null = null;
let focused: number | null = null;

const f = (n: number) => n.toFixed(1);
const percent = (x: number) => `${(100 * x).toFixed(1)}%`;
const named = () => (mode === "fitted" ? "your four" : "your three");
const isPreset = () => PRESETS[mode].every((nm, i) => nm === marks[i]);

function layout() {
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 200];
    const plot = { top: MARGIN.top + HEADER, bottom: height - MARGIN.bottom - GAP - BAND };
    const zero = plot.bottom - ((0 - BOTTOM) / (TOP - BOTTOM)) * (plot.bottom - plot.top);
    const x = (nm: number) => ((nm - FIRST_NM) / (LAST_NM - FIRST_NM)) * width;
    const y = (v: number) => zero - (v / (TOP - BOTTOM)) * (plot.bottom - plot.top);
    const nmAt = (px: number) => FIRST_NM + (px / width) * (LAST_NM - FIRST_NM);
    return { width, height, plot, zero, x, y, nmAt };
}

function renderStrip() {
    const { width, height, plot, zero, x, y } = layout();
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    let svg = "";

    // The chosen sky's spectrum, to its peak, under the curves.
    const sky = SKIES[chosen];
    if (sky) {
        const power = (nm: number) => solarIrradianceAt(nm) * sky.r(nm);
        const peak = Math.max(...range(2).map(power));
        const points = range(2).map((nm) => `${f(x(nm))},${f(y((power(nm) / peak) * TOP))}`);
        svg += `<polygon points="${f(x(FIRST_NM))},${f(zero)} ${points.join(" ")} ${f(x(LAST_NM))},${f(zero)}" class="wavelengths-sky-area"/>`;
        const at = range(2).reduce((best, nm) => (power(nm) > power(best) ? nm : best), FIRST_NM);
        const left = x(at) > width / 2;
        svg += svgText(
            x(at) + (left ? -GAP : GAP),
            y(TOP) + GAP,
            sky.name,
            `figure-label wavelengths-sky-name figure-anchor-${left ? "end" : "start"}`,
        );
    }
    svg += `<line x1="0" y1="${f(zero)}" x2="${width}" y2="${f(zero)}" class="figure-grid"/>`;

    // The eye's weights for linear red, green and blue, each named at its peak.
    ["red", "green", "blue"].forEach((name, c) => {
        const points = range(1).map((nm) => `${f(x(nm))},${f(y(matching(nm)[c] ?? 0))}`);
        svg += `<polyline points="${points.join(" ")}" class="wavelengths-${name}"/>`;
        const at = range(1).reduce((best, nm) => ((matching(nm)[c] ?? 0) > (matching(best)[c] ?? 0) ? nm : best));
        // Red to the right of its peak, green and blue to the left, clear of the markers at their peaks.
        const anchor = c === 0 ? "start" : "end";
        svg += svgText(
            x(at) + (c === 0 ? 3 * GAP : -3 * GAP),
            y(matching(at)[c] ?? 0) - GAP,
            name,
            `figure-label figure-anchor-${anchor} wavelengths-${name}-label`,
        );
    });

    // The spectrum as a band, each wavelength's own hue.
    const stops = range(5)
        .map((nm) => {
            const offset = ((nm - FIRST_NM) / (LAST_NM - FIRST_NM)).toFixed(3);
            const hue = inGamut(matching(Math.min(Math.max(nm, 400), 650)));
            const fade = Math.min(1, Math.max(0, (nm - FIRST_NM) / 30, 0), (LAST_NM - nm) / 30);
            return `<stop offset="${offset}" stop-color="${css(hue, fade / Math.max(...hue))}"/>`;
        })
        .join("");
    svg += `<defs><linearGradient id="wavelengths-band">${stops}</linearGradient></defs>`;
    const bandY = plot.bottom + GAP;
    svg += `<rect x="0" y="${f(bandY)}" width="${width}" height="${BAND}" rx="${BAND / 2}" fill="url(#wavelengths-band)" class="wavelengths-band"/>`;
    for (const nm of TICKS) svg += svgText(x(nm), height - MARGIN.bottom / 2, `${nm} nm`, "figure-label");

    // The markers: a line down through the curves to the band, a handle over the plot, the wavelength over it.
    const channel = ["R", "G", "B"];
    // Left to right, each label on the lower of two levels it fits on; where neither has room, only the dragged one's.
    const levels = new Map<number, number>();
    const unlabeled = new Set<number>();
    const last = [-Infinity, -Infinity];
    for (const nm of [...marks].sort((a, b) => a - b)) {
        const level = last.findIndex((px) => x(nm) - px >= 30);
        levels.set(nm, Math.max(level, 0));
        if (level < 0) unlabeled.add(nm);
        else last[level] = x(nm);
    }
    marks.forEach((nm, i) => {
        const px = x(nm);
        const handleY = MARGIN.top + HEADER - HANDLE - 6 - (levels.get(nm) ?? 0) * LEVEL;
        const label = mode === "samples" ? `${channel[i]} ${nm}` : `${nm}`;
        svg += `<g class="wavelengths-mark${dragging === i ? " dragging" : ""}" data-mark="${i}" tabindex="0" role="slider" aria-label="${mode === "samples" ? `${channel[i]}, in nm` : "Wavelength, in nm"}" aria-valuemin="${LOWEST}" aria-valuemax="${HIGHEST}" aria-valuenow="${nm}">`;
        svg += `<line x1="${f(px)}" y1="${f(handleY)}" x2="${f(px)}" y2="${f(bandY + BAND)}" class="wavelengths-mark-line"/>`;
        svg += `<circle cx="${f(px)}" cy="${f(handleY)}" r="${HANDLE}" class="wavelengths-handle"/>`;
        if (!unlabeled.has(nm) || dragging === i)
            svg += svgText(px, handleY - HANDLE - GAP - 2, label, "figure-note wavelengths-mark-label");
        svg += "</g>";
    });
    drawSvg(svgEl, svg, 1);
    if (focused !== null) svgEl.querySelector<SVGGElement>(`[data-mark="${focused}"]`)?.focus();
}

// The eight skies as buttons, made once and colored on every change.
const skyButtons = SKIES.map((sky, i) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wavelengths-pair";
    button.setAttribute("role", "radio");
    button.innerHTML = `<span class="wavelengths-swatch"><span></span><span></span></span><span class="wavelengths-pair-name">${sky.name}</span><span class="wavelengths-pair-error"></span>`;
    button.addEventListener("click", () => {
        chosen = i;
        render();
    });
    return skiesEl.appendChild(button);
});

function renderNumbers() {
    const errors = SKIES.map((sky, i) => {
        const converted = convert(matrix, marks, sky.r);
        const error = colorError(converted, sky.truth);
        // The two at the true color's luminance, into the gamut, and scaled together so the brighter fills it.
        const k = luminanceOf(sky.truth) / luminanceOf(converted);
        const pair = [inGamut(sky.truth), inGamut(converted.map((v) => v * k))];
        const scale = 1 / Math.max(...pair.flat());
        const button = skyButtons[i];
        if (button) {
            const [truth, yours] = button.querySelectorAll<HTMLElement>(".wavelengths-swatch > span");
            if (truth) truth.style.background = css(pair[0] ?? [], scale);
            if (yours) yours.style.background = css(pair[1] ?? [], scale);
            const errorEl = button.querySelector(".wavelengths-pair-error");
            if (errorEl) errorEl.textContent = percent(error);
            button.setAttribute("aria-checked", String(i === chosen));
            button.title = `${sky.name}: true, and from ${named()}, ${percent(error)} apart`;
        }
        return error;
    });
    const heldOut = HELD_OUT.map(({ r, truth }) => colorError(convert(matrix, marks, r), truth));
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    scoreEl.innerHTML =
        `<span class="status-title">these eight</span> ${percent(mean(errors))} off on average, ${percent(Math.max(...errors))} at worst<br>` +
        `<span class="status-title">72 others</span> ${percent(mean(heldOut))} and ${percent(Math.max(...heldOut))}`;
    // The matrix, small: a row per channel, a column per wavelength.
    const head = `<tr><th></th>${marks.map((nm) => `<th>${nm}</th>`).join("")}</tr>`;
    const rows = ["R", "G", "B"].map(
        (name, c) =>
            `<tr><th>${name}</th>${(matrix[c] ?? []).map((m) => `<td>${m.toPrecision(3)}</td>`).join("")}</tr>`,
    );
    matrixEl.innerHTML = head + rows.join("");
}

const requestRender = onDemand(() => render(), root);
// Refitted once per frame drawn, however many moves a drag makes in between.
let stale = false;
function render() {
    if (stale) refit();
    stale = false;
    renderStrip();
    renderNumbers();
    for (const input of presets) input.checked = input.value === mode && isPreset();
}

/** The matrix for the marks, kept as it was where markers a nanometer apart leave the fit without a finite answer. */
function refit() {
    const next = mode === "fitted" ? fitSpectrumToRgb(marks) : balanced(marks);
    if (next.flat().every(Number.isFinite)) matrix = next;
}

/** Moves marker `i` to the step nearest `nm`, unless another is there already. */
function move(i: number, nm: number) {
    const snapped = Math.min(HIGHEST, Math.max(LOWEST, Math.round(nm / STEP) * STEP));
    if (marks[i] === snapped || marks.some((other, j) => j !== i && other === snapped)) return;
    marks[i] = snapped;
    stale = true;
    requestRender();
}

const nmOf = (event: PointerEvent) => layout().nmAt(event.clientX - svgEl.getBoundingClientRect().left);
svgEl.addEventListener("pointerdown", (event) => {
    const { x } = layout();
    const px = event.clientX - svgEl.getBoundingClientRect().left;
    const nearest = marks.reduce(
        (best, nm, i) => (Math.abs(x(nm) - px) < Math.abs(x(marks[best] ?? 0) - px) ? i : best),
        0,
    );
    if (Math.abs(x(marks[nearest] ?? 0) - px) > 24) return;
    dragging = nearest;
    svgEl.setPointerCapture(event.pointerId);
    move(nearest, nmOf(event));
    requestRender();
});
svgEl.addEventListener("pointermove", (event) => {
    if (dragging !== null) move(dragging, nmOf(event));
});
for (const type of ["pointerup", "pointercancel"])
    svgEl.addEventListener(type, () => {
        if (dragging === null) return;
        dragging = null;
        requestRender();
        live?.changed();
    });
svgEl.addEventListener("focusin", (event) => {
    const mark = (event.target as Element).closest("[data-mark]");
    focused = mark ? Number(mark.getAttribute("data-mark")) : null;
});
// A redraw replaces the focused marker and focuses its successor: only a focus still outside after that leaves.
svgEl.addEventListener("focusout", () =>
    setTimeout(() => {
        if (!svgEl.contains(document.activeElement)) focused = null;
    }),
);
svgEl.addEventListener("keydown", (event) => {
    if (focused === null) return;
    const step = event.shiftKey ? LONG_STEP : STEP;
    const by = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[event.key];
    if (!by) return;
    event.preventDefault();
    // Past a neighbor in one step, so the keys can reach every free wavelength.
    let nm = (marks[focused] ?? 0) + by;
    while (marks.includes(nm)) nm += by;
    if (nm < LOWEST || nm > HIGHEST) return;
    move(focused, nm);
    live?.changed();
});

for (const input of presets)
    input.addEventListener("change", () => {
        mode = input.value as Mode;
        marks = [...PRESETS[mode]];
        refit();
        requestRender();
        live?.changed();
    });

/**
 * The whole sky overhead as a stereographic disc, the Sun at the bottom, at dunstkreis' four and at the chosen
 * wavelengths, each with tables of its own, exposed alike by the first's light meter. The chosen ones' tables are
 * recomputed when a drag ends, not along it: a few milliseconds of GPU each.
 */
function createLive() {
    const device = gpuDevice();
    const canvases = [
        find<HTMLCanvasElement>('[data-field="reference"]', liveEl),
        find<HTMLCanvasElement>('[data-field="chosen"]', liveEl),
    ];
    const chosenName = find<HTMLElement>('[data-field="chosenName"]', liveEl);
    const contexts = canvases.map((canvas) => {
        const context = canvas.getContext("webgpu");
        if (context) configureCanvas(context, SDR);
        return context;
    });
    const skies: { luts: AtmosphereLUTs | null; pass: SkyPass | null; key: string; tone: string }[] = [
        { luts: null, pass: null, key: "", tone: "" },
        { luts: null, pass: null, key: "", tone: "" },
    ];
    let ev = 12;

    /** The model at the chosen wavelengths; Bruneton's three white balanced through the Sun's spectrum, as above. */
    function chosenModel(): AtmosphereModel {
        const sorted = mode === "fitted" ? [...marks].sort((a, b) => b - a) : [...marks, marks[2] ?? 440];
        const at = (fn: (nm: number) => number) => sorted.map(fn) as unknown as Spectral;
        const base = DEFAULT_ATMOSPHERE_MODEL;
        return {
            ...base,
            wavelengths: at((nm) => nm),
            colorConversion: mode,
            solarSpectrum:
                mode === "fitted" ? at(solarIrradianceAt) : ([...SUN_RGB, SUN_RGB[2]] as unknown as Spectral),
            rayleigh: { ...base.rayleigh, beta: at(rayleighAt) },
            ozone: { ...base.ozone, betaAbsorption: at(ozoneAbsorptionAt) },
        };
    }

    async function build(i: number, model: AtmosphereModel, key: string) {
        const sky = skies[i];
        if (!sky || sky.key === key) return;
        sky.key = key;
        const withRefraction = quality.refraction ? model : { ...model, refractivity: 0 };
        const luts = await precomputeAtmosphere(device, { model: withRefraction, config: quality.config });
        const pass = await createSkyPass(device, {
            luts,
            format: SDR,
            toneMap: display.toneCurve,
            autoExposure: i === 0,
        });
        if (sky.key !== key) {
            pass.destroy();
            luts.destroy();
            return;
        }
        sky.pass?.destroy();
        sky.luts?.destroy();
        Object.assign(sky, { luts, pass, tone: display.toneCurve });
        draw();
    }

    const draw = onDemand(() => {
        const time = fromJulianDay(state.jd);
        const sunDirection = sun.direction(time, state);
        const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
        const yaw = Math.atan2(sunDirection[0], sunDirection[1]);
        // Looking up, the Sun's azimuth at the bottom: right is a quarter turn on from it, up the opposite.
        const right = [Math.cos(yaw), -Math.sin(yaw), 0];
        const up = [-Math.sin(yaw), -Math.cos(yaw), 0];
        // Stereographic, the horizon on the canvas' edge: (d + 1) sin(90°) / (d + cos(90°)) with d = 1.
        const half = 2;
        const encoder = device.createCommandEncoder();
        skies.forEach(({ pass }, i) => {
            const canvas = canvases[i];
            const context = contexts[i];
            if (!pass || !canvas || !context) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const size = Math.max(1, Math.round(canvas.clientWidth * dpr));
            if (canvas.width !== size || canvas.height !== size) Object.assign(canvas, { width: size, height: size });
            pass.update(
                {
                    sunDirection,
                    sunAngularDiameter,
                    observerHeightM: clampObserverHeight(state.heightM),
                    ev100: ev,
                    inverseViewProjection: new Float32Array([
                        ...right.map((c) => c * half),
                        0,
                        ...up.map((c) => c * half),
                        0,
                        0,
                        0,
                        0,
                        1,
                        0,
                        0,
                        1,
                        0,
                    ]),
                    projectionDistance: 1,
                },
                encoder,
            );
            pass.encode(encoder, context.getCurrentTexture());
        });
        device.queue.submit([encoder.finish()]);
        // The reference's metered exposure for the chosen sky too, drawn again once it moved.
        skies[0]?.pass?.meteredEV100().then((metered) => {
            if (Math.abs(metered - ev) <= 0.05) return;
            ev = metered;
            draw();
        });
    }, liveEl);

    let timer = 0;
    const changed = () => {
        chosenName.textContent = isPreset() ? (mode === "fitted" ? "dunstkreis’ four" : "Bruneton’s three") : named();
        clearTimeout(timer);
        timer = window.setTimeout(() => build(1, chosenModel(), `${mode}:${marks.join()}:${quality.refraction}`), 150);
    };
    build(0, DEFAULT_ATMOSPHERE_MODEL, `fitted:${DEFAULT_WAVELENGTHS.join()}:${quality.refraction}`);
    changed();
    onChange(draw);
    onDisplay(() => {
        // A new tone curve needs new passes.
        for (const sky of skies) sky.key = "";
        build(0, DEFAULT_ATMOSPHERE_MODEL, `fitted:${DEFAULT_WAVELENGTHS.join()}:${quality.refraction}`);
        changed();
    });
    new ResizeObserver(draw).observe(liveEl);
    return { changed };
}

let live: ReturnType<typeof createLive> | null = null;
function showVariant(variant: string) {
    liveEl.hidden = variant !== "B" || !gpu.device;
    if (!liveEl.hidden && !live) live = createLive();
}
for (const input of variants) input.addEventListener("change", () => showVariant(input.value));
showVariant(variants.find((input) => input.checked)?.value ?? "B");

new ResizeObserver(requestRender).observe(svgEl);
render();
