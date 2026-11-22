import { bowRadius, waterIndex } from "@himmelszelt/gewoelk";
import { find } from "../../dom";
import { onDemand } from "../../frame";
import { paintRange } from "../../range";
import { drawSvg, LABEL_GAP as GAP, svgText } from "../../sternzeit/figure";
import { WAVELENGTHS, wavelengthColor } from "./spectrum";

// A ray through a raindrop, as Descartes traced it: Snell's law at the surface, a mirror's law inside, in units of the
// drop's radius, x along the sunlight and y up. The index is the library's, and so is the angle the rays crowd at.

const DEG = Math.PI / 180;
const GREEN = 550;
const FAN = 36;
type Order = 1 | 2;
type Point = readonly [x: number, y: number];

const root = find<HTMLElement>("#raindrop");
const svgEl = find<SVGSVGElement>(".raindrop-panel > svg", root);
const slider = find<HTMLInputElement>('[data-field="impact"]', root);
const sliderValue = find<HTMLElement>('[data-field="impactValue"]', root);
const bowMark = find<HTMLElement>('[data-field="bowMark"]', root);
const readout = find<HTMLElement>('[data-field="readout"]', root);
const orders = [...root.querySelectorAll<HTMLInputElement>('input[name="raindrop-order"]')];

const f = (n: number) => n.toFixed(1);
const order = () => (orders.find((input) => input.checked)?.value === "2" ? 2 : 1) as Order;
const points = (list: readonly Point[]) => list.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");
const segment = (a: Point, b: Point, cls: string) =>
    `<line x1="${f(a[0])}" y1="${f(a[1])}" x2="${f(b[0])}" y2="${f(b[1])}" class="${cls}"/>`;

/**
 * A ray meeting the drop `impact` of its radius from the middle, above it for the primary bow and below for the
 * secondary, so both leave downwards: the points where it meets the surface, the direction it leaves in, and how far it
 * was turned in all, in radians.
 */
function trace(impact: number, n: number, reflections: Order) {
    const side = reflections === 1 ? 1 : -1;
    const incidence = Math.asin(impact);
    const refracted = Math.asin(impact / n);
    const surface = Array.from({ length: reflections + 2 }, (_, k): Point => {
        const at = Math.PI - side * incidence - side * k * (Math.PI - 2 * refracted);
        return [Math.cos(at), Math.sin(at)];
    });
    const turned = 2 * (incidence - refracted) + reflections * (Math.PI - 2 * refracted);
    return { surface, out: [Math.cos(-side * turned), Math.sin(-side * turned)] as Point, turned };
}

/** Where the ray of least deviation meets the drop, by Descartes' condition on the angle of incidence. */
const leastImpact = (n: number, reflections: Order) =>
    Math.sqrt(((reflections + 1) ** 2 - n * n) / reflections / (reflections + 2));

function render() {
    const [width, height] = [svgEl.clientWidth || 640, svgEl.clientHeight || 400];
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const reflections = order();
    const impact = Number(slider.value);
    const radius = Math.min(0.16 * width, 0.22 * height);
    const [cx, cy] = [width - radius - Math.max(24, 0.14 * width), radius + 26];

    /** The ray's path in pixels: where it meets the drop, and `along` it from where it leaves to the panel's edge, 0 to 1. */
    function path(impactOf: number, n: number) {
        const ray = trace(impactOf, n, reflections);
        const inside = ray.surface.map(([x, y]): Point => [cx + radius * x, cy - radius * y]);
        const [ex, ey] = inside.at(-1) as Point;
        const [dx, dy] = [ray.out[0], -ray.out[1]];
        const reach = Math.min(
            dx > 0 ? (width - ex) / dx : dx < 0 ? -ex / dx : Infinity,
            dy > 0 ? (height - ey) / dy : dy < 0 ? -ey / dy : Infinity,
        );
        const along = (t: number): Point => [ex + dx * reach * t, ey + dy * reach * t];
        return { inside, along, towardsDrop: [-dx, -dy] as Point, turned: ray.turned };
    }

    let svg = `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(radius)}" class="raindrop-water"/>`;
    const green = waterIndex(GREEN);
    for (let k = 0; k < FAN; ++k) {
        const ray = path((k + 0.5) / FAN, green);
        const start: Point = [0, (ray.inside[0] as Point)[1]];
        svg += `<polyline points="${points([start, ...ray.inside, ray.along(1)])}" class="raindrop-fan"/>`;
    }

    // The ray no other is turned less than, dashed, named on the side no ray leaves to.
    const leastAt = leastImpact(green, reflections);
    const least = path(leastAt, green);
    const dark = reflections === 1 ? 1 : -1;
    const side = dark > 0 ? "start" : "end";
    svg += segment(least.along(0), least.along(1), "raindrop-least");
    const [nameX, nameY] = least.along(0.42);
    svg += svgText(
        nameX + dark * 2 * GAP,
        nameY,
        "least deviation",
        `figure-label raindrop-least-label figure-anchor-${side}`,
    );

    // The chosen ray: white until it meets the drop, then every wavelength its own way.
    const chosen = path(impact, green);
    const entry = chosen.inside[0] as Point;
    svg += segment([0, entry[1]], entry, "raindrop-sunlight");
    const tip = entry[0] / 2;
    svg += `<polygon points="${points([
        [tip, entry[1]],
        [tip - 8, entry[1] - 3.2],
        [tip - 8, entry[1] + 3.2],
    ])}" class="raindrop-tip"/>`;
    for (const nm of WAVELENGTHS) {
        const ray = path(impact, waterIndex(nm));
        svg += `<polyline points="${points([...ray.inside, ray.along(1)])}" class="raindrop-ray" style="stroke: ${wavelengthColor(nm)}"/>`;
    }
    svg += svgText(GAP, cy - (reflections === 1 ? radius : 0) - 11, "sunlight", "figure-label figure-anchor-start");

    // The eye on the chosen ray, the way to the antisolar point from it, and the angle between that and the drop.
    const away = 180 - Math.acos(Math.cos(chosen.turned)) / DEG;
    const [eyeX, eyeY] = chosen.along(0.7);
    const [bx, by] = chosen.towardsDrop;
    const line = Math.min(0.2 * width, 110);
    const arc = Math.min(34, 0.5 * line);
    svg += segment([eyeX, eyeY], [eyeX + line, eyeY], "raindrop-antisolar");
    svg += `<path d="M${f(eyeX + arc)} ${f(eyeY)} A${arc} ${arc} 0 0 ${by < 0 ? 0 : 1} ${f(eyeX + arc * bx)} ${f(eyeY + arc * by)}" class="raindrop-angle"/>`;
    // The angle's value beyond the middle of its arc.
    const middle = Math.hypot(1 + bx, by) > 0.05 ? [1 + bx, by] : [0, -1];
    const [mx, my] = middle.map((v) => ((arc + 2 * GAP) * v) / Math.hypot(...middle)) as [number, number];
    svg += svgText(
        eyeX + mx,
        eyeY + my,
        `${away.toFixed(1)}°`,
        `figure-note figure-anchor-${mx < -8 ? "end" : "start"}`,
    );
    svg += svgText(eyeX + line + GAP, eyeY, "antisolar point", "figure-label figure-anchor-start");
    svg += `<circle cx="${f(eyeX)}" cy="${f(eyeY)}" r="3.5" class="raindrop-eye"/>`;
    svg += svgText(eyeX + dark * (GAP + 2), eyeY + dark * 13, "eye", `figure-label figure-anchor-${side}`);
    drawSvg(svgEl, svg, 1);

    bowMark.style.left = `${(100 * leastAt).toFixed(1)}%`;
    sliderValue.textContent = impact.toFixed(2);
    const bow = (nm: number) => `${bowRadius(reflections, nm).toFixed(1)}°`;
    readout.innerHTML =
        `<span class="status-title">Green light, 550\u202fnm:</span> turned by ${(chosen.turned / DEG).toFixed(1)}° in all and seen ` +
        `${away.toFixed(1)}° from the antisolar point. No ray is turned less than the one at ${leastAt.toFixed(2)}, where the ` +
        `${reflections === 1 ? "primary" : "secondary"} bow stands: ${bow(660)} in red, ${bow(GREEN)} in green, ${bow(450)} in blue.`;
}

const requestRender = onDemand(render, svgEl);
slider.addEventListener("input", requestRender);
for (const input of orders)
    input.addEventListener("change", () => {
        // To the bow's own ray, on the slider's steps.
        slider.value = (Math.round(leastImpact(waterIndex(GREEN), order()) * 200) / 200).toFixed(3);
        paintRange(slider);
        requestRender();
    });
new ResizeObserver(requestRender).observe(svgEl);
