import { paintRange } from "../range";
import { drawSvg, SUN_SYMBOL, sunGlow, sunRays } from "../sternzeit/figure";

export type Law = "lambert" | "orenNayar" | "hapke" | "hapke2012";
/** The laws in the order the figures show them: the two a renderer reaches for, then Hapke's of 1963 and of 2012. */
export const LAWS: readonly Law[] = ["lambert", "orenNayar", "hapke", "hapke2012"];

// The four laws as nachtgestirn's surface.wgsl has them, line for line, for a diagram of a few hundred directions.
const PI = Math.PI;
function retrodirective(g: number) {
    const h = 0.6;
    if (g < 1e-4) return 2;
    if (g >= PI / 2) return 1;
    const t = Math.tan(g);
    const e = Math.exp(-h / t);
    return 2 - (t / (2 * h)) * (1 - e) * (3 - e);
}
function scattering(g: number) {
    const t = 0.1;
    const c = Math.cos(g);
    return (Math.sin(g) + (PI - g) * c) / PI + t * (1 - c * 0.5) * (1 - c * 0.5);
}
function hapke(mu0: number, mu: number, g: number) {
    const phase = (retrodirective(g) * scattering(g)) / (2 * scattering(0));
    return ((2 * mu0) / Math.max(mu0 + mu, 1e-4)) * (phase / PI);
}
function orenNayar(mu0: number, mu: number, g: number) {
    const sigma2 = 0.25;
    const a = 1 - (0.5 * sigma2) / (sigma2 + 0.33);
    const b = (0.45 * sigma2) / (sigma2 + 0.09);
    const sin0 = Math.sqrt(Math.max(1 - mu0 * mu0, 0));
    const sinV = Math.sqrt(Math.max(1 - mu * mu, 0));
    const cosAzimuth = Math.max((Math.cos(g) - mu0 * mu) / Math.max(sin0 * sinV, 1e-4), 0);
    const alpha = Math.max(sin0, sinV);
    const tanBeta = Math.min(sin0 / Math.max(mu0, 1e-4), sinV / Math.max(mu, 1e-4));
    return (mu0 * (a + b * cosAzimuth * alpha * tanBeta)) / PI;
}
// Hapke's 2012 model with Sato et al.'s 2014 lunar parameters, as ngHapke2012 has it.
const H12 = { w: 0.3231, b: 0.2366, c: 0.3344, bs0: 1.75, hs: 0.05309, tan: Math.tan((23.657 * PI) / 180) };
const H12_CHI = 1 / Math.sqrt(1 + PI * H12.tan * H12.tan);
const H12_GAMMA = Math.sqrt(1 - H12.w);
const H12_R0 = (1 - H12_GAMMA) / (1 + H12_GAMMA);
function h12H(x: number) {
    const y = Math.max(x, 1e-4);
    return 1 / (1 - H12.w * y * (H12_R0 + ((1 - 2 * H12_R0 * y) / 2) * Math.log((1 + y) / y)));
}
function h12E(cosY: number, sinY: number) {
    if (sinY < 1e-4) return [0, 0] as const;
    const cot = cosY / sinY;
    return [Math.exp((-2 / (PI * H12.tan)) * cot), Math.exp((-1 / (PI * H12.tan * H12.tan)) * cot * cot)] as const;
}
function hapke2012Radiance(mu0: number, mu: number, g: number) {
    const cosG = Math.cos(g);
    const [sinI, sinE] = [Math.sqrt(Math.max(1 - mu0 * mu0, 0)), Math.sqrt(Math.max(1 - mu * mu, 0))];
    const [e1i, e2i] = h12E(mu0, sinI);
    const [e1e, e2e] = h12E(mu, sinE);
    const cosPsi = sinI * sinE > 1e-6 ? Math.max(-1, Math.min(1, (cosG - mu0 * mu) / (sinI * sinE))) : 1;
    const psi = Math.acos(cosPsi) / PI;
    const half2 = 0.5 - 0.5 * cosPsi;
    const f = Math.exp(-2 * Math.sqrt(half2 / Math.max(1 - half2, 1e-6)));
    const etaI = H12_CHI * (mu0 + (sinI * H12.tan * e2i) / (2 - e1i));
    const etaE = H12_CHI * (mu + (sinE * H12.tan * e2e) / (2 - e1e));
    let mu0e: number;
    let mue: number;
    let shadow: number;
    if (mu0 >= mu) {
        const d = 2 - e1e - psi * e1i;
        mu0e = H12_CHI * (mu0 + (sinI * H12.tan * (cosPsi * e2e + half2 * e2i)) / d);
        mue = H12_CHI * (mu + (sinE * H12.tan * (e2e - half2 * e2i)) / d);
        shadow = (((mue / etaE) * mu0) / etaI) * (H12_CHI / (1 - f + (f * H12_CHI * mu0) / etaI));
    } else {
        const d = 2 - e1i - psi * e1e;
        mu0e = H12_CHI * (mu0 + (sinI * H12.tan * (e2i - half2 * e2e)) / d);
        mue = H12_CHI * (mu + (sinE * H12.tan * (cosPsi * e2i + half2 * e2e)) / d);
        shadow = (((mue / etaE) * mu0) / etaI) * (H12_CHI / (1 - f + (f * H12_CHI * mu) / etaE));
    }
    const b2 = H12.b * H12.b;
    const back = 1 - 2 * H12.b * cosG + b2;
    const forth = 1 + 2 * H12.b * cosG + b2;
    const p =
        (1 - b2) * ((0.5 * (1 + H12.c)) / (back * Math.sqrt(back)) + (0.5 * (1 - H12.c)) / (forth * Math.sqrt(forth)));
    const surge = 1 / (1 + Math.sqrt(Math.max(1 - cosG, 0) / Math.max(1 + cosG, 1e-6)) / H12.hs);
    const multiple = h12H(mu0e) * h12H(mue) - 1;
    const radiance =
        ((H12.w * 0.25 * mu0e) / Math.max(mu0e + mue, 1e-6)) * (p * (1 + H12.bs0 * surge) + multiple) * shadow;
    return Math.max(radiance, 0);
}
const H12_NORM = 1 / hapke2012Radiance(1, 1, 0);
function hapke2012(mu0: number, mu: number, g: number) {
    return mu <= 0 ? 0 : (hapke2012Radiance(mu0, mu, g) * H12_NORM) / PI;
}
/** The light a surface sends towards a viewer over the light arriving, per law, for normal albedo 1. */
export function reflectance(law: Law, mu0: number, mu: number, g: number) {
    if (mu0 <= 0) return 0;
    if (law === "lambert") return mu0 / PI;
    if (law === "orenNayar") return orenNayar(mu0, Math.max(mu, 0), g);
    if (law === "hapke2012") return hapke2012(mu0, Math.max(mu, 0), g);
    return hapke(mu0, Math.max(mu, 0), g);
}

/**
 * The light a plain disc sends to the viewer at phase angle `g`, radians, under `law`, relative to a flat disc of the same
 * albedo seen and lit straight on: a Lambert sphere gives two thirds of it at full, Hapke's law one. Summed over the lit
 * and visible lune in the Moon's own longitude and latitude, so a thin crescent gets as many samples as a full disc.
 */
export function discLight(law: Law, g: number, n = 48) {
    const [from, to] = [g - PI / 2, PI / 2];
    if (to <= from) return 0;
    const [dLon, dLat] = [(to - from) / n, PI / n];
    let sum = 0;
    for (let i = 0; i < n; i++) {
        const lon = from + (i + 0.5) * dLon;
        for (let j = 0; j < n; j++) {
            const lat = -PI / 2 + (j + 0.5) * dLat;
            const c = Math.cos(lat);
            const mu = c * Math.cos(lon);
            sum += reflectance(law, c * Math.cos(lon - g), mu, g) * mu * c;
        }
    }
    return sum * dLon * dLat;
}

const DEG = PI / 180;
const f = (n: number) => n.toFixed(1);

// The side views' box, in their own units: the patch at the bottom middle, room on either side for the Sun's handle at
// its lowest, which the panels must not crop.
const W = 224;
const H = 118;
const ORIGIN = { x: W / 2, y: H - 8 };
// A Lambert surface lit straight from above, a half circle of this radius, well inside the Sun's path.
const LAMBERT = 68;
const SCALE = LAMBERT * PI;
const REACH = 88;

/**
 * The laws' side views in `root`'s `svg[data-law]` panels: a patch of surface under each law, its normal up, the Sun
 * dragged around it, and around the patch how much light it sends to each direction in that plane, all four on one
 * scale, a Lambert surface lit straight from above a half circle. The Sun's angle from the normal, radians, negative to
 * the left.
 */
export function lobesFigure(root: HTMLElement) {
    const panels = [...root.querySelectorAll<SVGSVGElement>("svg[data-law]")];
    const note = root.querySelector<HTMLElement>("[data-field=lobes]");
    const slider = root.querySelector<HTMLInputElement>("[data-field=sunAngle]");
    const sliderValue = root.querySelector<HTMLElement>("[data-field=sunAngleValue]");
    let light = (Number(slider?.value ?? -40) || -40) * DEG;
    const toward = (angle: number, r: number) => [ORIGIN.x + Math.sin(angle) * r, ORIGIN.y - Math.cos(angle) * r];

    // The Sun as the figures draw it as a symbol, its size in screen pixels whatever the panel's width.
    function sun(x: number, y: number, unitsPerPx: number) {
        const r = SUN_SYMBOL.radius * unitsPerPx;
        let svg = sunGlow(x, y, r, ORIGIN.y, "figure-sun");
        svg += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" class="figure-sun lobe-sun"/>`;
        for (const [a, b] of sunRays()) {
            svg += `<line x1="${f(x + a.x * unitsPerPx)}" y1="${f(y + a.y * unitsPerPx)}" x2="${f(x + b.x * unitsPerPx)}" y2="${f(y + b.y * unitsPerPx)}" class="figure-sun-ray"/>`;
        }
        return svg;
    }

    // A line from (x0, y0) to (x1, y1) with a tip at its end, the tip the same size in screen pixels at any width.
    function arrow(x0: number, y0: number, x1: number, y1: number, kind: string, unitsPerPx: number) {
        const [length, halfWidth] = [7 * unitsPerPx, 3 * unitsPerPx];
        const d = Math.hypot(x1 - x0, y1 - y0) || 1;
        const [ux, uy] = [(x1 - x0) / d, (y1 - y0) / d];
        const [bx, by] = [x1 - ux * length, y1 - uy * length];
        const tip = `${f(x1)},${f(y1)} ${f(bx - uy * halfWidth)},${f(by + ux * halfWidth)} ${f(bx + uy * halfWidth)},${f(by - ux * halfWidth)}`;
        return `<line x1="${f(x0)}" y1="${f(y0)}" x2="${f(bx)}" y2="${f(by)}" class="${kind}"/><polygon points="${tip}" class="${kind}-tip"/>`;
    }

    function draw() {
        const mu0 = Math.cos(light);
        for (const panel of panels) {
            const law = panel.dataset.law as Law;
            const unitsPerPx = W / (panel.clientWidth || W);
            panel.setAttribute("viewBox", `0 0 ${W} ${H}`);
            panel.style.setProperty("--units-per-px", String(unitsPerPx));
            const points: string[] = [];
            for (let i = 0; i <= 180; i++) {
                const out = (i - 90) * DEG;
                const r = reflectance(law, mu0, Math.cos(out), Math.abs(out - light)) * SCALE;
                const [x, y] = toward(out, Math.min(r, LAMBERT * 1.75));
                points.push(`${f(x ?? 0)},${f(y ?? 0)}`);
            }
            let svg = `<path d="M${f(ORIGIN.x - LAMBERT)} ${f(ORIGIN.y)} A${LAMBERT} ${LAMBERT} 0 0 1 ${f(ORIGIN.x + LAMBERT)} ${f(ORIGIN.y)}" class="lobe-lambert"/>`;
            svg += `<polygon points="${f(ORIGIN.x)},${f(ORIGIN.y)} ${points.join(" ")}" class="lobe"/>`;
            svg += `<line x1="6" y1="${f(ORIGIN.y)}" x2="${W - 6}" y2="${f(ORIGIN.y)}" class="lobe-surface"/>`;
            svg += arrow(ORIGIN.x, ORIGIN.y, ORIGIN.x, ORIGIN.y - 32, "lobe-normal", unitsPerPx);
            // The direction to the Sun, from the patch up to the Sun's disc.
            const [lx, ly] = toward(light, REACH);
            const [tx, ty] = toward(light, REACH - (SUN_SYMBOL.radius + 2) * unitsPerPx);
            svg += arrow(ORIGIN.x, ORIGIN.y, tx ?? 0, ty ?? 0, "lobe-light", unitsPerPx);
            svg += sun(lx ?? 0, ly ?? 0, unitsPerPx);
            drawSvg(panel, svg, 1);
        }
        const degrees = Math.round(light / DEG);
        if (note)
            note.textContent =
                degrees === 0
                    ? "side views: the Sun straight over the patch"
                    : `side views: the Sun ${Math.abs(degrees)}° ${degrees < 0 ? "left" : "right"} of the normal`;
        if (slider && Number(slider.value) !== degrees) {
            slider.value = String(degrees);
            paintRange(slider);
        }
        if (sliderValue) sliderValue.textContent = `${degrees < 0 ? "\u2212" : ""}${Math.abs(degrees)}°`;
    }

    slider?.addEventListener("input", () => {
        light = Number(slider.value) * DEG;
        draw();
    });

    for (const panel of panels) {
        const set = (event: PointerEvent) => {
            const box = panel.getBoundingClientRect();
            const x = ((event.clientX - box.left) / box.width) * W - ORIGIN.x;
            const y = ORIGIN.y - ((event.clientY - box.top) / box.height) * H;
            light = Math.max(-90 * DEG, Math.min(90 * DEG, Math.atan2(x, Math.max(y, 0.001))));
            draw();
        };
        panel.addEventListener("pointerdown", (event) => {
            panel.setPointerCapture(event.pointerId);
            set(event);
        });
        panel.addEventListener("pointermove", (event) => {
            if (panel.hasPointerCapture(event.pointerId)) set(event);
        });
    }
    new ResizeObserver(draw).observe(root);
    draw();
}
