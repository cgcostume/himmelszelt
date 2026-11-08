import { drawSvg } from "../sternzeit/figure";
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

/** The light's angle from the normal the lobes are drawn for, radians, negative to the left: the laws' figure outlines
 *  where on the Moon the Sun stands at that angle now. */
export const lobeLight = { angle: -40 * DEG };
const lightEvents = new EventTarget();
export const onLobeLight = (listener: () => void) => lightEvents.addEventListener("change", listener);

/**
 * The lobes figure on `root`: a patch of surface seen from the side under each law, its normal up and the light coming
 * in from where it is dragged to, and around it how much light the patch sends to each direction in that plane. All
 * four on one scale, a Lambert surface lit straight from above a half circle.
 */
export function lobesFigure(root: HTMLElement) {
    const panels = [...root.querySelectorAll<SVGSVGElement>("svg[data-law]")];
    const note = root.querySelector<HTMLElement>("[data-field=note]");
    let light = lobeLight.angle;
    const W = 200;
    const H = 116;
    const origin = { x: W / 2, y: H - 6 };
    const scale = 80 * PI;
    const toward = (angle: number, r: number) => [origin.x + Math.sin(angle) * r, origin.y - Math.cos(angle) * r];

    function draw() {
        const mu0 = Math.cos(light);
        for (const panel of panels) {
            const law = panel.dataset.law as Law;
            panel.setAttribute("viewBox", `0 0 ${W} ${H}`);
            const points: string[] = [];
            for (let i = 0; i <= 180; i++) {
                const view = (i - 90) * DEG;
                const g = Math.abs(view - light);
                const r = reflectance(law, mu0, Math.cos(view), g) * scale;
                const [x, y] = toward(view, Math.min(r, 140));
                points.push(`${f(x)},${f(y)}`);
            }
            let svg = `<path d="M${f(toward(-PI / 2, 80)[0] ?? 0)} ${f(origin.y)} A80 80 0 0 1 ${f(toward(PI / 2, 80)[0] ?? 0)} ${f(origin.y)}" class="lobe-lambert"/>`;
            svg += `<polygon points="${f(origin.x)},${f(origin.y)} ${points.join(" ")}" class="lobe"/>`;
            svg += `<line x1="8" y1="${f(origin.y)}" x2="${W - 8}" y2="${f(origin.y)}" class="lobe-surface"/>`;
            svg += `<line x1="${f(origin.x)}" y1="${f(origin.y)}" x2="${f(origin.x)}" y2="${f(origin.y - 30)}" class="lobe-normal"/>`;
            const [lx, ly] = toward(light, 104);
            const [hx, hy] = toward(light, 14);
            svg += `<line x1="${f(lx ?? 0)}" y1="${f(ly ?? 0)}" x2="${f(hx ?? 0)}" y2="${f(hy ?? 0)}" class="lobe-light"/>`;
            svg += `<circle cx="${f(lx ?? 0)}" cy="${f(ly ?? 0)}" r="6" class="lobe-sun"/>`;
            drawSvg(panel, svg, 1);
        }
        if (note)
            note.textContent = `the light ${Math.abs(light / DEG).toFixed(0)}° from the normal, ${light < 0 ? "left" : "right"}`;
    }

    for (const panel of panels) {
        const set = (event: PointerEvent) => {
            const box = panel.getBoundingClientRect();
            const x = ((event.clientX - box.left) / box.width) * W - origin.x;
            const y = origin.y - ((event.clientY - box.top) / box.height) * H;
            light = Math.max(-88 * DEG, Math.min(88 * DEG, Math.atan2(x, Math.max(y, 0.001))));
            lobeLight.angle = light;
            lightEvents.dispatchEvent(new Event("change"));
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
    root.querySelector("[data-field=download]")?.addEventListener("click", () => download(root, panels));
    draw();
}

// What the stylesheet gives the diagram's parts, written onto them, so the file draws the same anywhere.
const STYLED = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linejoin", "opacity"];

/** The four lobes as one SVG file, each under its law's name, the colors as the page shows them. */
function download(root: HTMLElement, panels: SVGSVGElement[]) {
    const W = 200;
    const H = 116;
    const gap = 16;
    const label = 22;
    const ink = getComputedStyle(root).color;
    let body = "";
    for (const [i, panel] of panels.entries()) {
        const copy = panel.cloneNode(true) as SVGSVGElement;
        const sources = panel.querySelectorAll("*");
        copy.querySelectorAll("*").forEach((element, k) => {
            const style = getComputedStyle(sources[k] as Element);
            for (const name of STYLED) element.setAttribute(name, style.getPropertyValue(name));
            element.removeAttribute("class");
        });
        const name = panel.parentElement?.querySelector(".tiles-name")?.textContent ?? "";
        body += `<g transform="translate(${i * (W + gap)} 0)">${copy.innerHTML}`;
        body += `<text x="${W / 2}" y="${H + 16}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="${ink}">${name}</text></g>`;
    }
    const width = panels.length * W + (panels.length - 1) * gap;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${H + label}" width="${width}" height="${H + label}">${body}</svg>`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    link.download = `himmelszelt-lobes-${Math.abs(lobeLight.angle / DEG).toFixed(0)}deg.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
