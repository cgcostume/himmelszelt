import { bowDirection, bowRadius, bowTop } from "@himmelszelt/gewoelk";
import { fromJulianDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../../dom";
import { onDemand } from "../../frame";
import { COMPASS, drawSvg, LABEL_GAP as GAP, SUN_SYMBOL, sunGlow, sunRays, svgText } from "../../sternzeit/figure";
import { onChange, state } from "../../sternzeit/state";
import { WAVELENGTHS, wavelengthColor } from "./spectrum";

// Where a bow can stand, for the Sun of the page's moment and place: from the side, the lines of sight that make the
// library's angles with the line to the antisolar point, and as seen, the two circles around that point over the horizon.

const DEG = Math.PI / 180;
const ORDERS = [1, 2] as const;
type Vec3 = readonly [number, number, number];

const root = find<HTMLElement>("#bow-place");
const sideEl = find<SVGSVGElement>('svg[data-panel="side"]', root);
const skyEl = find<SVGSVGElement>('svg[data-panel="sky"]', root);
const readout = find<HTMLElement>('[data-field="readout"]', root);

const f = (n: number) => n.toFixed(1);
const line = (x1: number, y1: number, x2: number, y2: number, attributes: string) =>
    `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${attributes}/>`;
/** A bow's stroke at a wavelength, as attributes. */
const bow = (order: number, nm: number) =>
    `class="bowplace-bow bowplace-order-${order}" style="stroke: ${wavelengthColor(nm)}"`;
const HIDDEN = 'class="bowplace-hidden"';

/** The Sun as the figures' symbol, in screen pixels, its glow cut off at the ground. */
function sunSymbol(x: number, y: number, ground: number) {
    let svg = sunGlow(x, y, SUN_SYMBOL.radius, ground, "figure-sun");
    svg += `<circle cx="${f(x)}" cy="${f(y)}" r="${SUN_SYMBOL.radius}" class="figure-sun"/>`;
    for (const [a, b] of sunRays()) svg += line(x + a.x, y + a.y, x + b.x, y + b.y, 'class="figure-sun-ray"');
    return svg;
}

/** From the side: the Sun behind the observer, the line on to the antisolar point, and the lines of sight to the bows. */
function drawSide(elevation: number) {
    const [width, height] = [sideEl.clientWidth || 336, sideEl.clientHeight || 252];
    sideEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const ground = 0.66 * height;
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
    const sunlight = at(180 - elevation, 0.36 * width - SUN_SYMBOL.radius - SUN_SYMBOL.gap - SUN_SYMBOL.length - 4);
    const light = line(sunlight[0], sunlight[1], you, ground, 'class="bowplace-sunlight"');
    put(elevation < 0, sunSymbol(sunAt[0], sunAt[1], ground) + light);
    const axis = at(-elevation, reach(-elevation, 0.34 * width));
    put(elevation > 0, line(you, ground, axis[0], axis[1], 'class="bowplace-axis"'));

    // The point's name beside the line's end where the panel has the room, else under or over it.
    const beside = axis[0] + GAP + 100 < width && elevation > 0;
    let labels = beside
        ? svgText(axis[0] + GAP, Math.min(axis[1], height - 9), "antisolar point", "figure-label figure-anchor-start")
        : svgText(axis[0], axis[1] + (elevation > 0 ? 12 : -12), "antisolar point", "figure-label figure-anchor-end");
    ORDERS.forEach((order, i) => {
        const radius = bowRadius(order);
        const top = radius - elevation;
        if (top > 0 && elevation > 0)
            for (const nm of WAVELENGTHS) {
                const angle = bowRadius(order, nm) - elevation;
                const end = at(angle, reach(angle, Infinity));
                above += line(you, ground, end[0], end[1], bow(order, nm));
            }
        else {
            const end = at(top, reach(top, 0.3 * width));
            put(top <= 0, line(you, ground, end[0], end[1], HIDDEN));
        }
        const under = at(-radius - elevation, reach(-radius - elevation, 0.3 * width));
        put(radius + elevation > 0, line(you, ground, under[0], under[1], HIDDEN));
        // The angle between the line to the antisolar point and the line of sight, named on its arc, while the Sun is up.
        if (elevation <= 0) return;
        const arc = (0.17 + 0.1 * i) * width;
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
    svg += svgText(rain - 0.07 * width - GAP, 12, "rain", "figure-label figure-anchor-end");
    drawSvg(sideEl, svg, 1);
}

/** As seen: the sky opposite the Sun, stereographic about the horizon's point under the bows, so circles stay circles. */
function drawSky(sunDirection: Vec3, elevation: number) {
    const [width, height] = [skyEl.clientWidth || 336, skyEl.clientHeight || 252];
    skyEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const horizon = 0.58 * height;
    // 65 degrees to either side of the middle.
    const scale = width / (4 * Math.tan(32.5 * DEG));
    const level = Math.hypot(sunDirection[0], sunDirection[1]);
    const ahead: Vec3 = level > 1e-6 ? [-sunDirection[0] / level, -sunDirection[1] / level, 0] : [0, 1, 0];
    const right: Vec3 = [ahead[1], -ahead[0], 0];
    const project = (d: Vec3) => {
        const facing = d[0] * ahead[0] + d[1] * ahead[1];
        const k = (2 * scale) / (1 + Math.max(facing, -0.9));
        return { x: width / 2 + k * (d[0] * right[0] + d[1] * right[1]), y: horizon - k * d[2], facing };
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
        if (elevation <= 0) svg += polylines(radius, true, HIDDEN);
        else for (const nm of WAVELENGTHS) svg += polylines(bowRadius(order, nm), true, bow(order, nm));
        const top = bowTop(elevation, order);
        if (elevation > 0 && top > 0) {
            const { x, y } = project(bowDirection(sunDirection, bowRadius(order, WAVELENGTHS[order === 1 ? 0 : 4]), 0));
            labels += svgText(x, y - 10, `${top.toFixed(0)}°`, "figure-note");
        }
    }
    svg += line(0, horizon, width, horizon, 'class="figure-horizon"');
    const point = project([-sunDirection[0], -sunDirection[1], -sunDirection[2]]);
    COMPASS.forEach((name, i) => {
        const d: Vec3 = [Math.sin(i * 45 * DEG), Math.cos(i * 45 * DEG), 0];
        const { x, facing } = project(d);
        if (facing > Math.cos(60 * DEG)) labels += svgText(x, horizon + 11, name, "figure-label");
    });
    if (point.y < height - 14 && point.y > 14) {
        svg +=
            line(point.x - 5, point.y, point.x + 5, point.y, 'class="bowplace-point"') +
            line(point.x, point.y - 5, point.x, point.y + 5, 'class="bowplace-point"');
        // Its name clear of the horizon and of the compass under it.
        const named = point.y > horizon - 9 && point.y < horizon + 24 ? horizon + 27 : point.y;
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

/** The share of a circle `radius` degrees around the antisolar point that stands over the horizon. */
function shareOver(sunDirection: Vec3, radius: number) {
    let over = 0;
    for (let around = 0; around < 360; around += 0.5) if (bowDirection(sunDirection, radius, around)[2] > 0) ++over;
    return over / 720;
}

function render() {
    const sunDirection = sun.direction(fromJulianDay(state.jd), state);
    const elevation = Math.asin(Math.min(Math.max(sunDirection[2], -1), 1)) / DEG;
    drawSide(elevation);
    drawSky(sunDirection, elevation);
    const [primary, secondary] = [bowTop(elevation, 1), bowTop(elevation, 2)];
    const sunUp = `<span class="status-title">Sun ${Math.abs(elevation).toFixed(1)}° ${elevation < 0 ? "under the horizon" : "up"}:</span> `;
    readout.innerHTML =
        sunUp +
        (elevation <= 0
            ? "no sunlight reaches the rain around you, and no bow stands."
            : primary > 0
              ? `the primary bow's top stands ${primary.toFixed(1)}° over the horizon, the secondary's ${secondary.toFixed(1)}°, and ` +
                `${Math.round(100 * shareOver(sunDirection, bowRadius(1)))}% of the primary's circle clears the ground.`
              : secondary > 0
                ? `higher than the primary bow's ${bowRadius(1).toFixed(1)}°, so its circle lies in the ground; the secondary's top still stands ${secondary.toFixed(1)}° up.`
                : `higher than both bows' radii, ${bowRadius(1).toFixed(1)}° and ${bowRadius(2).toFixed(1)}°: no bow can stand over level ground.`);
}

const requestRender = onDemand(render, root);
onChange(requestRender);
new ResizeObserver(requestRender).observe(sideEl);
