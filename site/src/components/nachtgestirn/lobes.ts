import { drawSvg, SUN_SYMBOL, sunGlow, sunRays } from "../sternzeit/figure";
import type { Law } from "./laws";

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
function metallicRoughness(mu0: number, mu: number, g: number) {
    const roughness = 1;
    const f0 = 0.04;
    const alpha = roughness * roughness;
    const cosG = Math.cos(g);
    const nh = (mu0 + mu) / Math.max(Math.sqrt(2 + 2 * cosG), 1e-4);
    const vh = Math.sqrt(Math.max((1 + cosG) / 2, 0));
    const a2 = alpha * alpha;
    const dd = nh * nh * (a2 - 1) + 1;
    const d = a2 / (PI * dd * dd);
    const k = ((roughness + 1) * (roughness + 1)) / 8;
    const gs = (mu0 / (mu0 * (1 - k) + k)) * (mu / Math.max(mu * (1 - k) + k, 1e-4));
    const fresnel = f0 + (1 - f0) * (1 - vh) ** 5;
    const specular = (d * gs * fresnel) / Math.max(4 * mu0 * mu, 1e-4);
    const f90 = 0.5 + 2 * roughness * vh * vh;
    const diffuse = ((1 + (f90 - 1) * (1 - mu0) ** 5) * (1 + (f90 - 1) * (1 - mu) ** 5)) / PI;
    return mu0 * (diffuse + specular);
}
/** The light a surface sends towards a viewer over the light arriving, per law, for normal albedo 1. */
export function reflectance(law: Law, mu0: number, mu: number, g: number) {
    if (mu0 <= 0) return 0;
    if (law === "lambert") return mu0 / PI;
    if (law === "orenNayar") return orenNayar(mu0, Math.max(mu, 0), g);
    if (law === "metallicRoughness") return metallicRoughness(mu0, Math.max(mu, 0), g);
    return hapke(mu0, Math.max(mu, 0), g);
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
    let light = -40 * DEG;
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
            svg += `<line x1="${f(ORIGIN.x)}" y1="${f(ORIGIN.y)}" x2="${f(ORIGIN.x)}" y2="${f(ORIGIN.y - 30)}" class="lobe-normal"/>`;
            // The incoming light, from the Sun down to the patch.
            const [lx, ly] = toward(light, REACH);
            svg += `<line x1="${f(lx ?? 0)}" y1="${f(ly ?? 0)}" x2="${f(ORIGIN.x)}" y2="${f(ORIGIN.y)}" class="lobe-light"/>`;
            svg += sun(lx ?? 0, ly ?? 0, unitsPerPx);
            drawSvg(panel, svg, 1);
        }
        if (note)
            note.textContent = `side views: the Sun ${Math.abs(light / DEG).toFixed(0)}° ${light < 0 ? "left" : "right"} of the normal`;
    }

    for (const panel of panels) {
        const set = (event: PointerEvent) => {
            const box = panel.getBoundingClientRect();
            const x = ((event.clientX - box.left) / box.width) * W - ORIGIN.x;
            const y = ORIGIN.y - ((event.clientY - box.top) / box.height) * H;
            light = Math.max(-88 * DEG, Math.min(88 * DEG, Math.atan2(x, Math.max(y, 0.001))));
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
