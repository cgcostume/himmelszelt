import { colorFromColorIndex, temperatureFromColorIndex } from "@himmelszelt/sternenheer";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, escapeText, svgText } from "../sternzeit/figure";
import { colorIndexBand, swatch } from "./colorindex";
import { FILM_STARS, told } from "./filmstars";
import { bindStarGroups, picked } from "./stargroups";

/** A catalog's histogram as `scripts/star-colors.mjs` writes it: stars per bin and class of magnitude, the brightest
 *  first, their light as shares of the catalog's, per bin its brightest stars, and the film stars' magnitude and B-V. */
interface Histogram {
    bins: { start: number; width: number; count: number };
    splits: number[];
    total: number;
    skipped: number;
    median: number;
    count: number[][];
    light: number[][];
    top: [string, number][][];
    films: Record<string, [number, number]>;
}
const CATALOGS = ["yale", "hipparcos", "tycho"] as const;
type Catalog = (typeof CATALOGS)[number];

// The proper names of the catalog's brightest stars, the IAU's, by HR number.
const NAMES: Record<number, string> = {
    2491: "Sirius",
    2326: "Canopus",
    5340: "Arcturus",
    5459: "Rigil Kentaurus",
    7001: "Vega",
    1708: "Capella",
    1713: "Rigel",
    2943: "Procyon",
    472: "Achernar",
    2061: "Betelgeuse",
    5267: "Hadar",
    7557: "Altair",
    1457: "Aldebaran",
    6134: "Antares",
    5056: "Spica",
    2990: "Pollux",
    8728: "Fomalhaut",
    7924: "Deneb",
    4853: "Mimosa",
    3982: "Regulus",
    4730: "Acrux",
    5460: "Toliman",
    2618: "Adhara",
    2891: "Castor",
    4763: "Gacrux",
    6527: "Shaula",
    1790: "Bellatrix",
    1791: "Elnath",
    3685: "Miaplacidus",
    1903: "Alnilam",
    8425: "Alnair",
    4905: "Alioth",
    1017: "Mirfak",
    4301: "Dubhe",
    2693: "Wezen",
    5191: "Alkaid",
    3307: "Avior",
    6879: "Kaus Australis",
    2421: "Alhena",
    2088: "Menkalinan",
    3748: "Alphard",
    2294: "Mirzam",
    7790: "Peacock",
    6217: "Atria",
    6553: "Sargas",
    3485: "Alsephina",
    424: "Polaris",
};

// The plot's frame, as tall as the SVG's CSS height: temperatures over it, the color strip and B-V under it.
const MARGIN = { top: 28, bottom: 40, left: 36, right: 10 };
// Each magnitude class a step dimmer, the brightest stars on top in full color, as dim as they are in the sky.
const OPACITY = [1, 0.82, 0.66, 0.5];
const KELVIN = [20000, 10000, 7000, 5000, 4000, 3000];
const SUN_BV = 0.65;
const f = (n: number) => n.toFixed(1);
const minus = (text: string) => text.replace(/^-/, "−");
const bvText = (bv: number) => minus(bv.toFixed(2));
const percent = (share: number) => `${(share * 100).toFixed(share < 0.001 ? 2 : 1)}%`;
const grouped = (n: number) => Math.round(n).toLocaleString("en-US");
const kelvinText = (bv: number) => grouped(Math.round(temperatureFromColorIndex(bv) / 100) * 100);
const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
const LEADS: Record<Catalog, string> = {
    yale: "The Yale catalog's",
    hipparcos: "With the Hipparcos stars,",
    tycho: "With Tycho-2's,",
};

// The B-V a temperature stands at by Ballesteros' formula, bisected, as it falls.
function bvOfKelvin(kelvin: number) {
    let [lo, hi] = [-0.6, 4];
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (temperatureFromColorIndex(mid) > kelvin) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

/** The color histogram on `root`, its numbers from the JSON files under `data-base`, one per catalog. */
export function colorHistogramFigure(root: HTMLElement) {
    const plot = find<SVGSVGElement>("svg[data-field=plot]", root);
    const readout = find("[data-field=readout]", root);
    const buttons = [...root.querySelectorAll<HTMLButtonElement>("button[data-set]")];
    let measure: "count" | "light" = "count";
    let hovered: number | null = null;
    let data: Record<Catalog, Histogram> | null = null;
    let width = 0;
    const requestRender = onDemand(render, root);
    // Each film star once, with every work that names it.
    const filmOf = new Map<number, { name: string; works: string[] }>();
    for (const star of FILM_STARS) {
        const entry = filmOf.get(star.hr) ?? { name: star.name, works: [] };
        entry.works.push(told(star));
        filmOf.set(star.hr, entry);
    }
    const catalog = () => (CATALOGS.find((c) => c === picked(root, "catalog")) ?? "yale") as Catalog;
    const nameOf = (label: string) => {
        const hr = label.startsWith("HR ") ? Number(label.slice(3)) : 0;
        return filmOf.get(hr)?.name ?? NAMES[hr] ?? label;
    };

    function geometry(histogram: Histogram) {
        const { start, width: binWidth, count } = histogram.bins;
        const [left, right] = [MARGIN.left, width - MARGIN.right];
        const x = (bv: number) => left + ((bv - start) / (count * binWidth)) * (right - left);
        return { left, right, x, bin: (px: number) => Math.floor(((px - left) / (right - left)) * count) };
    }

    function render() {
        width = plot.clientWidth || 600;
        const height = plot.clientHeight || 240;
        plot.setAttribute("viewBox", `0 0 ${width} ${height}`);
        if (!data) return;
        const histogram = data[catalog()];
        const { start, width: binWidth, count: bins } = histogram.bins;
        const { left, right, x } = geometry(histogram);
        const [top, bottom] = [MARGIN.top, height - MARGIN.bottom];
        const shares = (h: Histogram) =>
            measure === "light" ? h.light : h.count.map((classes) => classes.map((n) => n / h.total));
        // One scale for every catalog, so a pick compares them bar by bar.
        const peak = Math.max(...CATALOGS.flatMap((c) => (data ? shares(data[c]).map(sum) : [])));
        const step = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2].find((s) => peak / s <= 5) ?? 0.5;
        const end = Math.ceil(peak / step) * step;
        const y = (share: number) => bottom - (share / end) * (bottom - top);
        let svg = "";
        for (let s = 0; s <= end + 1e-9; s += step) {
            svg += `<line x1="${f(left)}" y1="${f(y(s))}" x2="${f(right)}" y2="${f(y(s))}" class="figure-grid"/>`;
            svg += svgText(left - 6, y(s), `${Math.round(s * 100)}%`, "figure-grid-label");
        }
        // The temperatures along the top; a label too close to the last is left out.
        let lastX = Number.NEGATIVE_INFINITY;
        for (const kelvin of KELVIN) {
            const at = x(bvOfKelvin(kelvin));
            if (at < left + 24 || at > right - 18 || at - lastX < 52) continue;
            const unit = lastX === Number.NEGATIVE_INFINITY ? " K" : "";
            lastX = at;
            svg += `<line x1="${f(at)}" y1="${f(top - 6)}" x2="${f(at)}" y2="${f(top)}" class="colorhist-tick"/>`;
            svg += svgText(at, top - 16, `${grouped(kelvin)}${unit}`, "figure-label");
        }
        const gap = Math.min(2, (right - left) / bins / 4);
        const binShares = shares(histogram);
        // The hovered bin glows: a blue light rising from its top, fading out towards the top of the plot.
        svg += `<defs><linearGradient id="colorhist-glow" x1="0" y1="0" x2="0" y2="1">`;
        svg += `<stop offset="0" class="colorhist-glow-stop" stop-opacity="0"/>`;
        svg += `<stop offset="1" class="colorhist-glow-stop" stop-opacity="0.45"/></linearGradient></defs>`;
        for (let i = 0; i < bins; i++) {
            const [x0, x1] = [x(start + i * binWidth) + gap / 2, x(start + (i + 1) * binWidth) - gap / 2];
            const color = swatch(colorFromColorIndex(start + (i + 0.5) * binWidth));
            const classes = binShares[i] ?? [];
            const total = sum(classes);
            if (hovered === i) {
                const y1 = Math.min(y(total), bottom - 2) - 1;
                svg += `<rect x="${f(x0 - gap / 2)}" y="${f(top)}" width="${f(x1 - x0 + gap)}" height="${f(Math.max(y1 - top, 0))}" fill="url(#colorhist-glow)"/>`;
            }
            // While a bin is hovered, it a little brighter and the others a little dimmer.
            const lift = hovered === null ? 1 : hovered === i ? 1.2 : 0.8;
            // The faintest stars at the foot, the brightest on top, a hairline of the panel between them.
            let base = 0;
            for (let c = classes.length - 1; c >= 0; c--) {
                const share = classes[c] ?? 0;
                if (share <= 0) continue;
                const [y0, y1] = [y(base), y(base + share)];
                const h = Math.max(0.5, y0 - y1 - (base > 0 ? 1 : 0));
                svg += `<rect x="${f(x0)}" y="${f(y0 - (base > 0 ? 1 : 0) - h)}" width="${f(x1 - x0)}" height="${f(h)}" fill="${color}" fill-opacity="${Math.min((OPACITY[c] ?? 1) * lift, 1).toFixed(2)}"/>`;
                base += share;
            }
        }
        // The median of the stars picked; the Sun, which the catalogs do not hold, stands in the numbers' row below.
        const median = x(histogram.median);
        svg += `<line x1="${f(median)}" y1="${f(top)}" x2="${f(median)}" y2="${f(bottom)}" class="colorhist-marker"/>`;
        svg += svgText(median - 4, top + 8, "median", "figure-note figure-anchor-end");
        svg += `<line x1="${f(left)}" y1="${f(bottom)}" x2="${f(right)}" y2="${f(bottom)}" class="colorhist-axis"/>`;
        // Under the axis the colors the stars are drawn in: the color index figure's strip, on this axis.
        const strip = { x0: left, x1: right, y: bottom + 5, at: x, from: start, to: start + bins * binWidth };
        const colors = colorIndexBand(`${root.id}-band`, "ballesteros", strip);
        svg += `<defs>${colors.gradient}</defs>${colors.bar}`;
        // The numbers as the color index figure's slider has them, the Sun a tick with its name after it; where the
        // plot is narrow, the halves give way and the name centers on its index.
        const narrow = right - left < 288;
        // As far below the strip as the slider's numbers sit below its rail.
        const scaleY = bottom + 30;
        for (const bv of [0, 0.5, 1, 1.5, 2])
            if (!narrow || bv % 1 === 0) svg += svgText(x(bv), scaleY, String(bv), "colorhist-scale");
        const sun = x(SUN_BV);
        if (narrow) svg += svgText(sun, scaleY, "Sun", "colorhist-scale colorhist-scale-sun");
        else {
            svg += `<line x1="${f(sun)}" y1="${f(scaleY - 6)}" x2="${f(sun)}" y2="${f(scaleY + 3.5)}" class="colorhist-scale-tick"/>`;
            svg += svgText(sun + 4, scaleY, "Sun", "colorhist-scale colorhist-scale-sun colorhist-scale-after");
        }
        drawSvg(plot, svg, 1);
        renderReadout(histogram);
    }

    // Two lines at most, each cut short where it does not fit: the bin, then its film stars and brightest stars.
    function renderReadout(histogram: Histogram) {
        const line = (html: string) => `<p>${html}</p>`;
        const c = catalog();
        if (hovered === null) {
            const first = `${LEADS[c]} ${grouped(histogram.total)} stars have a median B−V of ${bvText(histogram.median)}, about ${kelvinText(histogram.median)} K.`;
            const left = histogram.skipped
                ? `${grouped(histogram.skipped)} stars without a measured B−V are left out.`
                : "";
            readout.innerHTML = line(first) + line(left);
            return;
        }
        const i = hovered;
        const { start, width: binWidth, count: bins } = histogram.bins;
        const [lo, hi] = [start + i * binWidth, start + (i + 1) * binWidth];
        const range =
            i === 0
                ? `under ${bvText(hi)}`
                : i === bins - 1
                  ? `${bvText(lo)} and over`
                  : `${bvText(lo)} to ${bvText(hi)}`;
        const kelvin = `${i === 0 ? "over " : i === bins - 1 ? "under " : "about "}${kelvinText(i === 0 ? hi : i === bins - 1 ? lo : (lo + hi) / 2)} K`;
        const stars = sum(histogram.count[i] ?? []);
        const first = `B−V ${range}, ${kelvin}: ${grouped(stars)} ${stars === 1 ? "star" : "stars"}, ${percent(stars / histogram.total)} of them, ${percent(sum(histogram.light[i] ?? []))} of their light.`;
        // The bin's film stars first, however faint, then its brightest stars.
        const binOf = (bv: number) => Math.max(0, Math.min(bins - 1, Math.floor((bv - start) / binWidth + 1e-6)));
        const films = Object.entries(histogram.films)
            .filter(([, [, bv]]) => binOf(bv) === i)
            .sort((a, b) => a[1][0] - b[1][0])
            .map(([hr, [magnitude]]) => {
                const film = filmOf.get(Number(hr));
                const works = escapeText(film?.works.join("; ") ?? "");
                return `<span class="colorhist-name">${escapeText(film?.name ?? hr)}</span> ${minus(magnitude.toFixed(2))} <span class="colorhist-credit">${works}</span>`;
            });
        const filmHr = new Set(Object.keys(histogram.films).map((hr) => `HR ${hr}`));
        const brightest = (histogram.top[i] ?? [])
            .filter(([label]) => !filmHr.has(label))
            .map(([label, magnitude]) => {
                const named = nameOf(label) !== label;
                return `<span class="${named ? "colorhist-name" : ""}">${escapeText(nameOf(label))}</span> ${minus(magnitude.toFixed(2))}`;
            });
        readout.innerHTML = line(first) + line([...films, ...brightest].join(", "));
    }

    const hover = (event: PointerEvent) => {
        if (!data) return;
        const box = plot.getBoundingClientRect();
        const histogram = data[catalog()];
        const bin = geometry(histogram).bin(event.clientX - box.left);
        const next = bin >= 0 && bin < histogram.bins.count ? bin : null;
        if (next !== hovered) {
            hovered = next;
            requestRender();
        }
    };
    plot.addEventListener("pointermove", hover);
    plot.addEventListener("pointerdown", hover);
    plot.addEventListener("pointerleave", (event) => {
        if (event.pointerType !== "mouse") return;
        hovered = null;
        requestRender();
    });
    plot.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step || !data) return;
        event.preventDefault();
        const bins = data[catalog()].bins.count;
        hovered = Math.max(0, Math.min(bins - 1, (hovered ?? Math.floor(bins / 2)) + step));
        requestRender();
    });
    plot.addEventListener("blur", () => {
        hovered = null;
        requestRender();
    });
    for (const button of buttons) {
        button.addEventListener("click", () => {
            measure = button.dataset.set === "light" ? "light" : "count";
            for (const other of buttons) other.setAttribute("aria-pressed", String(other.dataset.set === measure));
            requestRender();
        });
    }
    bindStarGroups(root, requestRender, false);
    new ResizeObserver(() => {
        if (plot.clientWidth !== width) requestRender();
    }).observe(plot);
    const base = root.dataset.base ?? "/";
    Promise.all(CATALOGS.map((c) => fetch(`${base}colors-${c}.json`).then((r) => r.json() as Promise<Histogram>)))
        .then((loaded) => {
            data = Object.fromEntries(CATALOGS.map((c, i) => [c, loaded[i]])) as Record<Catalog, Histogram>;
            requestRender();
        })
        .catch(() => {
            readout.innerHTML = "<p>The histograms did not load.</p>";
        });
    requestRender();
}
