import { bowDirection, bowRadius, bowTop } from "@himmelszelt/gewoelk";
import { find } from "../../dom";
import { onDemand } from "../../frame";
import { paintRange } from "../../range";
import { drawSvg, LABEL_GAP as GAP, SUN_SYMBOL, sunGlow, sunRays, svgText } from "../../sternzeit/figure";
import { WAVELENGTHS, wavelengthColor } from "./spectrum";

// Where a bow can stand, for a Sun of the figure's own, set by its slider or dragged in the side view: from the side,
// the lines of sight that make the library's angles with the line to the antisolar point, and as seen, the two circles
// around that point over the horizon.

const DEG = Math.PI / 180;
const ORDERS = [1, 2] as const;
type Vec3 = readonly [number, number, number];

const root = find<HTMLElement>("#bow-place");
const sideEl = find<SVGSVGElement>('svg[data-panel="side"]', root);
const skyEl = find<SVGSVGElement>('svg[data-panel="sky"]', root);
const slider = find<HTMLInputElement>('[data-field="elevation"]', root);
const sliderValue = find<HTMLElement>('[data-field="elevationValue"]', root);
const readout = find<HTMLElement>('[data-field="readout"]', root);

// The side view as last laid out, for the pointer: the observer, and the Sun with how far around it a press takes it.
const side = { you: 0, ground: 0, sun: [0, 0] as readonly [number, number] };
const SUN_REACH = SUN_SYMBOL.radius + SUN_SYMBOL.gap + SUN_SYMBOL.length;

const f = (n: number) => n.toFixed(1);
const line = (x1: number, y1: number, x2: number, y2: number, attributes: string) =>
    `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${attributes}/>`;
/** A bow's stroke at a wavelength, as attributes. */
const bow = (order: number, nm: number) =>
    `class="bowplace-bow bowplace-order-${order}" style="stroke: ${wavelengthColor(nm)}"`;
const HIDDEN = 'class="bowplace-hidden"';

/** The Sun as the figures' symbol, in screen pixels, its glow cut off at the ground. All of it is the handle. */
function sunSymbol(x: number, y: number, ground: number) {
    let svg = `<g class="bowplace-sun">${sunGlow(x, y, SUN_SYMBOL.radius, ground, "figure-sun")}`;
    svg += `<circle cx="${f(x)}" cy="${f(y)}" r="${SUN_SYMBOL.radius}" class="figure-sun"/>`;
    for (const [a, b] of sunRays()) svg += line(x + a.x, y + a.y, x + b.x, y + b.y, 'class="figure-sun-ray"');
    return `${svg}<circle cx="${f(x)}" cy="${f(y)}" r="${SUN_REACH}" class="bowplace-grab"/></g>`;
}

/** From the side: the Sun behind the observer, the line on to the antisolar point, and the lines of sight to the bows. */
function drawSide(elevation: number) {
    const [width, height] = [sideEl.clientWidth || 336, sideEl.clientHeight || 252];
    sideEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const ground = 0.62 * height;
    const you = 0.42 * width;
    const rain = 0.8 * width;
    /** The point `length` from the observer, `angle` degrees over the horizon ahead. */
    const at = (angle: number, length: number) =>
        [you + length * Math.cos(angle * DEG), ground - length * Math.sin(angle * DEG)] as const;
    /** How far a line of sight runs at `angle` before it leaves the panel or, ahead, meets the rain. */
    const reach = (angle: number, most: number) => {
        const [c, s] = [Math.cos(angle * DEG), Math.sin(angle * DEG)];
        return Math.min(
            most,
            c > 0.05 ? (rain - you) / c : Infinity,
            s > 0 ? (ground - 8) / s : s < 0 ? (height - ground - 8) / -s : Infinity,
        );
    };

    // What the ground hides is drawn under its veil.
    let below = "";
    let above = "";
    const put = (hidden: boolean, svg: string) => {
        if (hidden) below += svg;
        else above += svg;
    };
    const sunAt = at(180 - elevation, 0.36 * width);
    const sunlight = at(180 - elevation, 0.36 * width - SUN_REACH - 4);
    above += line(sunlight[0], sunlight[1], you, ground, 'class="bowplace-sunlight"');
    Object.assign(side, { you, ground, sun: sunAt });
    const axis = at(-elevation, reach(-elevation, 0.34 * width));
    put(elevation > 0, line(you, ground, axis[0], axis[1], 'class="bowplace-axis"'));

    // The point's name beside the line's end where the panel has the room, else under or over it.
    const beside = axis[0] + GAP + 100 < width && elevation > 0;
    let labels = beside
        ? svgText(axis[0] + GAP, Math.min(axis[1], height - 9), "antisolar point", "figure-label figure-anchor-start")
        : svgText(axis[0], axis[1] + 12, "antisolar point", "figure-label figure-anchor-end");
    // The angles' arcs within the ground under a high Sun, short of the point's name.
    const outer = Math.min(0.27 * width, height - ground - 30);
    ORDERS.forEach((order, i) => {
        const radius = bowRadius(order);
        const top = radius - elevation;
        if (top > 0) {
            for (const nm of WAVELENGTHS) {
                const angle = bowRadius(order, nm) - elevation;
                const end = at(angle, reach(angle, Infinity));
                above += line(you, ground, end[0], end[1], bow(order, nm));
            }
            // The sunlight that drop is lit by, parallel to the light reaching you, turned back there to your eye.
            const [dx, dy] = at(top, reach(top, Infinity));
            const [c, s] = [Math.cos(elevation * DEG), Math.sin(elevation * DEG)];
            const length = Math.min(0.22 * width, s > 0.01 ? (dy - 6) / s : Infinity);
            above += line(dx - length * c, dy - length * s, dx, dy, 'class="bowplace-sunlight bowplace-to-drop"');
            above += `<circle cx="${f(dx)}" cy="${f(dy)}" r="2.5" class="bowplace-hit"/>`;
        } else {
            const end = at(top, reach(top, 0.3 * width));
            below += line(you, ground, end[0], end[1], HIDDEN);
        }
        const under = at(-radius - elevation, reach(-radius - elevation, 0.3 * width));
        below += line(you, ground, under[0], under[1], HIDDEN);
        // The angle between the line to the antisolar point and the line of sight, named on its arc.
        const arc = (i === 0 ? 0.63 : 1) * outer;
        const [from, to, middle] = [at(-elevation, arc), at(top, arc), at(radius / 2 - elevation, arc)];
        above += `<path d="M${f(from[0])} ${f(from[1])} A${f(arc)} ${f(arc)} 0 0 0 ${f(to[0])} ${f(to[1])}" class="bowplace-angle"/>`;
        labels += svgText(middle[0], middle[1], `${Math.round(radius)}°`, "figure-note");
    });

    const drops = "bowplace-rain-drops";
    let svg = `<defs><pattern id="${drops}" width="11" height="15" patternUnits="userSpaceOnUse"><line x1="7" y1="2" x2="5" y2="9" class="bowplace-drop"/></pattern></defs>`;
    svg += `<rect x="${f(rain - 0.07 * width)}" y="0" width="${f(0.14 * width)}" height="${f(ground)}" fill="url(#${drops})"/>`;
    svg += below;
    svg += `<rect x="0" y="${f(ground)}" width="${width}" height="${f(height - ground)}" class="figure-veil"/>`;
    svg += line(0, ground, width, ground, 'class="figure-horizon"');
    svg += above;
    svg += `<circle cx="${f(you)}" cy="${f(ground)}" r="3.5" class="bowplace-eye"/>`;
    svg += labels + svgText(you - GAP - 2, ground + 12, "you", "figure-label figure-anchor-end");
    svg += svgText(rain + 0.07 * width + GAP, ground - 9, "rain", "figure-label figure-anchor-start");
    drawSvg(sideEl, svg + sunSymbol(sunAt[0], sunAt[1], ground), 1);
}

/** As seen: the sky opposite the Sun, stereographic about the horizon's point under the bows, so circles stay circles. */
function drawSky(elevation: number) {
    const [width, height] = [skyEl.clientWidth || 336, skyEl.clientHeight || 252];
    skyEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const horizon = 0.58 * height;
    // 65 degrees to either side of the middle.
    const scale = width / (4 * Math.tan(32.5 * DEG));
    const sunDirection = sunBehind(elevation);
    /** Looking along y, away from the Sun, x to the right. */
    const project = (d: Vec3) => {
        const k = (2 * scale) / (1 + Math.max(d[1], -0.9));
        return { x: width / 2 + k * d[0], y: horizon - k * d[2], facing: d[1] };
    };

    /** A circle `radius` degrees around the antisolar point as runs of points, those over the horizon or those under it. */
    const runs = (radius: number, over: boolean) => {
        const all: string[][] = [];
        let run: string[] | null = null;
        for (let around = -180; around <= 180; around += 0.5) {
            const d = bowDirection(sunDirection, radius, around);
            const { x, y, facing } = project(d);
            if (d[2] >= 0 === over && facing > -0.5) {
                if (!run) {
                    run = [];
                    all.push(run);
                }
                run.push(`${f(x)},${f(y)}`);
            } else run = null;
        }
        return all.filter((points) => points.length > 1);
    };
    const polylines = (radius: number, over: boolean, attributes: string) =>
        runs(radius, over)
            .map((points) => `<polyline points="${points.join(" ")}" ${attributes}/>`)
            .join("");

    let svg = `<rect x="0" y="${f(horizon)}" width="${width}" height="${f(height - horizon)}" class="figure-ground"/>`;
    let labels = "";
    for (const order of ORDERS) {
        const radius = bowRadius(order);
        svg += polylines(radius, false, HIDDEN);
        for (const nm of WAVELENGTHS) svg += polylines(bowRadius(order, nm), true, bow(order, nm));
        const top = bowTop(elevation, order);
        if (top > 0) {
            const { x, y } = project(bowDirection(sunDirection, bowRadius(order, WAVELENGTHS[order === 1 ? 0 : 4]), 0));
            labels += svgText(x, y - 10, `${top.toFixed(0)}°`, "figure-note");
        }
    }
    svg += line(0, horizon, width, horizon, 'class="figure-horizon"');
    const point = project([-sunDirection[0], -sunDirection[1], -sunDirection[2]]);
    if (point.y < height - 14 && point.y > 14) {
        svg +=
            line(point.x - 5, point.y, point.x + 5, point.y, 'class="bowplace-point"') +
            line(point.x, point.y - 5, point.x, point.y + 5, 'class="bowplace-point"');
        // Its name clear of the horizon.
        const named = Math.abs(point.y - horizon) < 9 ? horizon + 13 : point.y;
        labels += svgText(point.x + 5 + GAP, named, "antisolar point", "figure-label figure-anchor-start");
    } else
        labels += svgText(
            width / 2,
            point.y > horizon ? height - 10 : 10,
            `antisolar point ${point.y > horizon ? "↓" : "↑"}`,
            "figure-label",
        );
    drawSvg(skyEl, svg + labels, 1);
}

/** The Sun `elevation` degrees up behind an observer who looks along y. */
const sunBehind = (elevation: number): Vec3 => [0, -Math.cos(elevation * DEG), Math.sin(elevation * DEG)];

/** The share of a circle `radius` degrees around the antisolar point that stands over the horizon. */
function shareOver(sunDirection: Vec3, radius: number) {
    let over = 0;
    for (let around = 0; around < 360; around += 0.5) if (bowDirection(sunDirection, radius, around)[2] > 0) ++over;
    return over / 720;
}

// The Sun's elevation in degrees, the figure's own.
let elevation = Number(slider.value);

function render() {
    drawSide(elevation);
    drawSky(elevation);
    sliderValue.textContent = `${elevation.toFixed(1)}°`;
    const [primary, secondary] = [bowTop(elevation, 1), bowTop(elevation, 2)];
    readout.innerHTML =
        `<span class="status-title">Sun ${elevation.toFixed(1)}° up:</span> ` +
        (primary > 0
            ? `the primary bow's top stands ${primary.toFixed(1)}° over the horizon, the secondary's ${secondary.toFixed(1)}°, and ` +
              `${Math.round(100 * shareOver(sunBehind(elevation), bowRadius(1)))}% of the primary's circle clears the ground.`
            : secondary > 0
              ? `higher than the primary bow's ${bowRadius(1).toFixed(1)}°, so its circle lies in the ground; the secondary's top still stands ${secondary.toFixed(1)}° up.`
              : `higher than both bows' radii, ${bowRadius(1).toFixed(1)}° and ${bowRadius(2).toFixed(1)}°: no bow can stand over level ground.`);
}

const requestRender = onDemand(render, root);
slider.addEventListener("input", () => {
    elevation = Number(slider.value);
    requestRender();
});
// Each bow's mark where the Sun is as high as the bow is wide, and the bow gone.
for (const order of ORDERS)
    find<HTMLElement>(`[data-field="bowMark${order}"]`, root).style.left = `${(100 * bowRadius(order)) / 90}%`;

// The Sun dragged around the observer, from the horizon to overhead; a press elsewhere scrolls the page.
let grabbed: number | null = null;
const pointerElevation = (event: PointerEvent) => {
    const box = sideEl.getBoundingClientRect();
    return Math.atan2(side.ground - (event.clientY - box.top), side.you - (event.clientX - box.left)) / DEG;
};
sideEl.addEventListener("pointerdown", (event) => {
    const box = sideEl.getBoundingClientRect();
    if (Math.hypot(event.clientX - box.left - side.sun[0], event.clientY - box.top - side.sun[1]) > SUN_REACH) return;
    grabbed = pointerElevation(event) - elevation;
    sideEl.setPointerCapture(event.pointerId);
    sideEl.classList.add("dragging");
    event.preventDefault();
});
sideEl.addEventListener("pointermove", (event) => {
    if (grabbed === null) return;
    const step = Number(slider.step);
    elevation = Math.min(Math.max(Math.round((pointerElevation(event) - grabbed) / step) * step, 0), 90);
    slider.value = String(elevation);
    paintRange(slider);
    requestRender();
});
for (const type of ["pointerup", "pointercancel"])
    sideEl.addEventListener(type, () => {
        grabbed = null;
        sideEl.classList.remove("dragging");
    });
new ResizeObserver(requestRender).observe(sideEl);
