import { rayleighAt, rgbOfSpectrum, solarIrradianceAt } from "@himmelszelt/dunstkreis";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, SUN_SYMBOL, sunGlow, sunRays, svgText } from "../sternzeit/figure";
import "../sternzeit/export";

// Why the sky is blue, not to scale: a planet half as wide as Earth under air drawn four times as thick, all of it in the
// drawing's own km, so every ray is straight. Seven rays of sunlight fade as the air scatters them; dots all over the
// air show it scattering the sunlight that reaches it, in the color of what it scatters there.
const COLORS = [
    { nm: 650, name: "red" },
    { nm: 600, name: "orange" },
    { nm: 575, name: "yellow" },
    { nm: 530, name: "green" },
    { nm: 490, name: "cyan" },
    { nm: 455, name: "blue" },
    { nm: 420, name: "violet" },
] as const;
// The air drawn this many times as thick, its density falling by e every this many km of the drawing; scattering per
// km as much weaker, then this many times as strong as the air's, so it shows with the Sun high too.
const THICKER = 4;
const STRONGER = 3;
// Half Earth's radius, so the ground curves away under the bars.
const GROUND = 3180;
// The air drawn up to 40 km, with all but 0.7% of it below.
const TOP_KM = 40;
const AIR_KM = TOP_KM * THICKER;
const SCALE_HEIGHT = 8 * THICKER;
const SHELL = GROUND + AIR_KM;
const beta = (nm: number) => (STRONGER * rayleighAt(nm)) / THICKER;
// How many dots, fixed in the drawing, and their radius, in px.
const DOTS = 700;
const DOT_PX = 1.6;
// The view: this many km of the drawing wide from the observer, who stands this far in from the left, in px.
const VIEW_KM = 750;
const LEFT_PX = 84;
const ABOVE_PX = 26;
// The heights marked on the left, in real km: those with half and nine tenths of all the air below them, its density
// falling by e every 8 km, and the top.
const AIR_BELOW = [0.5, 0.9];
const heightWithAirBelow = (share: number) => -8 * Math.log(1 - share);
// Room under the ground at the observer for the bars and their names, in px.
const BARS_ROOM = 70;
// The faint parallel lines of the sunlight everywhere, this far apart across the beam, in px.
const HATCH_PX = 16;
// Within this many px of the zenith, the Sun is put right over it.
const ZENITH_SNAP_PX = 8;
// The gap left around the observer by the ray and the zenith's line, in px.
const OBSERVER_GAP_PX = 9;
// The lens on the ray: its center this far in from where the ray comes into view, its radius, in px.
const LENS_FROM_PX = 48;
const LENS_PX = 15;
// The bars of what arrives, what is scattered out, and what the sky adds: this tall at most, this wide, in px.
const BAR_PX = 32;
const BAR_WIDTH = 5;
// The bar of the one color each group adds up to, under it, this tall, in px.
const COLOR_BAR_PX = 10;
// The Sun's light above the air at each color, against its most: not flat, most in blue and green, less in violet.
const SUNLIGHT = COLORS.map(({ nm }) => solarIrradianceAt(nm));
const SUNLIGHT_SHARE = SUNLIGHT.map((value) => value / Math.max(...SUNLIGHT));
// The sky's light is a few percent of the Sun's: its bars drawn this many times as tall, and labeled so.
const SKY_TIMES = 5;
const GROUPS = ["direct", "scattered", `sky \u00D7${SKY_TIMES}`];
// The sky's light is summed over the hemisphere in this many rings of zenith angle and sectors of azimuth, and this
// many steps along each line of sight.
const [RINGS, SECTORS, SIGHT_STEPS] = [10, 16, 20];

type Vec2 = [number, number];
const svgEl = find<SVGSVGElement>("#blue-sky .blue-sky-panel > svg");
const requestRender = onDemand(() => render(), svgEl);
const f = (n: number) => n.toFixed(1);
const heightAt = ([x, y]: Vec2) => Math.hypot(x, y + GROUND) - GROUND;
const density = (h: number) => Math.exp(-Math.max(h, 0) / SCALE_HEIGHT);

// The observer, dragged up from the ground to the top of the air, in km of the drawing.
const observer = { km: 0 };

// The Sun as a place in the figure, as shares of its width and height, dragged along the air's top and the right edge;
// it stays put while the observer moves, and its direction from them is the sunlight's.
const sunAt = { x: 0.34, y: 0.1 };

/** A small seeded random generator, mulberry32: the dots stay where they are. */
function seeded(seed: number) {
    let a = seed;
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// The dots, fixed: as many at each height as the air's density there, spread along the ground right of the zenith.
const DOT_POINTS: Vec2[] = (() => {
    const random = seeded(7);
    const points: Vec2[] = [];
    while (points.length < DOTS) {
        const h = -SCALE_HEIGHT * Math.log(1 - random());
        if (h > AIR_KM) continue;
        const angle = ((0.02 + random() * 1.02) * VIEW_KM) / GROUND;
        points.push([(GROUND + h) * Math.sin(angle), (GROUND + h) * Math.cos(angle) - GROUND]);
    }
    return points;
})();

/** How far a ray from p along d runs to the atmosphere's top, or null if the ground is in the way. */
function toTop([px, py]: Vec2, [dx, dy]: Vec2) {
    const [qx, qy] = [px, py + GROUND];
    const b = qx * dx + qy * dy;
    const q2 = qx * qx + qy * qy;
    if (b < 0 && b * b - (q2 - GROUND * GROUND) > 0) return null;
    return -b + Math.sqrt(Math.max(b * b - (q2 - SHELL * SHELL), 0));
}

/** How much air lies between p and the top along d, in km of it at the ground's density; null in the planet's shadow. */
function column(p: Vec2, d: Vec2) {
    const length = toTop(p, d);
    if (length === null) return null;
    const STEPS = 48;
    let sum = 0;
    for (let i = 0; i < STEPS; ++i) {
        const [u0, u1] = [i / STEPS, (i + 1) / STEPS];
        const t = length * ((u0 + u1) / 2) ** 2;
        sum += density(heightAt([p[0] + d[0] * t, p[1] + d[1] * t])) * length * (u1 * u1 - u0 * u0);
    }
    return sum;
}

const encode = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
const luminance = (rgb: readonly number[]) => 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);
/**
 * What the air scatters where the sunlight has crossed a given column of it: its color, and how much against what
 * it would scatter of the full sunlight. A table over columns in steps of a sixth of a doubling, from a quarter km.
 */
const SCATTER_TABLE = (() => {
    const scattered = (air: number) => rgbOfSpectrum((nm) => beta(nm) * Math.exp(-beta(nm) * air));
    const full = luminance(scattered(0));
    return Array.from({ length: 96 }, (_, i) => {
        const rgb = scattered(i === 0 ? 0 : 2 ** (i / 6 - 2)).map((c) => Math.max(c, 0));
        const top = Math.max(...rgb) || 1;
        return { color: `rgb(${rgb.map((c) => encode(c / top)).join(" ")})`, strength: luminance(rgb) / full };
    });
})();
const scatterAt = (air: number) => {
    const i = air <= 0 ? 0 : Math.max(1, Math.round(6 * (Math.log2(air) + 2)));
    return SCATTER_TABLE[Math.min(SCATTER_TABLE.length - 1, i)] ?? { color: "", strength: 0 };
};

/** How much air lies above a point at height h along a direction at cosine mu to its zenith, null in the shadow. */
const columnFrom = (h: number, mu: number) => column([0, h], [Math.sqrt(Math.max(1 - mu * mu, 0)), mu]);

/**
 * The sky's light on a level surface at the observer, against the Sun's above the air, for each color: summed over
 * the hemisphere, along each line of sight, the sunlight that reaches each point, scattered there towards the eye by
 * Rayleigh's phase function, and dimmed on the way to it. In three dimensions, the Sun in the drawing's plane. Once.
 */
let sky: { altitude: number; observer: number; light: number[] } | null = null;
function skyLight(altitude: number) {
    if (sky?.altitude === altitude && sky.observer === observer.km) return sky.light;
    const rad = (altitude * Math.PI) / 180;
    const sun = [Math.cos(rad), 0, Math.sin(rad)];
    // Each sample's weight and the air between it and the eye and between it and the Sun, the same for every color.
    const samples: { weight: number; air: number }[] = [];
    for (let ring = 0; ring < RINGS; ++ring) {
        const theta = ((ring + 0.5) / RINGS) * (Math.PI / 2);
        const solid = Math.sin(theta) * (Math.PI / 2 / RINGS) * ((2 * Math.PI) / SECTORS);
        for (let sector = 0; sector < SECTORS; ++sector) {
            const phi = ((sector + 0.5) / SECTORS) * 2 * Math.PI;
            const view = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
            const cosine = view[0] * sun[0] + view[2] * sun[2];
            const phase = (3 / (16 * Math.PI)) * (1 + cosine * cosine);
            const length = toTop([0, observer.km], [Math.sin(theta), Math.cos(theta)]) ?? 0;
            let toEye = 0;
            for (let i = 0; i < SIGHT_STEPS; ++i) {
                const [u0, u1] = [i / SIGHT_STEPS, (i + 1) / SIGHT_STEPS];
                const t = length * ((u0 + u1) / 2) ** 2;
                const ds = length * (u1 * u1 - u0 * u0);
                const point = [view[0] * t, view[1] * t, view[2] * t + GROUND + observer.km];
                const r = Math.hypot(point[0], point[1], point[2]);
                const h = r - GROUND;
                const air = density(h) * ds;
                const toSun = columnFrom(h, (point[0] * sun[0] + point[2] * sun[2]) / r);
                if (toSun !== null)
                    samples.push({ weight: air * phase * Math.cos(theta) * solid, air: toEye + air / 2 + toSun });
                toEye += air;
            }
        }
    }
    const light = COLORS.map(({ nm }) => {
        let sum = 0;
        for (const { weight, air } of samples) sum += weight * Math.exp(-beta(nm) * air);
        return beta(nm) * sum;
    });
    sky = { altitude, observer: observer.km, light };
    return light;
}

/** A linear sRGB color as CSS at its brightest, the parts outside the gamut cut off. */
function hue(rgb: readonly number[]) {
    const clipped = rgb.map((c) => Math.max(c, 0));
    const top = Math.max(...clipped) || 1;
    return `rgb(${clipped.map((c) => encode(c / top)).join(" ")})`;
}
const SUN_LUMINANCE = luminance(rgbOfSpectrum(() => 1));
/** What is left of the sunlight behind a column of air: its color, and how bright against the Sun's above the air. */
function remaining(air: number) {
    const rgb = rgbOfSpectrum((nm) => Math.exp(-beta(nm) * air));
    // Where next to nothing is left, the color of the last of it, red, rather than of rounding noise.
    const color = rgb[0] > 1e-6 * SUN_LUMINANCE ? hue(rgb) : "var(--blue-sky-red)";
    return { color, brightness: luminance(rgb) / SUN_LUMINANCE };
}
/** The sky's color from its light at the seven wavelengths, in between them linearly and held beyond. */
function skyColor(light: number[]) {
    const at = (nm: number) => {
        const [first, last] = [COLORS[COLORS.length - 1], COLORS[0]] as const;
        if (nm <= first.nm) return light[COLORS.length - 1] ?? 0;
        if (nm >= last.nm) return light[0] ?? 0;
        const k = COLORS.findIndex((color) => color.nm <= nm);
        const [a, b] = [COLORS[k - 1], COLORS[k]] as [(typeof COLORS)[number], (typeof COLORS)[number]];
        const t = (nm - b.nm) / (a.nm - b.nm);
        return (light[k] ?? 0) * (1 - t) + (light[k - 1] ?? 0) * t;
    };
    return hue(rgbOfSpectrum(at));
}

let geometry = { scale: 1, observer: [0, 0] as Vec2 };
const sunHandle: { at: Vec2 } = { at: [0, 0] };

function render() {
    const width = svgEl.clientWidth || 600;
    const scale = (width - LEFT_PX) / VIEW_KM;
    const below = GROUND - Math.sqrt(GROUND * GROUND - VIEW_KM * VIEW_KM) + 4;
    const height = Math.round(Math.max(ABOVE_PX + (AIR_KM + below) * scale, ABOVE_PX + AIR_KM * scale + BARS_ROOM));
    svgEl.style.height = `${height}px`;
    svgEl.setAttribute("viewBox", `0 0 ${width} ${height}`);
    geometry = { scale, observer: [LEFT_PX, ABOVE_PX + (AIR_KM - observer.km) * scale] };
    const at = ([x, y]: Vec2): Vec2 => [LEFT_PX + x * scale, ABOVE_PX + (AIR_KM - y) * scale];
    const [cx, cy] = at([0, -GROUND]);

    // The Sun where it was put, kept whole in the figure; the sunlight's direction is from it to the observer, and the
    // same for all of it.
    const reach = SUN_SYMBOL.radius + SUN_SYMBOL.gap + SUN_SYMBOL.length;
    const [ox0, oy0] = geometry.observer;
    // On the air's top, where the pointer points from the planet's center, from the zenith (caught there within a few
    // px) to the right edge; past that, down the right edge to the corner.
    const [px, py] = [sunAt.x * width, sunAt.y * height];
    const radius = SHELL * scale;
    const edgeX = width - reach;
    const arcY = (x: number) => cy - Math.sqrt(Math.max(radius * radius - (x - cx) ** 2, 0));
    const theta = Math.max(Math.atan2(px - cx, cy - py), 0);
    let [sx, sy] = [cx + radius * Math.sin(theta), cy - radius * Math.cos(theta)];
    if (sx - LEFT_PX < ZENITH_SNAP_PX) [sx, sy] = [LEFT_PX, arcY(LEFT_PX)];
    if (sx > edgeX || px > edgeX) [sx, sy] = [edgeX, Math.min(Math.max(py, arcY(edgeX)), height - reach)];
    const rad = Math.atan2(oy0 - sy, sx - ox0);
    const altitude = (rad * 180) / Math.PI;
    const back: Vec2 = [Math.cos(rad), Math.sin(rad)];

    // Flat: the air's top and the ground, as lines.
    let svg = `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(SHELL * scale)}" class="blue-sky-shell"/>`;
    svg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(GROUND * scale)}" class="blue-sky-earth"/>`;

    // The sunlight everywhere, not one ray: faint parallel lines across the air at a constant distance, each from where
    // it enters the air to where it meets the ground or leaves again.
    const across: Vec2 = [-back[1], back[0]];
    const reachKm = (width + height) / scale;
    // Right of the zenith only, the left kept for the heights' names.
    svg += `<clipPath id="blue-sky-right"><rect x="${LEFT_PX}" width="${width}" height="${height}"/></clipPath><g clip-path="url(#blue-sky-right)">`;
    for (let o = -reachKm; o <= reachKm; o += HATCH_PX / scale) {
        const p: Vec2 = [across[0] * o, across[1] * o + GROUND];
        const b = p[0] * back[0] + p[1] * back[1];
        const c = p[0] * p[0] + p[1] * p[1];
        const shell = b * b - (c - SHELL * SHELL);
        if (shell <= 0) continue;
        const entry = -b + Math.sqrt(shell);
        const ground = b * b - (c - GROUND * GROUND);
        const exit = ground > 0 ? -b + Math.sqrt(ground) : -b - Math.sqrt(shell);
        if (exit >= entry) continue;
        const [ax, ay] = at([p[0] + back[0] * entry, p[1] - GROUND + back[1] * entry]);
        const [bx, by] = at([p[0] + back[0] * exit, p[1] - GROUND + back[1] * exit]);
        svg += `<line x1="${f(ax)}" y1="${f(ay)}" x2="${f(bx)}" y2="${f(by)}" class="blue-sky-hatch"/>`;
    }
    svg += "</g>";

    // The dots: the sunlight that reaches each, scattered there; none in the planet's shadow.
    svg += `<g class="blue-sky-dots">`;
    for (const point of DOT_POINTS) {
        const air = column(point, back);
        if (air === null) continue;
        const { color, strength } = scatterAt(air);
        if (strength < 0.03) continue;
        const [x, y] = at(point);
        svg += `<circle cx="${f(x)}" cy="${f(y)}" r="${DOT_PX}" fill="${color}" fill-opacity="${Math.min(1, 0.25 + strength).toFixed(2)}"/>`;
    }
    svg += "</g>";

    // Heights on the left, up the observer's zenith, each named by the real height it stands for, and where half,
    // nine tenths and 99 in 100 of the air lie below.
    const [, groundY] = at([0, 0]);
    const [, topY] = at([0, AIR_KM]);
    // Broken around the observer.
    const [, observerY] = geometry.observer;
    const gapBelow = Math.min(groundY, observerY + OBSERVER_GAP_PX);
    const gapAbove = Math.max(topY, observerY - OBSERVER_GAP_PX);
    if (groundY > gapBelow)
        svg += `<line x1="${LEFT_PX}" y1="${f(groundY)}" x2="${LEFT_PX}" y2="${f(gapBelow)}" class="blue-sky-axis"/>`;
    if (gapAbove > topY)
        svg += `<line x1="${LEFT_PX}" y1="${f(gapAbove)}" x2="${LEFT_PX}" y2="${f(topY)}" class="blue-sky-axis"/>`;
    const realKm = (km: number) => `${km > 0.05 && km < 10 ? km.toFixed(1) : Math.round(km)}\u202Fkm`;
    const level = (km: number, share: string | null) => {
        const [, y] = at([0, km * THICKER]);
        let out = `<line x1="${f(LEFT_PX - 5)}" y1="${f(y)}" x2="${f(LEFT_PX)}" y2="${f(y)}" class="blue-sky-axis"/>`;
        out += svgText(LEFT_PX - 8, y, realKm(km), "figure-grid-label");
        if (share) out += svgText(LEFT_PX + 6, y, share, "figure-label figure-anchor-start blue-sky-share");
        return out;
    };
    for (const share of AIR_BELOW) svg += level(heightWithAirBelow(share), `${Math.round(share * 100)}%`);
    const topShare = Math.floor(100 * (1 - Math.exp(-TOP_KM / 8)));
    svg += level(TOP_KM, `${topShare}% of the air below`);

    // What arrives of each color at the observer, for the bars; nothing with the Sun below their horizon.
    const atObserver = column([0, observer.km], back);
    const arrived = COLORS.map(({ nm }) => (atObserver === null ? 0 : Math.exp(-beta(nm) * atObserver)));

    // The ray starts where the sunlight enters the air, or at the Sun's symbol when that is nearer.
    const top = toTop([0, observer.km], back);
    const sunDistance = Math.hypot(sx - ox0, sy - oy0);
    const entry = top === null ? null : Math.min(top, sunDistance / scale);

    // The sunlight, one ray in from the top to the observer, at every point in the color of what is left of it and as
    // bright; across it, early on, the seven wavelengths the bars show.
    if (entry !== null && atObserver !== null) {
        const start: Vec2 = [back[0] * entry, observer.km + back[1] * entry];
        const [x1, y1] = at(start);
        const [x2, y2] = [ox0, oy0];
        const STOPS = 16;
        svg += `<defs><linearGradient id="blue-sky-ray" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}">`;
        for (let i = 0; i <= STOPS; ++i) {
            const share = i / STOPS;
            const p: Vec2 = [start[0] - back[0] * entry * share, start[1] - back[1] * entry * share];
            const crossed = i === 0 ? 0 : (column(p, back) ?? atObserver);
            const { brightness } = remaining(crossed);
            svg += `<stop offset="${share.toFixed(3)}" class="blue-sky-ray-stop" stop-opacity="${Math.max(brightness, 0.15).toFixed(3)}"/>`;
        }
        svg += "</linearGradient></defs>";
        const length = Math.hypot(x2 - x1, y2 - y1) || 1;
        const [ux, uy] = [(x2 - x1) / length, (y2 - y1) / length];
        // A gap before the observer, the arrow's tip short of them.
        const tip: Vec2 = [x2 - ux * OBSERVER_GAP_PX, y2 - uy * OBSERVER_GAP_PX];
        const [bx, by] = [tip[0] - ux * 5, tip[1] - uy * 5];
        const end = remaining(atObserver);
        svg += `<polygon points="${f(tip[0])},${f(tip[1])} ${f(bx - uy * 4)},${f(by + ux * 4)} ${f(bx + uy * 4)},${f(by - ux * 4)}" class="blue-sky-ray-head" fill-opacity="${Math.max(end.brightness, 0.15).toFixed(3)}"/>`;
        // Early on, a lens on the ray: the sunlight as it comes in, at the seven wavelengths of the bars, as a little
        // spectrum, the dashed steps over the bars. Counted from where the ray comes into view, by the Sun's symbol, when it
        // enters the air beyond the edge; on a short ray, as close to the observer as the Sun is, nearer, or none.
        const shown = Math.min(length, sunDistance);
        const at0 = length - shown + Math.min(LENS_FROM_PX, (shown - 30) / 2);
        const onRay = (d: number): Vec2 => [x1 + ux * d, y1 + uy * d];
        const line = `x1="${f(x1)}" y1="${f(y1)}" x2="${f(bx)}" y2="${f(by)}"`;
        svg += `<line ${line} stroke="url(#blue-sky-ray)" class="blue-sky-ray"/>`;
        if (shown > 2 * LENS_PX + 30) {
            const [cx, cy] = onRay(at0);
            svg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${LENS_PX}" class="blue-sky-lens"/>`;
            COLORS.forEach((color, k) => {
                const h = 16 * (SUNLIGHT_SHARE[k] ?? 1);
                svg += `<rect x="${f(cx - 10.5 + k * 3)}" y="${f(cy + 8 - h)}" width="2.4" height="${f(h)}" style="fill: var(--blue-sky-${color.name})"/>`;
            });
        }
    }

    // The observer, a point dragged up and down the zenith, named with their height and the air below them.
    const [ox, oy] = geometry.observer;
    const real = observer.km / THICKER;
    const airBelow = Math.round(100 * (1 - Math.exp(-real / 8)));
    svg += `<circle cx="${f(ox)}" cy="${f(oy)}" r="7.5" class="blue-sky-observer"/>`;
    svg += `<circle cx="${f(ox)}" cy="${f(oy)}" r="12" class="blue-sky-grab blue-sky-observer-grab"/>`;
    svg += svgText(
        ox + 44,
        oy - 12,
        `${realKm(real)}, ${airBelow}% of the air below`,
        "figure-label figure-anchor-start",
    );

    // Three groups of bars on the ground, each color in the Sun's light, under the dashed steps of it above the air: what
    // arrives of the Sun directly, what the air scatters out of it on the way, and what the sky adds, scattered out of
    // the sunlight elsewhere and towards the observer.
    const light = skyLight(altitude);
    const groups = [arrived, arrived.map((a) => 1 - a), light.map((l) => l * SKY_TIMES)].map((values) =>
        values.map((value, k) => value * (SUNLIGHT_SHARE[k] ?? 1)),
    );
    const groupWidth = COLORS.length * (BAR_WIDTH + 2);
    const barsBottom = height - 30;
    groups.forEach((values, g) => {
        const left = LEFT_PX + 14 + g * (groupWidth + 30);
        // Over the direct and the scattered light, the Sun's own above the air, a step for each color.
        if (g < 2) {
            const steps = COLORS.map((_, k) => {
                const y = f(barsBottom - BAR_PX * (SUNLIGHT_SHARE[k] ?? 1));
                return `${f(left + k * (BAR_WIDTH + 2) - 1)},${y} ${f(left + k * (BAR_WIDTH + 2) + BAR_WIDTH + 1)},${y}`;
            });
            svg += `<polyline points="${steps.join(" ")}" class="blue-sky-full"/>`;
        }
        COLORS.forEach((color, k) => {
            const h = BAR_PX * Math.min(values[k] ?? 0, 1);
            svg += `<rect x="${f(left + k * (BAR_WIDTH + 2))}" y="${f(barsBottom - h)}" width="${BAR_WIDTH}" height="${f(h)}" style="fill: var(--blue-sky-${color.name})"/>`;
        });
        // Under each group, the one color its light adds up to, as the eye would see it; an empty bar where none
        // arrives, so nothing moves.
        const color =
            g === 0
                ? atObserver === null
                    ? null
                    : remaining(atObserver).color
                : g === 1
                  ? skyColor(arrived.map((a) => 1 - a))
                  : skyColor(light);
        svg += `<rect x="${f(left)}" y="${f(barsBottom + 3)}" width="${f(groupWidth - 2)}" height="${COLOR_BAR_PX}" fill="${color ?? "none"}"/>`;
        // Struck through where nothing of it arrives.
        const none = g === 0 && atObserver === null;
        svg += svgText(
            left + groupWidth / 2,
            height - 6,
            GROUPS[g] ?? "",
            `figure-label blue-sky-bars-label${none ? " blue-sky-none" : ""}`,
        );
    });

    // The Sun, the chapters' symbol there; below the horizon, faint. All of it is the handle.
    sunHandle.at = [sx, sy];
    svg += `<g class="blue-sky-sun${entry === null ? " blue-sky-set" : ""}">`;
    svg += sunGlow(sx, sy, SUN_SYMBOL.radius, height, "figure-sun");
    svg += `<circle cx="${f(sx)}" cy="${f(sy)}" r="${SUN_SYMBOL.radius}" class="figure-sun"/>`;
    for (const [a, b] of sunRays())
        svg += `<line x1="${f(sx + a.x)}" y1="${f(sy + a.y)}" x2="${f(sx + b.x)}" y2="${f(sy + b.y)}" class="figure-sun-ray"/>`;
    svg += `<circle cx="${f(sx)}" cy="${f(sy)}" r="${SUN_SYMBOL.radius + SUN_SYMBOL.gap + SUN_SYMBOL.length}" class="blue-sky-grab"/>`;
    svg += "</g>";
    drawSvg(svgEl, svg, 1);
}

// The observer dragged up and down, the Sun anywhere; a press elsewhere scrolls the page.
let dragging: "sun" | "observer" | null = null;
let grabOffset = 0;
let grabFrom: Vec2 = [0, 0];
const pointerAt = (event: PointerEvent): Vec2 => {
    const box = svgEl.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
};
svgEl.addEventListener("pointerdown", (event: PointerEvent) => {
    const pointer = pointerAt(event);
    const reach = SUN_SYMBOL.radius + SUN_SYMBOL.gap + SUN_SYMBOL.length;
    const [ox, oy] = geometry.observer;
    if (Math.hypot(ox - pointer[0], oy - pointer[1]) <= 12) {
        dragging = "observer";
        grabOffset = pointer[1] - oy;
    } else if (Math.hypot(sunHandle.at[0] - pointer[0], sunHandle.at[1] - pointer[1]) <= reach) {
        dragging = "sun";
        grabFrom = [pointer[0] - sunHandle.at[0], pointer[1] - sunHandle.at[1]];
    } else return;
    svgEl.setPointerCapture(event.pointerId);
    event.preventDefault();
});
svgEl.addEventListener("pointermove", (event: PointerEvent) => {
    if (!dragging) return;
    if (dragging === "observer") {
        const y = pointerAt(event)[1] - grabOffset;
        observer.km = Math.min(Math.max(AIR_KM - (y - ABOVE_PX) / geometry.scale, 0), AIR_KM - 1);
    } else {
        const [x, y] = pointerAt(event);
        sunAt.x = (x - grabFrom[0]) / (svgEl.clientWidth || 1);
        sunAt.y = (y - grabFrom[1]) / (svgEl.clientHeight || 1);
    }
    requestRender();
});
const release = () => {
    dragging = null;
};
svgEl.addEventListener("pointerup", release);
svgEl.addEventListener("pointercancel", release);

new ResizeObserver(requestRender).observe(svgEl);
render();
