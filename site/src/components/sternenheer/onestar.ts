import { type AirTable, airAt, airTable, DEFAULT_ATMOSPHERE_MODEL, liftedDirection } from "@himmelszelt/dunstkreis";
import {
    colorFromColorIndex,
    illuminanceFromMagnitude,
    linearSrgbFromChromaticity,
    magnitudeFromIlluminance,
    planckianLocus,
    type Rgb,
    temperatureFromColorIndex,
} from "@himmelszelt/sternenheer";
import { fromJulianDay, julianEphemerisDay, stars } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { gpu, onTables, tables } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { linkedSearch, onChange, state } from "../sternzeit/state";
import { GPU_MISSING } from "../webgpu";
import { renderStarPatch, type StarPatch } from "./starpatch";
import { starPicker } from "./starpicker";

/** A film star as OneStar.astro hands it over: the film list's entry and its row of the catalog's CSV. */
interface Choice {
    hr: number;
    name: string;
    film: string;
    year: number;
    note: string;
    row: number;
    line: string;
    magnitude: number;
    ra: number;
    de: number;
    pmRa: number;
    pmDe: number;
    bv: number;
}

type Vec3 = [number, number, number];
const DEG = 180 / Math.PI;
const Y: Rgb = [0.2126, 0.7152, 0.0722];
// The patch: 31 pixels of 2 arcminutes, on a target eight times as wide, so the halo spreads as over a whole view, and
// its width in the viewer's field as on a view 1,080 pixels high.
const SIZE = 31;
const VIEW_HEIGHT = 1080;
const PIXEL_DEGREES = 2 / 60;
const TARGET = 255;
const PSF_PIXELS = 0.7;
const KNEE = 1;
// The altitude the default star is picked closest to: low enough for the air to redden it.
const LOW = 10;

const luminance = (c: Rgb) => Y[0] * c[0] + Y[1] * c[1] + Y[2] * c[2];
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const minus = (text: string) => text.replace(/-/g, "−");
function sci(x: number, digits = 2) {
    if (x === 0) return "0";
    const exponent = Math.floor(Math.log10(Math.abs(x)));
    if (exponent >= -2 && exponent < 4) return minus(x.toFixed(Math.max(0, digits - exponent)));
    const power = [...String(Math.abs(exponent))].map((d) => SUPERSCRIPT[Number(d)]).join("");
    return minus(`${(x / 10 ** exponent).toFixed(digits)} × 10${exponent < 0 ? "⁻" : ""}${power}`);
}
const fixed = (x: number, digits: number) => minus(x.toFixed(digits));
const thousands = (x: number) => Math.round(x).toLocaleString("en-US");
function hours(h: number) {
    const s = Math.round((((h % 24) + 24) % 24) * 3600);
    return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}
function degrees(d: number) {
    const s = Math.round(Math.abs(d) * 60);
    return `${d < 0 ? "−" : "+"}${Math.floor(s / 60)}° ${String(s % 60).padStart(2, "0")}′`;
}
const altitudeOf = ([x, y, z]: Vec3) => Math.atan2(z, Math.hypot(x, y)) * DEG;
const azimuthOf = ([x, y]: Vec3) => (Math.atan2(x, y) * DEG + 360) % 360;
const angleBetween = (a: Vec3, b: Vec3) =>
    Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * DEG;

/** Linear sRGB as a CSS color, scaled so its brightest channel is 1: the hue and saturation, not the light. */
function swatch(c: Rgb) {
    const top = Math.max(c[0], c[1], c[2], 1e-12);
    const encode = (v: number) => {
        const x = Math.min(Math.max(v / top, 0), 1);
        return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
    };
    return `rgb(${encode(c[0])} ${encode(c[1])} ${encode(c[2])})`;
}

/** Khronos PBR Neutral, the figures' default tone curve, on one exposed linear color. */
function neutral([r, g, b]: Rgb): Rgb {
    const x = Math.min(r, g, b);
    const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    let c: Rgb = [r - offset, g - offset, b - offset];
    const peak = Math.max(...c);
    if (peak < 0.76) return c;
    const newPeak = 1 - 0.0576 / (peak + 0.24 - 0.76);
    c = c.map((v) => (v * newPeak) / peak) as unknown as Rgb;
    const blend = 1 - 1 / (0.15 * (peak - newPeak) + 1);
    return c.map((v) => v + (newPeak - v) * blend) as unknown as Rgb;
}
const encode = (v: number) => {
    const x = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
};

/** The B−V whose color, on the Planckian locus, is closest in chromaticity to `c`: for the pass, which takes a star's
 *  color as its index, to draw a star the air has reddened. */
function colorIndexOf(c: Rgb) {
    const chroma = ([r, g, b]: Rgb) => [r / (r + g + b), b / (r + g + b)];
    const [r0, b0] = chroma(c) as [number, number];
    let best = { bv: 0, miss: Number.POSITIVE_INFINITY };
    for (let bv = -0.4; bv <= 4; bv += 0.01) {
        const [r, b] = chroma(colorFromColorIndex(bv)) as [number, number];
        const miss = (r - r0) ** 2 + (b - b0) ** 2;
        if (miss < best.miss) best = { bv, miss };
    }
    return best;
}

function rows(entries: [string, string][]) {
    return entries.map(([term, value]) => `<div><dt>${term}</dt><dd>${value}</dd></div>`).join("");
}

/**
 * The figure on `root`, a `figure[data-one-star]`: one film star followed from its row in the catalog to the stars
 * pass' pixels, on the page's moment and place. Everything but the pixels is computed on the CPU by the libraries'
 * own functions; the pixels are the pass', drawn into a small target and read back.
 */
export function oneStarFigure(root: HTMLElement) {
    const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const choices = JSON.parse(root.dataset.choices ?? "[]") as Choice[];
    const header = root.dataset.header ?? "";
    const picker = starPicker(find("[data-star-picker]", root));
    const slider = field<HTMLInputElement>("exposure");
    const haloButton = field("halo");
    const canvas = field<HTMLCanvasElement>("patch");
    const pixelsVisual = field("pixelsVisual");
    Object.assign(canvas, { width: SIZE, height: SIZE });
    const profile = pixelsVisual.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
    profile.classList.add("onestar-profile");
    profile.setAttribute("viewBox", "0 0 100 40");
    profile.setAttribute("preserveAspectRatio", "none");
    profile.setAttribute("aria-hidden", "true");
    const noPixels = pixelsVisual.appendChild(document.createElement("p"));
    noPixels.className = "onestar-none";
    noPixels.hidden = true;

    let air: { key: string; table: AirTable } | null = null;
    function airFor(heightM: number) {
        const model = tables()?.luts.model ?? DEFAULT_ATMOSPHERE_MODEL;
        const key = `${heightM} ${model.refractivity} ${model.planet.groundRadiusKm}`;
        if (air?.key !== key) air = { key, table: airTable(model, heightM) };
        return air.table;
    }

    /** Where `star` stands at the page's moment and place: its true direction, ENU. */
    function placeOf(star: Choice) {
        const time = fromJulianDay(state.jd);
        const jde = julianEphemerisDay(time);
        const catalog = {
            rightAscension: star.ra * 15,
            declination: star.de,
            properMotionRightAscension: star.pmRa,
            properMotionDeclination: star.pmDe,
        };
        const moved = stars.properMotion(catalog, jde);
        const apparent = stars.apparentPosition(catalog, jde);
        const turn = stars.horizontalMatrix(time, state);
        const direction = stars.applyMatrix3(turn, stars.equatorialToVector(moved)) as Vec3;
        return { jde, catalog, moved, apparent, direction };
    }

    // The default: a star the link names, else the film star nearest the low altitude the air shows best, if one is up.
    const linked = Number(linkedSearch.get("star"));
    const byHr = (hr: number) => choices.find((star) => star.hr === hr);
    const pick = (star: Choice | undefined) => {
        if (star) picker.value = String(star.hr);
    };
    function lowest() {
        const up = choices
            .map((star) => ({ star, altitude: altitudeOf(placeOf(star).direction) }))
            .filter(({ altitude }) => altitude > 1.5);
        up.sort((a, b) => Math.abs(a.altitude - LOW) - Math.abs(b.altitude - LOW));
        return up[0]?.star ?? choices[0];
    }
    pick(byHr(linked) ?? lowest());
    // A caption's experiment that names a star picks it as well as setting the moment and place.
    root.addEventListener("click", (event) => {
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href^='?']") : null;
        const star = link && byHr(Number(new URL(link.href).searchParams.get("star")));
        if (star) {
            pick(star);
            requestRender();
        }
    });

    const set = (name: string, html: string) => {
        field(name).innerHTML = html;
    };

    let drawing = 0;
    function render() {
        const star = byHr(Number(picker.value));
        if (!star) return;
        const ev100 = -Number(slider.value);
        field("ev").textContent = fixed(ev100, 1);

        // 1. The row.
        set("rowVisual", `<code class="onestar-csv"><span>${header}</span><span>${star.line}</span></code>`);
        set(
            "row",
            rows([
                ["HR", `${star.hr}, row ${thousands(star.row)}`],
                ["magnitude", fixed(star.magnitude, 2)],
                ["J2000", `${hours(star.ra)}, ${degrees(star.de)}`],
                ["proper motion", `${fixed(Math.hypot(star.pmRa, star.pmDe), 3)}″ a year`],
                ["B−V", fixed(star.bv, 2)],
            ]),
        );

        // 2. Its place at the moment and place.
        const { jde, catalog, moved, apparent, direction } = placeOf(star);
        const years = (jde - 2451545) / 365.25;
        const j2000 = stars.equatorialToVector(catalog);
        const ofDate = stars.equatorialToVector(apparent);
        const movedVector = stars.equatorialToVector(moved);
        const altitude = altitudeOf(direction);
        const azimuth = azimuthOf(direction);
        set("placeVisual", skyDisc(azimuth, altitude));
        set(
            "place",
            rows([
                [
                    "proper motion",
                    `${fixed(angleBetween(j2000, movedVector) * 3600, 1)}″ in ${fixed(Math.abs(years), 1)} years`,
                ],
                ["precession", `${fixed(angleBetween(movedVector, ofDate), 3)}°`],
                ["of date", `${hours(apparent.rightAscension / 15)}, ${degrees(apparent.declination)}`],
                ["azimuth", `${fixed(azimuth, 1)}°`],
                ["altitude", `${fixed(altitude, 2)}°, true`],
            ]),
        );

        // 3. Its light above the air.
        const lux = illuminanceFromMagnitude(star.magnitude);
        const limit = lux / illuminanceFromMagnitude(6.5);
        set("lightVisual", magnitudeScale(star.magnitude));
        set(
            "light",
            rows([
                ["above the air", `${sci(lux)} lx`],
                [
                    "magnitude 6.5",
                    `${sci(limit >= 1 ? limit : 1 / limit, 1)} times ${limit >= 1 ? "fainter" : "brighter"}`,
                ],
                ["Sirius", `${sci(illuminanceFromMagnitude(-1.46) / lux, 1)} times brighter`],
            ]),
        );

        // 4. Its color.
        const kelvin = temperatureFromColorIndex(star.bv);
        const [x, y] = planckianLocus(kelvin);
        const color = colorFromColorIndex(star.bv);
        set("colorVisual", locusStrip(kelvin, color));
        set(
            "color",
            rows([
                ["temperature", `${thousands(kelvin)} K`],
                ["chromaticity", `x ${x.toFixed(3)}, y ${y.toFixed(3)}`],
                ["linear sRGB", color.map((c) => c.toFixed(2)).join(", ")],
            ]),
        );

        // 5. Through the air: lifted, dimmed and reddened, and its light thinned where the air squeezes the sky.
        const table = airFor(state.heightM);
        const lifted = liftedDirection(table, direction) as Vec3;
        const shown = altitudeOf(lifted);
        const through = airAt(table, shown);
        let atEye: { lux: number; color: Rgb; magnitude: number } | null = null;
        if (!through) {
            set("airVisual", `<p class="onestar-none">Below the horizon: the ground hides it.</p>`);
            set("air", rows([["shows at", `${fixed(shown, 2)}°, under the horizon of ${fixed(table.horizon, 2)}°`]]));
        } else {
            const passed = through.transmittance.map((t) => t * through.dilution) as unknown as Rgb;
            const reddened = color.map((c, i) => c * (passed[i] ?? 0)) as unknown as Rgb;
            const share = luminance(reddened);
            atEye = { lux: lux * share, color: reddened.map((c) => c / share) as unknown as Rgb, magnitude: 0 };
            atEye.magnitude = magnitudeFromIlluminance(atEye.lux);
            set("airVisual", airSwatches(color, atEye.color, passed));
            set(
                "air",
                rows([
                    ["lifted", `${fixed((shown - altitude) * 60, 1)}′, to ${fixed(shown, 2)}°`],
                    ["airmass", fixed(through.airmass, through.airmass < 10 ? 2 : 1)],
                    ["lets through", passed.map((t) => t.toFixed(2)).join(", ")],
                    ["at the eye", `${sci(atEye.lux)} lx`],
                    ["magnitude", `${fixed(atEye.magnitude, 2)}, ${fixed(atEye.magnitude - star.magnitude, 2)} dimmer`],
                ]),
            );
        }

        // 6. Its pixels: the pass' own, the star at the eye as the air leaves it.
        const pixelRadians = PIXEL_DEGREES / DEG;
        const kneeLuminance = KNEE * 1.2 * 2 ** ev100;
        if (!atEye || !gpu.device) {
            canvas.hidden = true;
            profile.style.display = "none";
            noPixels.hidden = false;
            noPixels.innerHTML = !atEye ? "None at this moment and place." : GPU_MISSING;
            set("pixels", "");
            return;
        }
        const { bv, miss } = colorIndexOf(atEye.color);
        const halo = haloButton.getAttribute("aria-pressed") === "true" ? 1 : 0;
        const ticket = ++drawing;
        const device = gpu.device;
        const eye = atEye;
        renderStarPatch(
            device,
            { magnitude: eye.magnitude, bv },
            {
                size: SIZE,
                fovDegrees: SIZE * PIXEL_DEGREES,
                ev100,
                halo,
                knee: KNEE,
                psfPixels: PSF_PIXELS,
                target: TARGET,
                viewerTarget: VIEW_HEIGHT,
            },
        ).then((patch) => {
            if (ticket !== drawing) return;
            const sigma = Math.max(PSF_PIXELS, 0.6);
            const peak = 1 / (2 * Math.PI * sigma * sigma * patch.pixelSolidAngle);
            const centerLuminance = eye.lux * peak;
            // What the pass says the core and the halo show of the star's light.
            const { core, halo: spread } = patch.split;
            canvas.hidden = false;
            profile.style.display = "";
            noPixels.hidden = true;
            drawPatch(patch);
            drawProfile(patch, centerLuminance, kneeLuminance, sigma);
            set(
                "pixels",
                rows([
                    ["center", `${sci(centerLuminance)} cd/m²`],
                    ["exposed", `${sci(centerLuminance * patch.exposure, 1)} × white`],
                    ["core keeps", `${sci(core * 100, 1)}%`],
                    ["halo", halo ? `${sci(spread * 100, 1)}%` : "off"],
                    ["pixel", `${fixed(pixelRadians * DEG * 60, 0)}′, ${sci(patch.pixelSolidAngle, 1)} sr`],
                ]),
            );
            root.dataset.drawn = `${star.hr} ${ev100} ${bv.toFixed(2)} ${miss.toExponential(1)}`;
        });
    }

    function drawPatch(patch: StarPatch) {
        const context = canvas.getContext("2d");
        if (!context) return;
        const image = context.createImageData(SIZE, SIZE);
        for (let i = 0; i < SIZE * SIZE; i++) {
            const exposed = [0, 1, 2].map((k) => (patch.rgb[i * 3 + k] ?? 0) * patch.exposure) as unknown as Rgb;
            const shown = neutral(exposed);
            image.data.set([encode(shown[0]), encode(shown[1]), encode(shown[2]), 255], i * 4);
        }
        context.putImageData(image, 0, 0);
    }

    /** The luminance across the middle row on a log scale: as the pass drew it, the Gaussian before the knee dotted,
     *  the knee dashed. */
    function drawProfile(patch: StarPatch, peak: number, knee: number, sigma: number) {
        const middle = (SIZE - 1) / 2;
        const drawn = Array.from({ length: SIZE }, (_, x) => {
            const at = (middle * SIZE + x) * 3;
            return luminance([patch.rgb[at] ?? 0, patch.rgb[at + 1] ?? 0, patch.rgb[at + 2] ?? 0]);
        });
        const top = Math.log10(Math.max(peak, knee, ...drawn)) + 0.3;
        const bottom = top - 6;
        const yOf = (v: number) => 38 - (36 * (Math.log10(Math.max(v, 1e-30)) - bottom)) / (top - bottom);
        const xOf = (x: number) => ((x + 0.5) / SIZE) * 100;
        const line = (points: [number, number][]) =>
            points
                .map(([x, v], i) => `${i ? "L" : "M"}${xOf(x).toFixed(2)} ${Math.min(yOf(v), 38).toFixed(2)}`)
                .join("");
        const fine = Array.from({ length: 121 }, (_, i) => middle - 6 + i * 0.1);
        profile.innerHTML = [
            `<path class="onestar-gauss" d="${line(fine.map((x) => [x, peak * Math.exp(-((x - middle) ** 2) / (2 * sigma * sigma))]))}"/>`,
            `<line class="onestar-knee" x1="0" x2="100" y1="${yOf(knee).toFixed(2)}" y2="${yOf(knee).toFixed(2)}"/>`,
            `<path class="onestar-drawn" d="${line(drawn.map((v, x) => [x, v]))}"/>`,
        ].join("");
    }

    const requestRender = onDemand(render, root);
    picker.onPick(requestRender);
    slider.addEventListener("input", () => {
        paintRange(slider);
        requestRender();
    });
    paintRange(slider);
    haloButton.addEventListener("click", () => {
        haloButton.setAttribute("aria-pressed", String(haloButton.getAttribute("aria-pressed") !== "true"));
        requestRender();
    });
    onChange(requestRender);
    onTables(requestRender);
    requestRender();
}

/** The sky as a disc, the zenith in the middle and the horizon its rim, north up and east left, as seen from below. */
function skyDisc(azimuth: number, altitude: number) {
    const r = 44 * Math.min((90 - altitude) / 90, 1.12);
    const [x, y] = [50 - r * Math.sin(azimuth / DEG), 50 - r * Math.cos(azimuth / DEG)];
    const label = (text: string, lx: number, ly: number) =>
        `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central">${text}</text>`;
    return `<svg viewBox="0 0 100 100" class="onestar-disc" aria-hidden="true">
        <circle class="onestar-rim" cx="50" cy="50" r="44"/>
        <circle class="onestar-ring" cx="50" cy="50" r="29.33"/><circle class="onestar-ring" cx="50" cy="50" r="14.67"/>
        ${label("N", 50, 3)}${label("E", 3, 50)}${label("S", 50, 97)}${label("W", 97, 50)}
        <circle class="onestar-dot${altitude < 0 ? " onestar-below" : ""}" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.2"/>
    </svg>`;
}

/** The magnitude scale from Sirius to past the naked eye's limit, brighter to the left, the star on it. */
function magnitudeScale(magnitude: number) {
    const [from, to] = [-2, 8];
    const xOf = (m: number) => 6 + ((Math.min(Math.max(m, from), to) - from) / (to - from)) * 88;
    const ticks = [-1, 0, 1, 2, 3, 4, 5, 6, 7]
        .map((m) => `<line class="onestar-tick" x1="${xOf(m)}" x2="${xOf(m)}" y1="20" y2="24"/>`)
        .join("");
    const mark = (m: number, text: string, anchor: string) =>
        `<line class="onestar-mark" x1="${xOf(m)}" x2="${xOf(m)}" y1="14" y2="26"/><text x="${xOf(m)}" y="34" text-anchor="${anchor}">${text}</text>`;
    return `<svg viewBox="0 0 100 40" class="onestar-scale" aria-hidden="true">
        <line class="onestar-axis" x1="6" x2="94" y1="20" y2="20"/>${ticks}
        ${mark(-1.46, "Sirius", "start")}${mark(6.5, "6.5", "middle")}
        <circle class="onestar-dot" cx="${xOf(magnitude).toFixed(2)}" cy="20" r="3.2"/>
    </svg>`;
}

/** The Planckian locus from 2,000 to 20,000 K as a strip, logarithmic in the temperature, the star's marked. */
function locusStrip(kelvin: number, color: Rgb) {
    const [from, to] = [Math.log(2000), Math.log(20000)];
    const stops = Array.from({ length: 13 }, (_, i) => {
        const t = Math.exp(from + ((to - from) * i) / 12);
        return `<stop offset="${(i / 12).toFixed(3)}" stop-color="${swatch(linearSrgbFromChromaticity(planckianLocus(t)))}"/>`;
    }).join("");
    const x = 4 + ((Math.min(Math.max(Math.log(kelvin), from), to) - from) / (to - from)) * 92;
    return `<svg viewBox="0 0 100 40" class="onestar-locus" aria-hidden="true">
        <defs><linearGradient id="onestar-locus">${stops}</linearGradient></defs>
        <rect x="4" y="6" width="92" height="9" rx="2" fill="url(#onestar-locus)"/>
        <line class="onestar-mark" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="3" y2="18"/>
        <text x="4" y="27" text-anchor="start">2,000 K</text><text x="96" y="27" text-anchor="end">20,000 K</text>
        <rect class="onestar-swatch" x="${(x - 5).toFixed(2)}" y="30" width="10" height="9" rx="1.5" fill="${swatch(color)}"/>
    </svg>`;
}

/** The star's color above the air and at the eye, and what the air lets through per channel. */
function airSwatches(above: Rgb, atEye: Rgb, passed: Rgb) {
    const bars = passed
        .map((t, i) => {
            const height = 26 * Math.min(t, 1);
            return `<rect class="onestar-bar onestar-bar-${i}" x="${60 + i * 12}" y="${(32 - height).toFixed(2)}" width="8" height="${height.toFixed(2)}"/>`;
        })
        .join("");
    return `<svg viewBox="0 0 100 40" class="onestar-airs" aria-hidden="true">
        <rect class="onestar-swatch" x="4" y="8" width="18" height="18" rx="2" fill="${swatch(above)}"/>
        <rect class="onestar-swatch" x="30" y="8" width="18" height="18" rx="2" fill="${swatch(atEye)}"/>
        <text x="13" y="36" text-anchor="middle">space</text><text x="39" y="36" text-anchor="middle">eye</text>
        <line class="onestar-axis" x1="57" x2="95" y1="32" y2="32"/><line class="onestar-knee" x1="57" x2="95" y1="6" y2="6"/>
        ${bars}
    </svg>`;
}
