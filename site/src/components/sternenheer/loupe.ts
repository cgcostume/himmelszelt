import { illuminanceFromMagnitude } from "@himmelszelt/sternenheer";
import { find } from "../dom";
import { gpu } from "../dunstkreis/atmosphere";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { drawSvg, svgText } from "../sternzeit/figure";
import { GPU_MISSING } from "../webgpu";
import { renderStarPatch, type StarPatch } from "./starpatch";
import { starPicker } from "./starpicker";

const SIZE = 33;
const TARGET = 257;
// The view's height in pixels, for the halo's width, which is in the viewer's field.
const VIEW_HEIGHT = 1080;
const REACH = (SIZE - 1) / 2;
// The first view of the chapter: 120° down some 1,080 pixels.
const WIDEST_ARCSEC = 400;
const DARK_SKY = 3e-4;
const THRESHOLD = 1 / 2048;
const DECADES = { top: 4, bottom: -4 };
const PROFILE = { height: 200, top: 10, bottom: 22, left: 40, right: 8 };
const SUM = { height: 120, top: 10, bottom: 22, left: 40, right: 8, most: 1.2 };
const Y = [0.2126, 0.7152, 0.0722] as const;
const NO_KNEE = 1e12;

type Choice = { hr: number; magnitude: number; bv: number };

const f = (n: number) => n.toFixed(1);
const lum = (v: ArrayLike<number>, at: number) =>
    Y[0] * (v[at] ?? 0) + Y[1] * (v[at + 1] ?? 0) + Y[2] * (v[at + 2] ?? 0);
const encode = (v: number) => {
    const c = Math.min(Math.max(v, 0), 1);
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
};
const percent = (v: number) => {
    const p = Math.abs(v * 100);
    return `${p >= 9.5 ? (v * 100).toFixed(0) : p >= 0.095 ? (v * 100).toFixed(1) : (v * 100).toPrecision(1)}%`;
};
const sup = (n: number) =>
    String(n)
        .replace("-", "⁻")
        .replace(/\d/g, (d) => "⁰¹²³⁴⁵⁶⁷⁸⁹"[Number(d)] ?? d);
const angle = (arcsec: number) =>
    arcsec >= 60 ? `${(arcsec / 60).toFixed(1)}′` : `${arcsec.toFixed(arcsec < 10 ? 1 : 0)}″`;

/** The distances from the star's center under a plot, the last one with its unit, which hangs left of its mark. */
const radii = (x: (r: number) => number, y: number) =>
    [0, 4, 8, 12, 16]
        .map((r) =>
            r === 16
                ? svgText(x(r), y, "16 px", "figure-label figure-anchor-end")
                : svgText(x(r), y, `${r}`, "figure-label"),
        )
        .join("");

/**
 * The loupe figure on `root`: one star drawn by the pass into a small linear target and read back, its pixels
 * magnified, its profile, its pixels added up from the center out, and where its light goes. Follows no moment.
 */
export function loupeFigure(root: HTMLElement) {
    const choices = JSON.parse(root.dataset.choices ?? "[]") as Choice[];
    const picker = starPicker(find("[data-star-picker]", root));
    const chosen = () => choices.find((star) => String(star.hr) === picker.value);
    const canvas = find<HTMLCanvasElement>("[data-field=grid]", root);
    const profile = find<SVGSVGElement>("[data-field=profile]", root);
    const sumPlot = find<SVGSVGElement>("[data-field=sum]", root);
    const ledger = find<SVGSVGElement>("[data-field=ledger]", root);
    const knee = find<HTMLButtonElement>("[data-field=knee]", root);
    const status = find("[data-field=status]", root);
    const sliders = {
        magnitude: find<HTMLInputElement>("[data-field=magnitude]", root),
        exposure: find<HTMLInputElement>("[data-field=exposure]", root),
        zoom: find<HTMLInputElement>("[data-field=zoom]", root),
        psf: find<HTMLInputElement>("[data-field=psf]", root),
    };
    const outputs = {
        magnitude: find("[data-field=magnitudeValue]", root),
        exposure: find("[data-field=exposureValue]", root),
        zoom: find("[data-field=zoomValue]", root),
        psf: find("[data-field=psfValue]", root),
    };
    let patch: StarPatch | null = null;
    let drawing = false;
    let again = false;

    const state = () => {
        const star = chosen() ?? choices[0];
        const arcsec = WIDEST_ARCSEC / 2 ** Number(sliders.zoom.value);
        return {
            star,
            magnitude: -Number(sliders.magnitude.value),
            ev100: -Number(sliders.exposure.value),
            arcsec,
            psf: Number(sliders.psf.value),
            knee: knee.getAttribute("aria-pressed") === "true",
        };
    };

    function pickStar() {
        const star = chosen();
        if (!star) return;
        sliders.magnitude.value = String(-star.magnitude);
        paintRange(sliders.magnitude);
    }

    async function fetchPatch() {
        if (drawing) {
            again = true;
            return;
        }
        const device = gpu.device;
        if (!device) {
            status.innerHTML = GPU_MISSING;
            canvas.style.display = "none";
            return;
        }
        drawing = true;
        const s = state();
        try {
            patch = await renderStarPatch(
                device,
                { magnitude: s.magnitude, bv: s.star?.bv ?? 0 },
                {
                    size: SIZE,
                    target: TARGET,
                    viewerTarget: VIEW_HEIGHT,
                    fovDegrees: (SIZE * s.arcsec) / 3600,
                    ev100: s.ev100,
                    psfPixels: s.psf,
                    knee: s.knee ? 1 : NO_KNEE,
                    halo: s.knee ? 1 : 0,
                    parts: true,
                },
            );
        } finally {
            drawing = false;
        }
        requestRender();
        if (again) {
            again = false;
            fetchPatch();
        }
    }

    function render() {
        const s = state();
        outputs.magnitude.textContent = s.magnitude.toFixed(2).replace("-", "−");
        outputs.exposure.textContent = s.ev100.toFixed(1).replace("-", "−");
        outputs.zoom.textContent = angle(s.arcsec);
        outputs.psf.textContent = `${s.psf.toFixed(2)} px`;
        if (!patch) return;
        drawGrid(patch);
        drawProfile(patch, s);
        drawSum(patch);
        drawLedger(patch);
        drawStatus(patch, s);
    }

    function drawGrid(p: StarPatch) {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const side = Math.max(p.size, Math.round((canvas.clientWidth || 300) * dpr));
        if (canvas.width !== side || canvas.height !== side) Object.assign(canvas, { width: side, height: side });
        const context = canvas.getContext("2d");
        if (!context) return;
        const image = context.createImageData(side, side);
        // Each device pixel's cell, and a line of one device pixel where a cell ends, where cells are wide enough.
        const cellOf = Array.from({ length: side }, (_, x) => Math.floor((x * p.size) / side));
        const gap = side / p.size >= 6;
        const edge = (x: number) => gap && cellOf[x + 1] !== cellOf[x];
        const colors = Array.from({ length: p.size * p.size }, (_, n) =>
            [0, 1, 2].map((c) => encode((p.rgb[n * 3 + c] ?? 0) * p.exposure)),
        );
        for (let y = 0; y < side; y++) {
            for (let x = 0; x < side; x++) {
                const k = (y * side + x) * 4;
                const c =
                    edge(x) || edge(y) ? [22, 24, 30] : (colors[(cellOf[y] ?? 0) * p.size + (cellOf[x] ?? 0)] ?? []);
                image.data.set([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, 255], k);
            }
        }
        context.putImageData(image, 0, 0);
    }

    /** Every pixel of the patch by its distance from the star's center: its luminance and its share of the light. */
    function pixels(p: StarPatch) {
        const list: { r: number; full: number; core: number }[] = [];
        const c = (p.size - 1) / 2;
        for (let j = 0; j < p.size; j++) {
            for (let i = 0; i < p.size; i++) {
                const at = (j * p.size + i) * 3;
                list.push({ r: Math.hypot(i - c, j - c), full: lum(p.rgb, at), core: lum(p.core ?? p.rgb, at) });
            }
        }
        return list.sort((a, b) => a.r - b.r);
    }

    function drawProfile(p: StarPatch, s: ReturnType<typeof state>) {
        const width = profile.clientWidth || 360;
        const inner = width - PROFILE.left - PROFILE.right;
        const x = (r: number) => PROFILE.left + (r / REACH) * inner;
        const span = PROFILE.height - PROFILE.top - PROFILE.bottom;
        const y = (v: number) => {
            const d = Math.log10(Math.max(v, 1e-30));
            return (
                PROFILE.top +
                ((DECADES.top - Math.min(Math.max(d, DECADES.bottom), DECADES.top)) / (DECADES.top - DECADES.bottom)) *
                    span
            );
        };
        profile.setAttribute("viewBox", `0 0 ${width} ${PROFILE.height}`);
        let svg = "";
        for (let d = DECADES.bottom; d <= DECADES.top; d += 2) {
            svg += `<line x1="${PROFILE.left}" y1="${f(y(10 ** d))}" x2="${f(width - PROFILE.right)}" y2="${f(y(10 ** d))}" class="figure-grid"/>`;
            svg += svgText(PROFILE.left - 6, y(10 ** d), d === 0 ? "1" : `10${sup(d)}`, "figure-grid-label");
        }
        svg += radii(x, PROFILE.height - 6);
        // The sky's label at the left, out of the way of the knee's, which it may come close to.
        const marks: [number, string, string, boolean][] = [
            [1, "display white, the knee", "plot-mark loupe-knee", true],
            [THRESHOLD, "cut-off", "plot-mark", true],
            [DARK_SKY * p.exposure, "a dark sky", "plot-mark loupe-sky", false],
        ];
        for (const [v, name, cls, right] of marks) {
            const d = Math.log10(v);
            if (d < DECADES.bottom || d > DECADES.top) continue;
            svg += `<line x1="${PROFILE.left}" y1="${f(y(v))}" x2="${f(width - PROFILE.right)}" y2="${f(y(v))}" class="${cls}"/>`;
            svg += right
                ? svgText(width - PROFILE.right - 4, y(v) - 6, name, "figure-label figure-anchor-end")
                : svgText(PROFILE.left + 4, y(v) + 10, name, "figure-label figure-anchor-start");
        }
        // The point spread without the knee, as the pass would have drawn it at a pixel's center.
        const sigma = Math.max(s.psf, 0.6);
        const peak = (p.illuminance / (2 * Math.PI * sigma * sigma * p.pixelSolidAngle)) * p.exposure;
        const curve = Array.from({ length: 121 }, (_, i) => (i / 120) * REACH)
            .map((r) => [r, peak * Math.exp((-0.5 * r * r) / (sigma * sigma))] as const)
            .filter(([, v]) => v >= 10 ** DECADES.bottom && v <= 10 ** DECADES.top)
            .map(([r, v]) => `${f(x(r))},${f(y(v))}`);
        svg += `<polyline points="${curve.join(" ")}" class="plot-line loupe-gauss"/>`;
        for (const { r, full, core } of pixels(p)) {
            if (r > REACH + 1e-6) continue;
            const v = full * p.exposure;
            if (v <= 10 ** DECADES.bottom) continue;
            const halo = full - core > 0.02 * full;
            svg += `<circle cx="${f(x(r))}" cy="${f(y(v))}" r="2" class="${halo ? "loupe-dot-halo" : "loupe-dot"}"/>`;
        }
        drawSvg(profile, svg, 1);
    }

    function drawSum(p: StarPatch) {
        const width = sumPlot.clientWidth || 360;
        const inner = width - SUM.left - SUM.right;
        const x = (r: number) => SUM.left + (r / REACH) * inner;
        const y = (v: number) => SUM.top + (1 - Math.min(v, SUM.most) / SUM.most) * (SUM.height - SUM.top - SUM.bottom);
        sumPlot.setAttribute("viewBox", `0 0 ${width} ${SUM.height}`);
        let svg = "";
        for (const v of [0, 0.5, 1]) {
            svg += `<line x1="${SUM.left}" y1="${f(y(v))}" x2="${f(width - SUM.right)}" y2="${f(y(v))}" class="${v === 1 ? "plot-mark" : "figure-grid"}"/>`;
            svg += svgText(SUM.left - 6, y(v), `${v * 100}%`, "figure-grid-label");
        }
        svg += svgText(width - SUM.right - 4, y(1) - 6, "the star's light", "figure-label figure-anchor-end");
        svg += radii(x, SUM.height - 6);
        let [full, core] = [0, 0];
        const lines = { full: [] as string[], core: [] as string[] };
        for (const pixel of pixels(p)) {
            if (pixel.r > REACH + 1e-6) continue;
            full += (pixel.full * p.pixelSolidAngle) / p.illuminance;
            core += (pixel.core * p.pixelSolidAngle) / p.illuminance;
            lines.full.push(`${f(x(pixel.r))},${f(y(full))}`);
            lines.core.push(`${f(x(pixel.r))},${f(y(core))}`);
        }
        svg += `<polyline points="${lines.core.join(" ")}" class="plot-line loupe-gauss"/>`;
        svg += `<polyline points="${lines.full.join(" ")}" class="plot-line"/>`;
        drawSvg(sumPlot, svg, 1);
    }

    function drawLedger(p: StarPatch) {
        const sums = p.sums;
        if (!sums) return;
        const width = ledger.clientWidth || 600;
        const e = p.illuminance;
        const core = sums.core / e;
        const halo = Math.max(sums.halo / e, 0);
        const flattened = Math.max((sums.haloLinear - sums.halo) / e, 0);
        const rest = 1 - core - halo - flattened;
        const parts: [number, string, string][] = [
            [core, "core", "loupe-core"],
            [halo, "halo", "loupe-halo"],
            [flattened, "flattened by the halo's curve", "loupe-flat"],
            [Math.max(rest, 0), "outside the target", "loupe-rest"],
        ];
        const total = Math.max(1, core + halo + flattened);
        const [top, bar] = [4, 14];
        const scale = (width - 2) / total;
        let svg = "";
        let at = 1;
        let labels = 0;
        for (const [share, name, cls] of parts) {
            if (share <= 0) continue;
            const w = share * scale;
            svg += `<rect x="${f(at)}" y="${top}" width="${f(Math.max(w, 0.5))}" height="${bar}" class="${cls}"/>`;
            if (share >= 0.001) {
                const row = top + bar + 16 + 15 * labels++;
                svg += `<rect x="1" y="${row - 9}" width="10" height="10" class="${cls}"/>`;
                svg += svgText(16, row, `${name} ${percent(share)}`, "figure-label figure-anchor-start");
            }
            at += w;
        }
        if (rest < -0.005) {
            const row = top + bar + 16 + 15 * labels++;
            svg += svgText(
                16,
                row,
                `more than the star's light by ${percent(-rest)}`,
                "figure-label figure-anchor-start",
            );
        }
        const x1 = 1 + scale;
        svg += `<line x1="${f(x1)}" y1="${top - 3}" x2="${f(x1)}" y2="${top + bar + 3}" class="loupe-full"/>`;
        const height = top + bar + 10 + 15 * labels;
        ledger.setAttribute("viewBox", `0 0 ${width} ${height}`);
        ledger.style.height = `${height}px`;
        drawSvg(ledger, svg, 1);
    }

    function drawStatus(p: StarPatch, s: ReturnType<typeof state>) {
        const sums = p.sums;
        if (!sums) return;
        const sigma = Math.max(s.psf, 0.6);
        const peak = (p.illuminance / (2 * Math.PI * sigma * sigma * p.pixelSolidAngle)) * p.exposure;
        const kept = s.knee ? p.split.core : 1;
        // What a screen shows of the patch: every channel clipped at display white.
        let shown = 0;
        for (let k = 0; k < p.rgb.length; k += 3) {
            const c = [0, 1, 2].map((n) => Math.min((p.rgb[k + n] ?? 0) * p.exposure, 1) / p.exposure);
            shown += lum(c, 0) * p.pixelSolidAngle;
        }
        // The faintest star whose core reaches the cut-off at this zoom and exposure.
        const faintest = -2.5 * Math.log10(THRESHOLD / (peak / p.illuminance) / illuminanceFromMagnitude(0));
        const micro = p.illuminance * 1e6;
        const lux = `${micro >= 10 ? micro.toFixed(0) : micro.toPrecision(2)} µlx`;
        status.textContent =
            `${lux}, peak ${peak >= 10 ? Math.round(peak).toLocaleString("en-US") : peak.toPrecision(2)} times display white` +
            (kept < 1 ? `, the knee keeps ${percent(kept)} of it` : "") +
            `; the loupe's pixels add up to ${percent(sums.patch / p.illuminance)} of the star's light, ` +
            `as a screen shows them ${percent(shown / p.illuminance)}; stars down to magnitude ${faintest.toFixed(1)} show here`;
    }

    const requestRender = onDemand(render, root);
    const requestPatch = onDemand(() => {
        render();
        fetchPatch();
    }, root);
    picker.onPick(() => {
        pickStar();
        requestPatch();
    });
    for (const input of Object.values(sliders)) input.addEventListener("input", requestPatch);
    knee.addEventListener("click", () => {
        knee.setAttribute("aria-pressed", String(knee.getAttribute("aria-pressed") !== "true"));
        requestPatch();
    });
    new ResizeObserver(requestRender).observe(root);
    pickStar();
    requestPatch();
}
