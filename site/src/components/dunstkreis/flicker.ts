import type { AirTable, Seeing } from "@himmelszelt/dunstkreis";
import {
    AIR_DISPERSION,
    airAt,
    airTable,
    DEFAULT_ATMOSPHERE_MODEL,
    SEEING_WAVELENGTH_M,
    scintillation,
    scintillationIndex,
} from "@himmelszelt/dunstkreis";
import { colorFromColorIndex } from "@himmelszelt/sternenheer";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { starPicker } from "../sternenheer/starpicker";
import { drawSvg, svgText } from "../sternzeit/figure";

// One star's flicker through the air: its light as `dkScintillation` draws it, the twinkling's strength over the
// altitude from `scintillationIndex`, and the pattern of light and shade the turbulence casts on the ground. CPU only.

const DEG = Math.PI / 180;
const WINDOW_S = 2;
// The speed the space station's orbit gives `Seeing.speed`, taken above the model's air.
const ORBIT_SPEED = 7700;
// A planet's disc, in radians: 30 arcseconds.
const PLANET = (30 / 3600) * DEG;
// The pattern crosses its panel in this many seconds, however fast the wind carries it.
const CROSSING_S = 4;
const PLOT = { top: 12, right: 10, bottom: 24, left: 42 };
const TRAIL = 14;
const CHANNELS = [
    [2, "plot-line-blue"],
    [1, "plot-line-green"],
    [0, "plot-line-red"],
] as const;

const f = (n: number) => n.toFixed(1);
const encode = (v: number) => {
    const c = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};

// The hash of `wgsl.seeing`, in u32 arithmetic, so the curve is the one the shader draws for the same seed and clock.
function hash(x: number) {
    let h = (Math.imul(x, 747796405) + 2891336453) >>> 0;
    h = Math.imul((h >>> ((h >>> 28) + 4)) ^ h, 277803737) >>> 0;
    return ((h >>> 22) ^ h) >>> 0;
}
const uniform = (seed: number) => ((hash(seed) & 0xffffff) + 0.5) / 16777216;
const normal = (seed: number) =>
    Math.sqrt(-2 * Math.log(Math.max(uniform(seed), 1e-7))) *
    Math.cos(2 * Math.PI * uniform((seed ^ 0x9e3779b9) >>> 0));
function noise(seed: number, t: number) {
    const k = Math.floor(t);
    const x = t - k;
    const s = x * x * (3 - 2 * x);
    const a = normal((seed + Math.imul(k, 7919)) >>> 0);
    const b = normal((seed + Math.imul(k + 1, 7919)) >>> 0);
    return (a + (b - a) * s) / Math.sqrt(s * s + (1 - s) * (1 - s));
}

/** What `dkScintillation` multiplies a point's light by at `time`, per channel, given its σ, step and color share. */
function factor(seed: number, time: number, sigma: number, step: number, chroma: number): [number, number, number] {
    if (sigma <= 0) return [1, 1, 1];
    const t = time / step;
    const hashed = Math.imul(seed, 2654435761) >>> 0;
    const whole = noise(hashed, t);
    const out: [number, number, number] = [1, 1, 1];
    for (let c = 0; c < 3; c++) {
        const own = noise((hashed + (c + 1) * 104729) >>> 0, t);
        out[c] = Math.exp(sigma * (Math.sqrt(1 - chroma) * whole + Math.sqrt(chroma) * own) - 0.5 * sigma * sigma);
    }
    return out;
}

/** The plane waves the ground pattern is summed from: wave numbers in units of the Fresnel scale, fixed once. */
const WAVES = (() => {
    let state = 0x2f6b9e13;
    const random = () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return Array.from({ length: 56 }, () => {
        const k = Math.PI * 5 ** random();
        const angle = 2 * Math.PI * random();
        return { kx: k * Math.cos(angle), ky: k * Math.sin(angle), phase: 2 * Math.PI * random() };
    });
})();

/** 2 J1(x) / x, the share of a wave a uniform disc keeps when it averages over it. */
function airy(x: number) {
    if (x < 1e-6) return 1;
    if (x < 3) {
        let [term, sum] = [x / 2, x / 2];
        for (let m = 1; m < 12; m++) {
            term *= -(x * x) / (4 * m * (m + 1));
            sum += term;
        }
        return (2 * sum) / x;
    }
    // Far out, the asymptote of J1.
    return (2 * Math.sqrt(2 / (Math.PI * x)) * Math.cos(x - 0.75 * Math.PI)) / x;
}

interface Choice {
    hr: number;
    name: string;
    row: number;
    bv: number;
}

const lengthText = (m: number) =>
    m < 0.01
        ? `${(m * 1000).toFixed(m < 0.003 ? 1 : 0)} mm`
        : m < 1
          ? `${(m * 100).toFixed(0)} cm`
          : `${m.toFixed(1)} m`;
const timeText = (s: number) =>
    s < 0.001
        ? `${(s * 1000).toFixed(2)} ms`
        : s < 0.1
          ? `${(s * 1000).toFixed(s < 0.01 ? 1 : 0)} ms`
          : `${s.toFixed(2)} s`;
const heightText = (m: number) => (m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);
const percent = (x: number) => `${Math.round(x * 100)}%`;

/** A round length for the scale bar, at most `most` meters. */
function roundLength(most: number) {
    const p = 10 ** Math.floor(Math.log10(most));
    return [5, 2, 1].map((m) => m * p).find((v) => v <= most) ?? p;
}

/** The flicker figure on `root`. Follows no moment and no place: the sliders set the star's altitude and the air. */
export function flickerFigure(root: HTMLElement) {
    const choices = JSON.parse(root.dataset.choices ?? "[]") as Choice[];
    const field = <T extends Element = HTMLElement>(name: string) => find<T>(`[data-field=${name}]`, root);
    const sliders = {
        altitude: field<HTMLInputElement>("altitude"),
        height: field<HTMLInputElement>("height"),
        r0: field<HTMLInputElement>("r0"),
        exposure: field<HTMLInputElement>("exposure"),
        aperture: field<HTMLInputElement>("aperture"),
    };
    const picker = starPicker(find("[data-star-picker]", root));
    const starCanvas = field<HTMLCanvasElement>("star-canvas");
    const light = field<SVGSVGElement>("light");
    const altitudes = field<SVGSVGElement>("altitudes");
    const ground = field<HTMLCanvasElement>("ground");
    const groundOverlay = field<SVGSVGElement>("ground-overlay");
    const play = field("play");
    const planet = field("planet");
    const note = field("note");
    const pressed = (button: Element) => button.getAttribute("aria-pressed") === "true";
    const requestRender = onDemand(render, root);

    let table: AirTable | null = null;
    let tableHeight = Number.NaN;
    let clock = WINDOW_S;
    let last = performance.now();
    let playing = false;

    function settings() {
        const heightM = 10 ** Number(sliders.height.value);
        if (heightM !== tableHeight) {
            table = airTable(DEFAULT_ATMOSPHERE_MODEL, heightM);
            tableHeight = heightM;
        }
        const t = table as AirTable;
        const share = Number(sliders.altitude.value);
        const altitude = t.horizon + (t.top - t.horizon) * share * share;
        const above = heightM > DEFAULT_ATMOSPHERE_MODEL.planet.thicknessKm * 1000;
        const seeing: Seeing = {
            r0: Number(sliders.r0.value) / 100,
            speed: above ? ORBIT_SPEED : 0,
            aperture: 10 ** Number(sliders.aperture.value),
            exposure: 10 ** Number(sliders.exposure.value),
        };
        return { table: t, heightM, altitude, seeing, above };
    }

    /** What the air does to the star's flicker at an altitude: σ, the step between draws, the colors' share. */
    function flickerAt(t: AirTable, altitude: number, seeing: Seeing) {
        const air = airAt(t, altitude);
        if (!air) return null;
        const s = air.scintillation;
        const { variance, time } = scintillation(seeing, s);
        const sigma = Math.sqrt(Math.log(1 + variance));
        const spread = AIR_DISPERSION * air.bend * DEG * air.dilution;
        const apart = spread * Math.sqrt(Math.max(s.distanceM, 1) / SEEING_WAVELENGTH_M);
        const chroma = 1 - Math.exp(-apart * apart);
        const instant = scintillationIndex({ ...seeing, aperture: 1e-6, exposure: 0 }, s);
        return { air, sigma, step: Math.max(seeing.exposure ?? 0.1, time), time, chroma, instant };
    }

    function render() {
        const now = performance.now();
        if (playing) clock += (now - last) / 1000;
        last = now;
        const { table: t, heightM, altitude, seeing, above } = settings();
        const chosen = choices.find((choice) => String(choice.hr) === picker.value) ?? choices[0];
        const seed = chosen?.row ?? 0;
        const rgb = colorFromColorIndex(chosen?.bv ?? 0);
        const peak = Math.max(rgb[0], rgb[1], rgb[2]);
        const color = [rgb[0] / peak, rgb[1] / peak, rgb[2] / peak];
        const at = flickerAt(t, altitude, seeing);
        const sigma = at?.sigma ?? 0;
        const step = at?.step ?? 1;
        const chroma = at?.chroma ?? 0;

        drawStar(factor(seed, clock, sigma, step, chroma), color);
        drawLight(seed, sigma, step, chroma, color);
        drawAltitudes(t, altitude, seeing);
        drawGround(at, seeing, above);

        field("altitudeValue").textContent = `${altitude.toFixed(1)}°`;
        field("heightValue").textContent = heightText(heightM);
        field("r0Value").textContent = `${Number(sliders.r0.value).toFixed(0)} cm`;
        field("exposureValue").textContent = timeText(seeing.exposure ?? 0.1);
        field("apertureValue").textContent = lengthText(seeing.aperture ?? 0.007);
        for (const slider of Object.values(sliders)) paintRange(slider);

        if (!at) {
            note.textContent = "the ground hides the star";
        } else if (sigma <= 0) {
            note.textContent = above ? "no air in the way above the limb: the star holds still" : "no flicker";
        } else {
            const s = at.air.scintillation;
            const fresnel = Math.sqrt(SEEING_WAVELENGTH_M * s.distanceM);
            note.textContent =
                `twinkling ${percent(sigma)}, ` +
                `${percent(at.instant)} unaveraged; a new draw every ${timeText(step)}, the pattern alike for ` +
                `${timeText(at.time)}; patches ${lengthText(fresnel)} wide, the turbulence ` +
                `${heightText(s.distanceM)} away; the colors ${percent(chroma)} apart`;
        }
        if (playing) requestRender();
    }

    // The star, enlarged: a core and a glow clipped at white, so a brighter flash also looks larger.
    let profile: { w: number; h: number; values: Float32Array } | null = null;
    function drawStar(scale: [number, number, number], color: number[]) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(starCanvas.clientWidth * dpr));
        const h = Math.max(1, Math.round(starCanvas.clientHeight * dpr));
        if (starCanvas.width !== w || starCanvas.height !== h) Object.assign(starCanvas, { width: w, height: h });
        if (!profile || profile.w !== w || profile.h !== h) {
            const values = new Float32Array(w * h);
            const size = 0.035 * Math.min(w, h);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const r = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / size;
                    values[y * w + x] = 3 * Math.exp(-0.5 * r * r) + 0.12 / (1 + 0.15 * r * r);
                }
            }
            profile = { w, h, values };
        }
        const context = starCanvas.getContext("2d");
        if (!context) return;
        const image = context.createImageData(w, h);
        const gain = [0, 1, 2].map((c) => (scale[c] ?? 1) * (color[c] ?? 1) * 0.5);
        const { values } = profile;
        for (let i = 0; i < w * h; i++) {
            const v = values[i] ?? 0;
            image.data[i * 4] = encode(v * (gain[0] ?? 0));
            image.data[i * 4 + 1] = encode(v * (gain[1] ?? 0));
            image.data[i * 4 + 2] = encode(v * (gain[2] ?? 0));
            image.data[i * 4 + 3] = 255;
        }
        context.putImageData(image, 0, 0);
    }

    // Its light over the last two seconds, per channel, on a logarithmic scale, and as a strip of color under it.
    function drawLight(seed: number, sigma: number, step: number, chroma: number, color: number[]) {
        const width = light.clientWidth || 300;
        const height = light.clientHeight || 220;
        light.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const bottom = height - PLOT.bottom - TRAIL - 6;
        const x = (s: number) => PLOT.left + ((s - clock + WINDOW_S) / WINDOW_S) * (width - PLOT.left - PLOT.right);
        const y = (v: number) => PLOT.top + ((2 - Math.min(Math.max(Math.log2(v), -2), 2)) / 4) * (bottom - PLOT.top);
        let svg = "";
        for (const [stops, label] of [
            [2, "×4"],
            [1, "×2"],
            [0, "×1"],
            [-1, "×½"],
            [-2, "×¼"],
        ] as const) {
            const yy = y(2 ** stops);
            svg += `<line x1="${PLOT.left}" y1="${f(yy)}" x2="${f(width - PLOT.right)}" y2="${f(yy)}" class="figure-grid"/>`;
            svg += svgText(PLOT.left - 6, yy, label, "figure-grid-label figure-anchor-end");
        }
        for (const back of [2, 1, 0]) {
            svg += svgText(
                x(clock - back),
                height - 8,
                back === 0 ? "now" : `−${back} s`,
                back === 0 ? "figure-label figure-anchor-end" : "figure-label",
            );
        }
        // Fine enough for the draws and for the pixels, at most a few thousand points.
        const inner = width - PLOT.left - PLOT.right;
        const count = Math.min(4000, Math.max(inner, Math.ceil((WINDOW_S / step) * 6)));
        const samples = Array.from({ length: count + 1 }, (_, i) => {
            const s = clock - WINDOW_S + (i / count) * WINDOW_S;
            return { s, light: factor(seed, s, sigma, step, chroma) };
        });
        // Channels that flicker as one are one line in the ink, not three under the red.
        const channels = chroma < 0.01 ? ([[1, ""]] as const) : CHANNELS;
        for (const [channel, cls] of channels) {
            const points = samples.map((p) => `${f(x(p.s))},${f(y(p.light[channel]))}`).join(" ");
            const ink = cls ? "" : ' style="stroke: var(--text)"';
            svg += `<polyline points="${points}" class="plot-line ${cls}"${ink}/>`;
        }
        // The strip: each pixel the light it gathers, averaged over its share of the window.
        const top = height - PLOT.bottom - TRAIL;
        svg += `<rect x="${PLOT.left}" y="${f(top)}" width="${f(inner)}" height="${TRAIL}" fill="#000"/>`;
        const per = Math.max(1, Math.round(samples.length / inner));
        for (let px = 0; px < inner; px++) {
            const from = Math.floor((px / inner) * count);
            const sum = [0, 0, 0];
            let n = 0;
            for (let i = from; i < Math.min(from + per, samples.length); i++, n++) {
                for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + ((samples[i]?.light[c] ?? 1) as number);
            }
            const rgb = sum.map((v, c) => encode(((v / Math.max(n, 1)) * (color[c] ?? 1)) / 2.2));
            svg += `<rect x="${f(PLOT.left + px)}" y="${f(top)}" width="1.2" height="${TRAIL}" fill="rgb(${rgb.join(",")})"/>`;
        }
        drawSvg(light, svg, 1);
    }

    // The twinkling's strength over the altitude, the horizon end stretched as the slider stretches it.
    function drawAltitudes(t: AirTable, altitude: number, seeing: Seeing) {
        const width = altitudes.clientWidth || 300;
        const height = altitudes.clientHeight || 220;
        altitudes.setAttribute("viewBox", `0 0 ${width} ${height}`);
        const bottom = height - PLOT.bottom;
        const inner = width - PLOT.left - PLOT.right;
        const xOf = (a: number) => PLOT.left + Math.sqrt(Math.max((a - t.horizon) / (t.top - t.horizon), 0)) * inner;
        const y = (v: number) => bottom - Math.min(v, 1) * (bottom - PLOT.top);
        let svg = "";
        for (const v of [0, 0.25, 0.5, 0.75, 1]) {
            svg += `<line x1="${PLOT.left}" y1="${f(y(v))}" x2="${f(width - PLOT.right)}" y2="${f(y(v))}" class="figure-grid"/>`;
            svg += svgText(PLOT.left - 6, y(v), percent(v), "figure-grid-label figure-anchor-end");
        }
        let lastX = Number.NEGATIVE_INFINITY;
        const ticks = [
            t.horizon,
            ...[-19, -18, -17, -10, -5, 0, 5, 10, 20, 30, 45, 60, 90].filter((a) => a > t.horizon),
        ];
        for (const a of ticks.filter((a) => a <= t.top + 1e-6)) {
            const xx = xOf(a);
            if (xx - lastX < 30 && a !== t.horizon) continue;
            lastX = xx;
            svg += svgText(
                xx,
                height - 8,
                a === t.horizon ? "horizon" : `${a}°`,
                a === t.horizon ? "figure-label figure-anchor-start" : "figure-label",
            );
        }
        const curves = { chosen: [] as string[], instant: [] as string[] };
        for (let i = 0; i <= inner; i += 2) {
            const a = t.horizon + (t.top - t.horizon) * (i / inner) ** 2;
            const air = airAt(t, a);
            if (!air) continue;
            const xx = PLOT.left + i;
            curves.chosen.push(`${f(xx)},${f(y(scintillationIndex(seeing, air.scintillation)))}`);
            const instant = scintillationIndex({ ...seeing, aperture: 1e-6, exposure: 0 }, air.scintillation);
            curves.instant.push(`${f(xx)},${f(y(instant))}`);
        }
        svg += `<polyline points="${curves.instant.join(" ")}" class="plot-line plot-line-measured"/>`;
        svg += `<polyline points="${curves.chosen.join(" ")}" class="plot-line"/>`;
        const air = airAt(t, altitude);
        const xx = xOf(altitude);
        svg += `<line x1="${f(xx)}" y1="${PLOT.top}" x2="${f(xx)}" y2="${bottom}" class="plot-now"/>`;
        if (air) {
            svg += `<circle cx="${f(xx)}" cy="${f(y(scintillationIndex(seeing, air.scintillation)))}" r="3.5" class="plot-dot"/>`;
        }
        svg += svgText(width - PLOT.right, PLOT.top + 8, "unaveraged", "figure-label figure-anchor-end");
        svg += svgText(
            width - PLOT.right,
            PLOT.top + 26,
            "lens and exposure",
            "figure-label figure-anchor-end flicker-chosen",
        );
        drawSvg(altitudes, svg, 1);
    }

    // The pattern on the ground: a lognormal field of plane waves at the Fresnel scale, its σ the unaveraged one,
    // drifting with the turbulence, slowed down; under a planet each wave is averaged over the disc's spread.
    function drawGround(at: ReturnType<typeof flickerAt>, seeing: Seeing, above: boolean) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssW = ground.clientWidth || 300;
        const cssH = ground.clientHeight || 225;
        const w = Math.max(1, Math.round((cssW * dpr) / 3));
        const h = Math.max(1, Math.round((cssH * dpr) / 3));
        if (ground.width !== w || ground.height !== h) Object.assign(ground, { width: w, height: h });
        const context = ground.getContext("2d");
        if (!context) return;
        const aperture = seeing.aperture ?? 0.007;
        const s = at?.air.scintillation;
        const distance = Math.max(s?.distanceM ?? 1, 1);
        const fresnel = Math.sqrt(SEEING_WAVELENGTH_M * distance);
        const span = Math.max(8 * fresnel, 1.6 * aperture);
        const metersPerPx = span / w;
        const sigma = at?.instant ?? 0;
        const crossing = Math.hypot((seeing.wind ?? 21) * (s?.wind ?? 1), seeing.speed ?? 0);
        const drift = (clock * span) / CROSSING_S;
        const disc = pressed(planet) ? PLANET * distance : 0;
        const waves = WAVES.map((wave) => {
            const kx = wave.kx / fresnel;
            const ky = wave.ky / fresnel;
            return { kx, ky, phase: wave.phase - kx * drift, amp: airy((Math.hypot(kx, ky) * disc) / 2) };
        });
        const norm = (sigma * Math.SQRT2) / Math.sqrt(waves.length);
        const image = context.createImageData(w, h);
        // cos(a + b) from the cosines and sines of a column's and a row's share, each computed once.
        const n = waves.length;
        const [cx, sx] = [new Float32Array(n * w), new Float32Array(n * w)];
        const [cy, sy] = [new Float32Array(n * h), new Float32Array(n * h)];
        waves.forEach((wave, j) => {
            for (let i = 0; i < w; i++) {
                const a = (i - w / 2) * metersPerPx * wave.kx;
                [cx[j * w + i], sx[j * w + i]] = [wave.amp * Math.cos(a), wave.amp * Math.sin(a)];
            }
            for (let i = 0; i < h; i++) {
                const b = (i - h / 2) * metersPerPx * wave.ky + wave.phase;
                [cy[j * h + i], sy[j * h + i]] = [Math.cos(b), Math.sin(b)];
            }
        });
        for (let yy = 0; yy < h; yy++) {
            for (let xx = 0; xx < w; xx++) {
                let chi = 0;
                for (let j = 0; j < n; j++) {
                    const [a, b] = [j * w + xx, j * h + yy];
                    chi += (cx[a] as number) * (cy[b] as number) - (sx[a] as number) * (sy[b] as number);
                }
                const v = encode(0.18 * Math.exp(norm * chi - 0.5 * sigma * sigma));
                const k = (yy * w + xx) * 4;
                image.data[k] = v;
                image.data[k + 1] = v;
                image.data[k + 2] = v;
                image.data[k + 3] = 255;
            }
        }
        context.putImageData(image, 0, 0);

        groundOverlay.setAttribute("viewBox", `0 0 ${cssW} ${cssH}`);
        const pxPerMeter = cssW / span;
        let svg = `<circle cx="${f(cssW / 2)}" cy="${f(cssH / 2)}" r="${f(Math.max((aperture / 2) * pxPerMeter, 1.5))}" class="flicker-lens"/>`;
        svg += svgText(
            cssW / 2,
            cssH / 2 + (aperture / 2) * pxPerMeter + 12,
            `the lens, ${lengthText(aperture)}`,
            "figure-label",
        );
        const bar = roundLength(span / 3);
        const barPx = bar * pxPerMeter;
        svg += `<line x1="10" y1="${f(cssH - 12)}" x2="${f(10 + barPx)}" y2="${f(cssH - 12)}" class="flicker-scale"/>`;
        svg += svgText(10 + barPx / 2, cssH - 24, lengthText(bar), "figure-label");
        if (s && sigma > 0) {
            const slowed = (crossing * CROSSING_S) / span;
            const words = `slowed ${slowed >= 100 ? Math.round(slowed / 10) * 10 : Math.round(slowed)}×`;
            svg += svgText(cssW - 10, cssH - 12, words, "figure-label figure-anchor-end");
        } else {
            svg += svgText(cssW / 2, 24, above ? "no air in the way" : "no turbulence", "figure-label");
        }
        drawSvg(groundOverlay, svg, 1);
    }

    play.addEventListener("click", () => {
        playing = !playing;
        play.setAttribute("aria-pressed", String(playing));
        play.setAttribute("aria-label", playing ? "Pause" : "Play");
        last = performance.now();
        requestRender();
    });
    planet.addEventListener("click", () => {
        planet.setAttribute("aria-pressed", String(!pressed(planet)));
        requestRender();
    });
    for (const slider of Object.values(sliders)) slider.addEventListener("input", requestRender);
    picker.onPick(() => requestRender());
    new ResizeObserver(() => {
        profile = null;
        requestRender();
    }).observe(root);
    requestRender();
}
