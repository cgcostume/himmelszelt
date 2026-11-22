import type { AtmosphereLUTs, SkyPass } from "@himmelszelt/dunstkreis";
import { apparentDirection, clampObserverHeight, createSkyPass, LENS_VEIL, readTexture } from "@himmelszelt/dunstkreis";
import { coronaShare, diffractionLobe } from "@himmelszelt/gewoelk";
import { veilingGlare } from "@himmelszelt/helldunkel";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, LABEL_GAP, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { gpu, gpuDevice, onTables, quality, tables } from "./atmosphere";

// The glows around the Sun over the angle from its center. The sky and the aureole are read from two sky passes of the
// figure's own, a strip of pixels through the Sun with and without the aureole; the disc, the Sun's corona, the veils,
// a cloud's corona and a starburst's spike are computed from the Sun's light at the observer, as the passes compute them.

const DEG = Math.PI / 180;
// The strip: a row of pixels 30° to either side of the Sun, at its altitude.
const STRIP = 2048;
const ROWS = 4;
const REACH = 30;
// The plot's angles in degrees and luminances in cd/m², by their logarithms.
const ANGLES = [Math.log10(0.1), Math.log10(REACH)] as const;
const LUMINANCES = [0, 10] as const;
const POINTS = 240;
const MARGIN = { top: 12, right: 10, bottom: 34 };
// The sky pass writes cd/m² at this exposure.
const UNIT_EV100 = -Math.log2(1.2);
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

const root = find("#glows");
const svgEl = find<SVGSVGElement>('[data-field="plot"]', root);
const slider = find<HTMLInputElement>('[data-field="exposure"]', root);
const metered = find<HTMLButtonElement>('[data-field="metered"]', root);
const f = (n: number) => n.toFixed(1);
const luminanceOf = (r = 0, g = 0, b = 0) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

type Profile = {
    /** Each line's luminance in cd/m² at the plot's angles. */
    lines: Record<string, number[]>;
    /** The Sun's angular radius in degrees, its illuminance at the observer in lux, and the sky's metered EV100. */
    radius: number;
    illuminance: number;
    ev100: number;
};

let passes: { luts: AtmosphereLUTs; plain: SkyPass; glowing: SkyPass } | null = null;
let building: AtmosphereLUTs | null = null;
let strips: [GPUTexture, GPUTexture] | null = null;
let profile: Profile | null = null;
let profileFor = "";
let reading = "";

const angleAt = (i: number) => 10 ** (ANGLES[0] + (i / (POINTS - 1)) * (ANGLES[1] - ANGLES[0]));

/** The matrix of a camera looking along `forward`, the strip level through its middle. */
function stripCamera([x, y, z]: readonly number[]) {
    const flat = Math.hypot(x ?? 0, y ?? 0);
    // To the right of where the camera looks, level; towards the zenith, any side.
    const right = flat > 1e-6 ? [(y ?? 0) / flat, -(x ?? 0) / flat, 0] : [1, 0, 0];
    const [rx = 0, ry = 0] = right;
    const up = [ry * (z ?? 0), -rx * (z ?? 0), rx * (y ?? 0) - ry * (x ?? 0)];
    const across = Math.tan(REACH * DEG);
    const upward = (across * ROWS) / STRIP;
    // biome-ignore format: a matrix reads best as one
    return new Float32Array([
        rx * across, ry * across, 0, 0,
        (up[0] ?? 0) * upward, (up[1] ?? 0) * upward, (up[2] ?? 0) * upward, 0,
        0, 0, 0, 1,
        x ?? 0, y ?? 0, z ?? 0, 0,
    ]);
}

/** The luminance along the strip's right half at the plot's angles, between its pixels. */
function alongStrip(data: Float32Array) {
    const row = Math.floor(ROWS / 2) * STRIP;
    const across = Math.tan(REACH * DEG);
    return Array.from({ length: POINTS }, (_, i) => {
        const at = ((Math.tan(angleAt(i) * DEG) / across + 1) / 2) * STRIP - 0.5;
        const i0 = Math.min(Math.max(Math.floor(at), 0), STRIP - 2);
        const t = Math.min(Math.max(at - i0, 0), 1);
        const pixel = (k: number) => luminanceOf(data[(row + k) * 4], data[(row + k) * 4 + 1], data[(row + k) * 4 + 2]);
        return pixel(i0) * (1 - t) + pixel(i0 + 1) * t;
    });
}

function ensurePasses() {
    const table = tables();
    if (!gpu.device || !table) return null;
    if (passes?.luts === table.luts) return passes;
    if (building === table.luts) return null;
    const luts = table.luts;
    building = luts;
    const options = {
        luts,
        format: "rgba32float" as const,
        toneMap: false as const,
        dither: false,
        sunDisc: false,
        veil: 0,
        groundLight: quality.groundLight,
    };
    Promise.all([createSkyPass(gpuDevice(), { ...options, aureole: false }), createSkyPass(gpuDevice(), options)]).then(
        ([plain, glowing]) => {
            if (building !== luts) {
                plain.destroy();
                glowing.destroy();
                return;
            }
            passes?.plain.destroy();
            passes?.glowing.destroy();
            passes = { luts, plain, glowing };
            building = null;
            profileFor = "";
            request();
        },
    );
    return null;
}

/** Reads the profile for the chosen moment, place and height, once per change. */
async function read(made: NonNullable<typeof passes>, key: string) {
    const device = gpuDevice();
    const time = fromJulianDay(state.jd);
    const sunDirection = sun.direction(time, state);
    const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
    const observerHeightM = clampObserverHeight(state.heightM);
    const apparent = apparentDirection(sunDirection, made.luts.model, observerHeightM);
    strips ??= [0, 1].map(() =>
        device.createTexture({
            label: "sternwarte:glows",
            size: [STRIP, ROWS],
            format: "rgba32float",
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        }),
    ) as [GPUTexture, GPUTexture];
    const encoder = device.createCommandEncoder();
    [made.plain, made.glowing].forEach((pass, i) => {
        pass.update({
            sunDirection,
            sunAngularDiameter,
            observerHeightM,
            inverseViewProjection: stripCamera(apparent),
            projectionDistance: 0,
            ev100: UNIT_EV100,
        });
        pass.encode(encoder, (strips as [GPUTexture, GPUTexture])[i] as GPUTexture);
    });
    device.queue.submit([encoder.finish()]);
    const [plain, glowing, sunlight, ev100] = await Promise.all([
        readTexture(device, strips[0]),
        readTexture(device, strips[1]),
        made.glowing.sunIlluminance(),
        made.glowing.meteredEV100(),
    ]).catch(() => [null, null, null, null] as const);
    if (!plain || !glowing || !sunlight || ev100 === null || reading !== key || passes !== made) return;

    const illuminance = luminanceOf(...sunlight);
    const radius = sunAngularDiameter / 2;
    const r = radius * DEG;
    const disc = illuminance / (Math.PI * r * r);
    const sky = alongStrip(plain.data as Float32Array);
    const withAureole = alongStrip(glowing.data as Float32Array);
    const lines: Record<string, number[]> = {
        sky,
        aureole: [],
        disc: [],
        solar: [],
        lens: [],
        eye: [],
        cloud: [],
        spike: [],
        total: [],
    };
    const thin = coronaShare(Math.exp(-0.5));
    for (let i = 0; i < POINTS; ++i) {
        const angle = angleAt(i);
        const radii = angle / radius;
        const x = 1 / radii;
        // Baumbach's corona as the pass draws it, fading out towards 40 radii.
        const fade = Math.min(Math.max((40 - radii) / 10, 0), 1);
        const solar =
            radii < 1
                ? 0
                : disc *
                  1.24e-6 *
                  (0.0532 * x ** 2.5 + 1.425 * x ** 7 + 2.565 * x ** 17) *
                  fade *
                  fade *
                  (3 - 2 * fade);
        const veil = illuminance * veilingGlare(angle);
        const sigma = 0.7 * r;
        lines.aureole?.push(Math.max((withAureole[i] ?? 0) - (sky[i] ?? 0), 0));
        lines.disc?.push(radii < 1 ? disc : 0);
        lines.solar?.push(solar);
        lines.lens?.push(veil * LENS_VEIL);
        lines.eye?.push(veil);
        lines.cloud?.push(illuminance * thin * diffractionLobe(angle, 550));
        lines.spike?.push(
            (illuminance * 1.1e-4) / (3 * Math.sqrt(2 * Math.PI) * sigma * Math.PI * ((angle * DEG) ** 2 + r * r)),
        );
        lines.total?.push((withAureole[i] ?? 0) + (radii < 1 ? disc : 0) + solar + veil * LENS_VEIL);
    }
    profile = { lines, radius, illuminance, ev100 };
    profileFor = key;
    request();
}

function exposure() {
    if (metered.getAttribute("aria-pressed") === "true" && profile) {
        slider.value = String(Math.min(Math.max(profile.ev100, Number(slider.min)), Number(slider.max)));
    }
    paintRange(slider);
    const ev100 = Number(slider.value);
    find('[data-field="exposureValue"]', root).textContent = ev100.toFixed(1);
    return ev100;
}

function draw() {
    const made = ensurePasses();
    const key = `${state.jd},${state.latitude},${state.longitude},${state.heightM}`;
    if (made && key !== profileFor && key !== reading) {
        reading = key;
        read(made, key);
    }
    const ev100 = exposure();
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 340];
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const left = 2.4 * parseFloat(getComputedStyle(svgEl).fontSize) + LABEL_GAP;
    const [right, top, bottom] = [width - MARGIN.right, MARGIN.top, height - MARGIN.bottom];
    const x = (angle: number) => left + ((Math.log10(angle) - ANGLES[0]) / (ANGLES[1] - ANGLES[0])) * (right - left);
    const y = (luminance: number) => {
        const decades = Math.log10(Math.max(luminance, 1e-30));
        return (
            bottom -
            ((Math.min(Math.max(decades, LUMINANCES[0] - 1), LUMINANCES[1] + 1) - LUMINANCES[0]) /
                (LUMINANCES[1] - LUMINANCES[0])) *
                (bottom - top)
        );
    };
    const line = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
        `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" class="${cls}"/>`;
    let svg = `<defs><clipPath id="glows-clip"><rect x="${f(left)}" y="${f(top)}" width="${f(right - left)}" height="${f(bottom - top)}"/></clipPath></defs>`;
    for (let decade = LUMINANCES[0]; decade <= LUMINANCES[1]; decade += 2) {
        svg += line(left, y(10 ** decade), right, y(10 ** decade), "figure-grid");
        const label =
            decade === 0 ? "1" : `10${String(decade).replace(/\d/g, (digit) => SUPERSCRIPT[Number(digit)] ?? "")}`;
        svg += svgText(left - LABEL_GAP, y(10 ** decade), label, "figure-grid-label figure-anchor-end");
    }
    for (const angle of [0.1, 1, 10, 30]) {
        svg += line(x(angle), top, x(angle), bottom, "figure-grid");
        svg += svgText(
            x(angle),
            bottom + 12,
            `${angle}°`,
            angle === 30 ? "figure-label figure-anchor-end" : "figure-label",
        );
    }
    svg += svgText((left + right) / 2, height - 6, "angle from the Sun's center", "figure-label");
    svg += svgText(left + LABEL_GAP, top + 11, "cd/m²", "figure-label figure-anchor-start");

    const white = 1.2 * 2 ** ev100;
    const note = find('[data-field="note"]', root);
    if (profile) {
        const { lines, radius, illuminance } = profile;
        svg += line(x(radius), top, x(radius), bottom, "figure-grid");
        svg += svgText(x(radius), bottom + 12, "limb", "figure-label");
        let curves = "";
        for (const name of ["sky", "aureole", "solar", "spike", "cloud", "eye", "lens", "disc", "total"]) {
            const values = lines[name] ?? [];
            // The disc ends at the limb: its line drops there.
            const points = values.map((value, i) => `${f(x(angleAt(i)))},${f(y(value))}`);
            curves += `<polyline points="${points.join(" ")}" class="glows-line glows-${name}"/>`;
        }
        svg += `<g clip-path="url(#glows-clip)">${curves}</g>`;
        // How far out the picture is above white, from the Sun's center on.
        const total = lines.total ?? [];
        const first = total.findIndex((value) => value < white);
        const reach = first < 0 ? REACH : first === 0 ? 0 : angleAt(first);
        if (white < 10 ** LUMINANCES[1] && white > 10 ** LUMINANCES[0]) {
            svg += `<rect x="${f(left)}" y="${f(top)}" width="${f(right - left)}" height="${f(y(white) - top)}" class="glows-burnt"/>`;
            svg += line(left, y(white), right, y(white), "glows-white");
            svg += svgText(
                right - LABEL_GAP,
                y(white) - 7,
                "white",
                "figure-label figure-anchor-end glows-white-label",
            );
        }
        if (reach > 0.1 && reach < REACH) svg += line(x(reach), y(white), x(reach), bottom, "glows-reach");
        const whiteText = `White at EV100 ${ev100.toFixed(1)} is ${Math.round(white).toLocaleString("en-US")} cd/m²`;
        if (illuminance <= 0) note.textContent = `${whiteText}. The Sun is down: nothing of it reaches the observer.`;
        else if (first < 0) note.textContent = `${whiteText}: the picture is white out to ${REACH}° and beyond.`;
        else if (reach <= 0.1) note.textContent = `${whiteText}: nothing burns out, the disc shows as it is.`;
        else
            note.textContent = `${whiteText}: the picture is white out to ${reach.toFixed(reach < 1 ? 2 : 1)}° from the Sun's center, ${(reach / radius).toFixed(1)} of its radii.`;
    } else {
        note.textContent = gpu.error ? "This figure needs WebGPU." : "";
    }
    drawSvg(svgEl, svg, 1);
}

const request = onDemand(draw, root);

if (!gpu.error) {
    onTables(() => request());
    onChange(() => request());
    new ResizeObserver(() => request()).observe(svgEl);
    slider.addEventListener("input", () => {
        metered.setAttribute("aria-pressed", "false");
        request();
    });
    metered.addEventListener("click", () => {
        metered.setAttribute("aria-pressed", String(metered.getAttribute("aria-pressed") !== "true"));
        request();
    });
}
request();
