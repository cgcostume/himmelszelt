import { DEFAULT_ATMOSPHERE_MODEL, rayleighAt, rgbOfSpectrum, solarIrradianceAt } from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, LABEL_GAP as GAP, STRIP_MARGIN as MARGIN, stripMoment, svgText } from "../sternzeit/figure";
import "../sternzeit/export";

// The visible spectrum and a little of the ultraviolet and infrared on either side, faded out where the eye stops seeing.
const FIRST_NM = 360;
const LAST_NM = 800;
const VISIBLE = [400, 700];
const TICKS = [400, 500, 600, 700];
// The scattering per km at sea level, up to a little over the top row; the curve leaves the plot past it.
const TOP = 0.0445;
// Blue and red, the two wavelengths marked on the curve; red is the one the second scale counts multiples of.
const BLUE_NM = 440;
const RED_NM = 680;
// The scattering per km on the left, the main scale; multiples of red's on the right, the second one.
const PER_KM = [0.01, 0.02, 0.03, 0.04];
const TIMES_RED = [2, 4, 6];
// Where the haze line is named.
const MIE_LABEL_NM = 405;
// The sunlight as the plot's baseline, a strip of its colors this thick, in px.
const BASELINE = 2;
// Room over the plot for the top row's label, and the length of the second scale's ticks.
const HEADER = 0;
const TICK = 6;

const svgEl = find<SVGSVGElement>("#scattering .scattering-panel > svg");
let hovered: number | null = null;
const requestRender = onDemand(() => render(), svgEl);
const f = (n: number) => n.toFixed(1);
const range = (step: number) => Array.from({ length: (LAST_NM - FIRST_NM) / step + 1 }, (_, i) => FIRST_NM + i * step);

// The linear sRGB one nanometer of light adds, whatever the Sun sends there: the library's color matching, read off
// by a spectrum that is the Sun's inverse at that wavelength and zero elsewhere.
const MATCHING = range(1).map((nm) => rgbOfSpectrum((w) => (w === nm ? 1 / solarIrradianceAt(w) : 0)));
const matching = (nm: number) => MATCHING[Math.round(nm) - FIRST_NM] ?? [0, 0, 0];
const encode = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
/** A linear sRGB color as CSS, scaled to its brightest channel, the parts outside the gamut cut off. */
function css(rgb: readonly number[], brightness = 1) {
    const clipped = rgb.map((c) => Math.max(0, c));
    const top = Math.max(...clipped);
    if (!(top > 0)) return "rgb(0 0 0)";
    return `rgb(${clipped.map((c) => encode((brightness * c) / top)).join(" ")})`;
}

const mieScattering = DEFAULT_ATMOSPHERE_MODEL.mie.betaScattering[0] ?? 0;

/**
 * A spectrum as a strip of its colors, each as bright as the spectrum is there, to its peak; and the one color it adds
 * up to. The ends keep the hues of 400 and 650 nm: past 650 the color matching's fit drifts towards yellow.
 */
function spectrum(id: string, name: string, power: (nm: number) => number) {
    const peak = Math.max(...range(1).map(power)) || 1;
    const stops = range(5)
        .map((nm) => {
            const offset = ((nm - FIRST_NM) / (LAST_NM - FIRST_NM)).toFixed(3);
            const hue = matching(Math.min(Math.max(nm, 400), 650));
            return `<stop offset="${offset}" stop-color="${css(hue, power(nm) / peak)}"/>`;
        })
        .join("");
    return {
        id: `scattering-${id}`,
        name,
        stops,
        color: css(rgbOfSpectrum((nm) => power(nm) / solarIrradianceAt(nm))),
    };
}
type Spectrum = ReturnType<typeof spectrum>;
// The sunlight above the air, the plot's baseline.
const SUNLIGHT = spectrum("sunlight", "sunlight", solarIrradianceAt);
/** Everything drawn over a spectrum fades out into the ultraviolet and the infrared, by a mask of this id. */
function fade(id: string, left: number, right: number, height: number) {
    const edge = (nm: number, opacity: number) =>
        `<stop offset="${((nm - FIRST_NM) / (LAST_NM - FIRST_NM)).toFixed(3)}" stop-color="white" stop-opacity="${opacity}"/>`;
    return (
        `<linearGradient id="${id}-edges">${edge(FIRST_NM, 0)}${edge(VISIBLE[0] ?? 0, 1)}${edge(VISIBLE[1] ?? 0, 1)}${edge(LAST_NM, 0)}</linearGradient>` +
        `<mask id="${id}"><rect x="${f(left)}" width="${f(right - left)}" height="${height}" fill="url(#${id}-edges)"/></mask>`
    );
}

/** A spectrum named at its right end, where it has faded out, with the color it adds up to. */
const SWATCH = 10;
const named = (s: Spectrum, width: number, middle: number) =>
    `<rect x="${f(width - SWATCH)}" y="${f(middle - SWATCH / 2)}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${s.color}" class="scattering-swatch"/>` +
    svgText(width - SWATCH - GAP, middle, s.name, "figure-label figure-anchor-end");

const perKm = (beta: number) => `${beta.toFixed(2)}\u202F/km`;
// How wide the scale's labels on the left are, measured once on a label drawn and taken away again.
// And how wide the spectra's names on the right, measured on the widest.
const measured = new Map<string, number>();
function measure(text: string, cls: string, fallback: number) {
    const key = `${cls} ${text}`;
    const known = measured.get(key);
    if (known) return known;
    const probe = document.createElementNS("http://www.w3.org/2000/svg", "text");
    probe.setAttribute("class", cls);
    probe.textContent = text;
    svgEl.append(probe);
    const width = probe.getBBox().width;
    probe.remove();
    if (width > 0) measured.set(key, width);
    return width || fallback;
}

/** The plot and its spectra between the scale's labels on the left, the ultraviolet starting at the zero, and their names. */
function layout() {
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 140];
    const left = measure(perKm(0.04), "figure-grid-label strip-tick", 60) + GAP;
    const right = width - SWATCH - GAP - measure("sunlight", "figure-label", 50) - GAP;
    const plot = { top: MARGIN.top + HEADER, bottom: height - MARGIN.bottom - GAP };
    const x = (nm: number) => left + ((nm - FIRST_NM) / (LAST_NM - FIRST_NM)) * (right - left);
    const y = (beta: number) => plot.bottom - (beta / TOP) * (plot.bottom - plot.top);
    const nmAt = (px: number) => FIRST_NM + ((px - left) / (right - left)) * (LAST_NM - FIRST_NM);
    return { width, height, left, right, plot, x, y, nmAt };
}

function render() {
    renderPlot();
}

function renderPlot() {
    const { width, height, left, right, plot, x, y } = layout();
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const line = (y0: number, cls: string) => `<line x1="0" y1="${f(y0)}" x2="${width}" y2="${f(y0)}" class="${cls}"/>`;
    let svg = `<defs><linearGradient id="${SUNLIGHT.id}">${SUNLIGHT.stops}</linearGradient>${fade("scattering-fade", left, right, height)}</defs>`;

    // The scattering per km, labeled on the left; multiples of red's, ticked and labeled on the right.
    const red = rayleighAt(RED_NM);
    for (const beta of PER_KM) {
        svg += line(y(beta), "figure-grid scattering-row");
        svg += svgText(0, y(beta), perKm(beta), "figure-grid-label strip-tick");
    }
    svg += svgText(0, y(0), "0".padStart(perKm(0).length, "\u2007"), "figure-grid-label strip-tick");
    for (const times of TIMES_RED) {
        svg += line(y(times * red), "scattering-tick");
        svg += svgText(width, y(times * red), `${times}×`, "figure-grid-label scattering-times");
    }

    // The curves stop at the plot's top. The sunlight, a thin strip of its colors, is their baseline.
    svg += `<clipPath id="scattering-clip"><rect y="${f(plot.top - 4)}" width="${width}" height="${height}"/></clipPath>`;
    svg += `<g mask="url(#scattering-fade)" clip-path="url(#scattering-clip)">`;
    svg += `<rect x="${f(left)}" y="${f(y(0) - BASELINE / 2)}" width="${f(right - left)}" height="${BASELINE}" fill="url(#${SUNLIGHT.id})" class="scattering-spectrum"/>`;
    svg += `<line x1="0" y1="${f(y(mieScattering))}" x2="${width}" y2="${f(y(mieScattering))}" class="scattering-mie"/>`;
    const points = range(2)
        .map((nm) => `${f(x(nm))},${f(y(rayleighAt(nm)))}`)
        .join(" ");
    svg += `<polyline points="${points}" class="scattering-line"/>`;
    svg += "</g>";
    svg += named(SUNLIGHT, width, y(0));

    // Blue and red marked on the curve, each with how many times red's it is; the curve and the haze line named.
    for (const nm of [BLUE_NM, RED_NM]) {
        const [px, py] = [x(nm), y(rayleighAt(nm))];
        const times = rayleighAt(nm) / red;
        svg += `<circle cx="${f(px)}" cy="${f(py)}" r="3" class="scattering-bubble"/>`;
        const label = `${nm} nm: ${times.toFixed(times < 1.05 ? 0 : 1)}×`;
        svg += svgText(px + GAP, py - GAP - 2, label, "figure-label figure-anchor-start");
    }
    // Named halfway between the 0.02 and 0.03 rows, just right of where the curve crosses that height: λ⁻⁴ inverted.
    const nameBeta = ((PER_KM[1] ?? 0) + (PER_KM[2] ?? 0)) / 2;
    const [rx, ry] = [x(RED_NM * (red / nameBeta) ** 0.25) + 2 * GAP, y(nameBeta)];
    svg += svgText(rx, ry, "air molecules: Rayleigh", "figure-label figure-anchor-start");
    svg += svgText(x(MIE_LABEL_NM), y(mieScattering) - GAP - 2, "haze: Mie", "figure-label figure-anchor-start");

    // The wavelengths under the sunlight, the ultraviolet and the infrared at its faded ends.
    const labelY = height - MARGIN.bottom / 2;
    for (const nm of TICKS) svg += svgText(x(nm), labelY, `${nm} nm`, "figure-label");
    svg += svgText(x(FIRST_NM), labelY, "UV", "figure-label figure-anchor-start");
    svg += svgText(x(LAST_NM), labelY, "IR", "figure-label figure-anchor-end");

    if (hovered !== null) {
        const nm = Math.round(hovered);
        const beta = rayleighAt(nm);
        const left = x(nm) > width / 2;
        svg += stripMoment(x(nm), y(beta), plot.top, plot.bottom, "scattering-hover");
        svg += svgText(
            x(nm) + (left ? -GAP : GAP),
            (plot.top + y(PER_KM.at(-1) ?? 0)) / 2,
            `${nm} nm: ${beta.toFixed(4)} /km, ${(beta / red).toFixed(1)}× red`,
            `figure-note figure-anchor-${left ? "end" : "start"}`,
        );
    }
    drawSvg(svgEl, svg, 1);
    // The second scale's ticks a gap left of its labels, and the rows a gap short of the labels on either side, all
    // measured once drawn.
    const boxes = (selector: string) =>
        [...svgEl.querySelectorAll<SVGTextElement>(selector)].map((text) => text.getBBox());
    const start = Math.max(...boxes(".strip-tick").map((box) => box.x + box.width)) + GAP;
    const tickEnd = Math.min(...boxes(".scattering-times").map((box) => box.x)) - GAP;
    for (const tick of svgEl.querySelectorAll(".scattering-tick")) {
        tick.setAttribute("x1", f(tickEnd - TICK));
        tick.setAttribute("x2", f(tickEnd));
    }
    for (const row of svgEl.querySelectorAll(".scattering-row")) {
        row.setAttribute("x1", f(start));
        row.setAttribute("x2", f(tickEnd - TICK - GAP));
    }
}

// Hovering reads the air's scattering off at a wavelength, per km and against red's, in the row over the top line.
svgEl.addEventListener("pointermove", (event: PointerEvent) => {
    const { left, right, nmAt } = layout();
    const px = event.clientX - svgEl.getBoundingClientRect().left;
    hovered = px < left || px > right ? null : Math.min(LAST_NM, Math.max(FIRST_NM, nmAt(px)));
    requestRender();
});
svgEl.addEventListener("pointerleave", () => {
    hovered = null;
    requestRender();
});
new ResizeObserver(requestRender).observe(svgEl);
render();
