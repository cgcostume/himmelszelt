import {
    DEFAULT_ATMOSPHERE_MODEL,
    DEFAULT_WAVELENGTHS,
    RGB_ATMOSPHERE_MODEL,
    rayleighAt,
    rgbOfSpectrum,
    solarIrradianceAt,
} from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, LABEL_GAP as GAP, STRIP_MARGIN as MARGIN, stripMoment, svgText } from "../sternzeit/figure";
import "../sternzeit/export";

// The visible spectrum and a little of the ultraviolet and infrared on either side, faded out where the eye stops seeing.
const FIRST_NM = 360;
const LAST_NM = 800;
const VISIBLE = [400, 700];
const TICKS = [400, 500, 600, 700];
// The scattering per km at sea level, up to a little over Rayleigh's at 400 nm.
const TOP = 8.6 * rayleighAt(680);
// Red, 680 nm, the reference the rows count multiples of.
const RED_NM = 680;
const TIMES_RED = [2, 4, 6, 8];
// The two spectra under the plot, sunlight and skylight: each a strip this thick, in a row this tall, in pixels.
const STRIP = 4;
const ROW = 14;
// Room over the plot for the axis' name.
const HEADER = 18;
// Room under the plot's zero for the label under Mie's line, close above it.
const BELOW_ZERO = 10;

const svgEl = find<SVGSVGElement>(".scattering-panel > svg");
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
    return `rgb(${clipped.map((c) => encode((brightness * c) / top)).join(" ")})`;
}

const mie = DEFAULT_ATMOSPHERE_MODEL.mie.betaScattering[0] ?? 0;
// Bruneton & Neyret's three wavelengths, taken as red, green and blue.
const BRUNETON = [...new Set(RGB_ATMOSPHERE_MODEL.wavelengths)];
const ours = (nm: number) => (DEFAULT_WAVELENGTHS as readonly number[]).includes(nm);

/**
 * A spectrum as a strip of its colors, each as bright as the spectrum is there, to its peak; and the one color it adds
 * up to. The ends keep the hues of 400 and 650 nm: past 650 the color matching's fit drifts towards yellow.
 */
function spectrum(name: string, power: (nm: number) => number) {
    const peak = Math.max(...range(1).map(power));
    const stops = range(5)
        .map((nm) => {
            const offset = ((nm - FIRST_NM) / (LAST_NM - FIRST_NM)).toFixed(3);
            const hue = matching(Math.min(Math.max(nm, 400), 650));
            return `<stop offset="${offset}" stop-color="${css(hue, power(nm) / peak)}"/>`;
        })
        .join("");
    return {
        name,
        id: `scattering-${name}`,
        stops,
        color: css(rgbOfSpectrum((nm) => power(nm) / solarIrradianceAt(nm))),
    };
}
const skylight = (nm: number) => solarIrradianceAt(nm) * rayleighAt(nm);
const SPECTRA = [
    { ...spectrum("sunlight", solarIrradianceAt), curve: "scattering-sun" },
    { ...spectrum("skylight", skylight), curve: "scattering-sky" },
];

function layout() {
    const [width, height] = [svgEl.clientWidth || 600, svgEl.clientHeight || 140];
    const plot = { top: MARGIN.top + HEADER, bottom: height - MARGIN.bottom - GAP - SPECTRA.length * ROW - BELOW_ZERO };
    const x = (nm: number) => ((nm - FIRST_NM) / (LAST_NM - FIRST_NM)) * width;
    const y = (beta: number) => plot.bottom - (beta / TOP) * (plot.bottom - plot.top);
    const nmAt = (px: number) => FIRST_NM + (px / width) * (LAST_NM - FIRST_NM);
    return { width, height, plot, x, y, nmAt };
}

function render() {
    const { width, height, plot, x, y } = layout();
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const line = (y0: number, cls: string) => `<line x1="0" y1="${f(y0)}" x2="${width}" y2="${f(y0)}" class="${cls}"/>`;

    // Everything drawn over the spectrum fades out into the ultraviolet and the infrared.
    const edge = (nm: number, opacity: number) =>
        `<stop offset="${((nm - FIRST_NM) / (LAST_NM - FIRST_NM)).toFixed(3)}" stop-color="white" stop-opacity="${opacity}"/>`;
    let svg = "<defs>";
    for (const s of SPECTRA) svg += `<linearGradient id="${s.id}">${s.stops}</linearGradient>`;
    svg += `<linearGradient id="scattering-edges">${edge(FIRST_NM, 0)}${edge(VISIBLE[0] ?? 0, 1)}${edge(VISIBLE[1] ?? 0, 1)}${edge(760, 0)}</linearGradient>`;
    svg += `<mask id="scattering-fade"><rect width="${width}" height="${height}" fill="url(#scattering-edges)"/></mask></defs>`;

    // The scattering as multiples of red's, labeled on the left.
    const red = rayleighAt(RED_NM);
    for (const times of TIMES_RED) {
        svg += line(y(times * red), "figure-grid scattering-row");
        svg += svgText(0, y(times * red) - 4, `${times}\u00D7`, "figure-grid-label strip-tick");
    }
    svg += line(plot.bottom, "figure-grid");
    // What the rows count, named over them.
    svg += svgText(0, MARGIN.top, "\u00D7 red\u2019s, at 680\u202fnm", "figure-label figure-anchor-start");

    // The curves stop at the plot's top, under the axis' name.
    svg += `<clipPath id="scattering-clip"><rect y="${f(plot.top - 4)}" width="${width}" height="${height}"/></clipPath>`;
    svg += `<g mask="url(#scattering-fade)" clip-path="url(#scattering-clip)">`;
    svg += `<line x1="0" y1="${f(y(mie))}" x2="${width}" y2="${f(y(mie))}" class="scattering-mie"/>`;
    const points = range(2)
        .map((nm) => `${f(x(nm))},${f(y(rayleighAt(nm)))}`)
        .join(" ");
    svg += `<polyline points="${points}" class="scattering-line"/>`;
    // The sunlight and the skylight on the same scale, each as a multiple of its own red: the skylight is the sunlight
    // times the air's scattering, so at every color its height is theirs multiplied.
    for (const [cls, power] of [
        ["scattering-sun", solarIrradianceAt],
        ["scattering-sky", skylight],
    ] as const) {
        const atRed = power(RED_NM);
        const curve = range(2)
            .map((nm) => `${f(x(nm))},${f(y((power(nm) / atRed) * red))}`)
            .join(" ");
        svg += `<polyline points="${curve}" class="${cls}"/>`;
    }
    // The two spectra, each a strip on a row of its own.
    SPECTRA.forEach((s, i) => {
        const rowY = plot.bottom + BELOW_ZERO + GAP + i * ROW + (ROW - STRIP) / 2;
        svg += `<rect x="0" y="${f(rowY)}" width="${width}" height="${STRIP}" rx="${STRIP / 2}" fill="url(#${s.id})" class="scattering-spectrum"/>`;
    });
    svg += "</g>";
    // Named at their right end, where they have faded out, each with the color it adds up to.
    const [SWATCH, SAMPLE] = [10, 22];
    SPECTRA.forEach((s, i) => {
        const middle = plot.bottom + BELOW_ZERO + GAP + i * ROW + ROW / 2;
        svg += `<rect x="${f(width - SWATCH)}" y="${f(middle - SWATCH / 2)}" width="${SWATCH}" height="${SWATCH}" rx="2" fill="${s.color}" class="scattering-swatch"/>`;
        // Between name and swatch, a sample of the curve it is in the plot.
        const [from, to] = [width - SWATCH - GAP - SAMPLE, width - SWATCH - GAP];
        svg += `<line x1="${f(from)}" y1="${f(middle)}" x2="${f(to)}" y2="${f(middle)}" class="${s.curve}"/>`;
        svg += svgText(from - GAP, middle, s.name, "figure-label figure-anchor-end");
    });

    // dunstkreis' four wavelengths as dots on the line, Bruneton's three as rings the line breaks off in: 440, both.
    for (const nm of [...new Set([...DEFAULT_WAVELENGTHS, ...BRUNETON])]) {
        const [px, py] = [x(nm), y(rayleighAt(nm))];
        if (BRUNETON.includes(nm)) svg += `<circle cx="${f(px)}" cy="${f(py)}" r="5" class="scattering-bruneton"/>`;
        if (ours(nm)) svg += `<circle cx="${f(px)}" cy="${f(py)}" r="2.5" class="scattering-sample"/>`;
        const cls = `figure-label figure-anchor-start${ours(nm) ? "" : " scattering-bruneton-label"}`;
        svg += svgText(px + GAP, py - GAP - 2, nm, cls);
    }
    // The legend, in the empty space over the red end: a sample of each, its name beside it.
    const legend = [
        ["Rayleigh: air", `<line x1="-10" y1="0" x2="10" y2="0" class="scattering-line"/>`, ""],
        ["Mie: haze", `<line x1="-10" y1="0" x2="10" y2="0" class="scattering-mie"/>`, ""],
        ["dunstkreis\u2019 wavelengths", `<circle r="2.5" class="scattering-sample"/>`, ""],
        ["Bruneton\u2019s wavelengths", `<circle r="5" class="scattering-bruneton"/>`, " scattering-bruneton-label"],
    ];
    const [lx, ly] = [x(650), y(8 * red)];
    legend.forEach(([name, sample, cls], i) => {
        const rowY = ly + i * 18;
        svg += `<g transform="translate(${f(lx)} ${f(rowY)})">${sample}</g>`;
        svg += svgText(lx + 18, rowY, name ?? "", `figure-label figure-anchor-start scattering-legend${cls}`);
    });

    // The wavelengths under the spectra, the ultraviolet and the infrared at their ends.
    const labelY = height - MARGIN.bottom / 2;
    for (const nm of TICKS) svg += svgText(x(nm), labelY, `${nm} nm`, "figure-label");
    svg += svgText(x(FIRST_NM), labelY, "UV", "figure-label figure-anchor-start");
    svg += svgText(x(LAST_NM), labelY, "IR", "figure-label figure-anchor-end");

    if (hovered !== null) {
        const nm = Math.round(hovered);
        const beta = rayleighAt(nm);
        const left = x(nm) > width / 2;
        svg += stripMoment(x(nm), y(beta), plot.top, plot.bottom, "scattering-hover");
        svg += svgText(
            x(nm) + (left ? -GAP : GAP),
            (plot.top + plot.bottom) / 2,
            `${nm} nm: ${beta.toFixed(4)} /km, ${(beta / red).toFixed(1)}× red`,
            `figure-note figure-anchor-${left ? "end" : "start"}`,
        );
    }
    drawSvg(svgEl, svg, 1);
    // The rows stop a gap short of their labels, measured once drawn.
    const labels = [...svgEl.querySelectorAll<SVGTextElement>(".strip-tick")].map((text) => text.getBBox());
    const start = Math.max(...labels.map((box) => box.x + box.width)) + GAP;
    for (const row of svgEl.querySelectorAll(".scattering-row")) row.setAttribute("x1", f(start));
}

// Hovering reads the air's scattering off at a wavelength, per km and against red's.
svgEl.addEventListener("pointermove", (event: PointerEvent) => {
    const { width, nmAt } = layout();
    const px = event.clientX - svgEl.getBoundingClientRect().left;
    hovered = px < 0 || px > width ? null : Math.min(LAST_NM, Math.max(FIRST_NM, nmAt(px)));
    requestRender();
});
svgEl.addEventListener("pointerleave", () => {
    hovered = null;
    requestRender();
});

new ResizeObserver(requestRender).observe(svgEl);
render();
