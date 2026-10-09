import * as precise from "@himmelszelt/sternzeit";

// Text inside the figures' SVGs is at the page's small text size (--text-small, 0.75rem, like the compass labels)
// whatever size the SVG is drawn at: each figure passes how many of its own units one screen pixel is.
const SMALL_TEXT_PX = 12;
const DEG = precise.DEG_TO_RAD;

/** Fills a figure's SVG; its CSS sizes text and sun symbols in screen pixels by --units-per-px (see global.css). */
export function drawSvg(element, svg, unitsPerPx) {
    element.style.setProperty("--units-per-px", unitsPerPx.toFixed(4));
    element.innerHTML = svg;
}

/** Text made safe for HTML and SVG, in element content and in quoted attributes alike. */
export const escapeText = (text) => String(text).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** A color of the page's theme, from its custom property, for figures drawn by script (Zdog takes no CSS). */
export const cssColor = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** The eight compass directions, from north through east, 45 degrees apart. */
export const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** What a label keeps from the line or the mark it names, and the room above and below the flat strips, in pixels. */
export const LABEL_GAP = 6;
export const STRIP_MARGIN = { top: 12, bottom: 20 };

export function svgText(x, y, text, cls) {
    return `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" class="${cls}">${escapeText(text)}</text>`;
}

// A label at the top of a figure, as far below its upper edge as the panel captions sit below their panels (0.5rem).
const TOP_PADDING_PX = 8;

/** The y of a middle-aligned label just inside the top of a panel whose half size is `half`, in panel units. */
function topLabelY(half, unitsPerPx) {
    return -half + (TOP_PADDING_PX + SMALL_TEXT_PX / 2) * unitsPerPx;
}

/**
 * A direction seen along the vertical circle through `azimuth0`, in degrees: x the true angle off that circle to the right,
 * y the angle along it, negated (y down), up from the horizon ahead and on over the zenith. Close to the circle this is
 * azimuth and altitude, but unlike them it stays smooth near the zenith, where the azimuth swings through half the
 * compass within a few degrees.
 */
export function alongVerticalCircle({ azimuth, altitude }, azimuth0) {
    const [a, h] = [((azimuth - azimuth0) * Math.PI) / 180, (altitude * Math.PI) / 180];
    const x = (Math.asin(Math.cos(h) * Math.sin(a)) * 180) / Math.PI;
    return { x, y: (-Math.atan2(Math.sin(h), Math.cos(h) * Math.cos(a)) * 180) / Math.PI };
}

/** The y of a middle-aligned label sitting just above a line at `y`, such as a compass direction on the horizon. */
export function labelAboveY(y, unitsPerPx) {
    return y - (2 + SMALL_TEXT_PX / 2) * unitsPerPx;
}

/**
 * The Sun wherever it appears as a symbol rather than a disc to scale, in the locked views, the sun path diagram and
 * dunstkreis' figures: a filled disc with a ring of dotted rays, one motif the reader learns once, the same size in
 * screen pixels everywhere. The rays start `gap` past the disc and are `length` long; their stroke is in the CSS.
 */
export const SUN_SYMBOL = { radius: 8.5, gap: 5, length: 8.5, rays: 8 };

/** The symbol's rays as segments around its center, in screen pixels. */
export function sunRays() {
    const { radius, gap, length, rays } = SUN_SYMBOL;
    const [inner, outer] = [radius + gap, radius + gap + length];
    return Array.from({ length: rays }, (_, i) => {
        const [c, s] = [Math.cos((i / rays) * 2 * Math.PI), Math.sin((i / rays) * 2 * Math.PI)];
        return [
            { x: inner * c, y: inner * s },
            { x: outer * c, y: outer * s },
        ];
    });
}

/** The Sun as a symbol at (x, y) in an SVG drawn at `unitsPerPx` of its units to a screen pixel. */
export function sunSymbol(x, y, unitsPerPx) {
    const r = (SUN_SYMBOL.radius * unitsPerPx).toFixed(2);
    let svg = `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="${r}" class="figure-sun"/>`;
    for (const [a, b] of sunRays()) {
        const [x1, y1, x2, y2] = [
            x + a.x * unitsPerPx,
            y + a.y * unitsPerPx,
            x + b.x * unitsPerPx,
            y + b.y * unitsPerPx,
        ];
        const points = `x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"`;
        svg += `<line ${points} class="figure-sun-ray"/>`;
    }
    return svg;
}

// An altitude line with its angle at the left end: the text sits on the line's own height, the line picks up after
// it. The label is set flush against the line's start, so that -30° lines up with 30° digit for digit.
const GRID_LABEL_PADDING_PX = 6;
const GRID_LABEL_WIDTH_PX = 30;
const GRID_LABEL_GAP_PX = 5;

/** A dotted altitude line at `y`, from `left` to `right` in figure units, labeled with `label` at its left end. */
export function gridLine(y, left, right, label, unitsPerPx) {
    const start = left + (GRID_LABEL_PADDING_PX + GRID_LABEL_WIDTH_PX) * unitsPerPx;
    const line = `<line x1="${start.toFixed(2)}" y1="${y.toFixed(2)}" x2="${right.toFixed(2)}" y2="${y.toFixed(2)}" class="figure-grid"/>`;
    return svgText(start - GRID_LABEL_GAP_PX * unitsPerPx, y, label, "figure-grid-label") + line;
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a) => {
    const length = Math.hypot(...a);
    return a.map((c) => c / length);
};

/**
 * Where the Sun stands as seen from the Moon's place in the sky, in the frame every figure draws that sky in: right
 * across the view, up towards the zenith, and toward the viewer. It is what tilts the crescent, and it belongs to
 * the observer, not to any one panel, so every figure that shows the Moon from here has to agree on it.
 */
export function sunInViewFrame(time, observer) {
    const lineOfSight = precise.moon.direction(time, observer);
    // (v x z) x v is the zenith with the line of sight taken out of it: straight up, across the view.
    const up = normalize(cross(cross(lineOfSight, [0, 0, 1]), lineOfSight));
    const right = cross(lineOfSight, up);
    const sun = precise.moon.sunDirection(time, observer);
    return { right: dot(sun, right), up: dot(sun, up), toward: -dot(sun, lineOfSight) };
}

// Earthshine peaks at this, a relative strength rather than a fraction of sunlight (see moon.earthshine): the night
// side is at its bluest.
export const EARTHSHINE_MAX = 0.095;

/**
 * A point on the Moon at selenographic longitude `lon` and latitude `lat` (degrees), seen with the sub-observer point at
 * (`l`, `b`), the libration: x right (selenographic east, which is sky west), y up (lunar north), z towards the viewer.
 */
export function selenographic(lon, lat, l, b) {
    const [dl, la, bb] = [(lon - l) * DEG, lat * DEG, b * DEG];
    return [
        Math.cos(la) * Math.sin(dl),
        Math.sin(la) * Math.cos(bb) - Math.cos(la) * Math.sin(bb) * Math.cos(dl),
        Math.sin(la) * Math.sin(bb) + Math.cos(la) * Math.cos(bb) * Math.cos(dl),
    ];
}

/** Rotates (x right, y up) counterclockwise by `angle` degrees and flips y for SVG (y down). */
export function toScreen([x, y], angle, radius) {
    const [c, s] = [Math.cos(angle * DEG), Math.sin(angle * DEG)];
    return [(x * c - y * s) * radius, -(x * s + y * c) * radius];
}

/** Splits a curve on the Moon into the runs facing the viewer (z > 0), in screen coordinates. */
export function visibleRuns(points, angle, radius) {
    const runs = [];
    let run = null;
    for (const p of points) {
        if (p[2] > 0) {
            if (!run) {
                run = [];
                runs.push(run);
            }
            run.push(toScreen(p, angle, radius));
        } else run = null;
    }
    return runs.filter((r) => r.length > 1);
}

const polylinePoints = (points) => points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");

/**
 * The Moon as a symbol at (x, y): a disc of `radius` with `lit` of it (0 to 1) shining towards (dx, dy), the way it
 * would look to the eye. The terminator is the ellipse it really is, so the crescent bulges the right way, and the
 * night side carries the earthshine, which is at its strongest with the least of the Moon lit. With a `graticule`
 * ({ longitude, latitude } of the libration and the `tilt` of the Moon's north, counterclockwise from up, in degrees),
 * its equator and prime meridian show which way the Moon is turned and how far we see around it.
 */
export function moonSymbol(x, y, radius, lit, dx, dy, earthshine = 0, graticule = null) {
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const waist = (radius * Math.abs(1 - 2 * lit)).toFixed(2);
    // Counterclockwise back over the bright side for a crescent, clockwise around the dark one for a gibbous moon.
    const sweep = lit < 0.5 ? 0 : 1;
    const limb = `M 0 ${-radius} A ${radius} ${radius} 0 0 1 0 ${radius}`;
    const terminator = `A ${waist} ${radius} 0 0 ${sweep} 0 ${-radius}`;
    const glow = (Math.min(earthshine, EARTHSHINE_MAX) / EARTHSHINE_MAX).toFixed(3);
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${angle.toFixed(2)})">
        <circle r="${radius}" class="figure-moon" style="--earthshine: ${glow}"/>
        <path d="${limb} ${terminator} Z" class="figure-moon-lit"/></g>${graticule ? moonGraticule(x, y, radius, graticule) : ""}`;
}

function moonGraticule(x, y, radius, { longitude, latitude, tilt }) {
    const equator = Array.from({ length: 73 }, (_, i) => selenographic(-180 + i * 5, 0, longitude, latitude));
    const meridian = Array.from({ length: 37 }, (_, i) => selenographic(0, -90 + i * 5, longitude, latitude));
    const runs = [...visibleRuns(equator, tilt, radius), ...visibleRuns(meridian, tilt, radius)];
    const lines = runs.map((run) => `<polyline points="${polylinePoints(run)}" class="figure-moon-graticule"/>`);
    return `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">${lines.join("")}</g>`;
}

/**
 * The visible horizon at `y` across a square panel of half size `half`, the ground beneath veiling what it hides; or,
 * with the horizon above the panel, the whole panel veiled and a note saying so.
 */
export function veiledHorizon(y, half, unitsPerPx, halfWidth = half, label = null) {
    if (y >= half) return "";
    const top = Math.max(y, -half);
    const veil = `<rect x="${-halfWidth}" y="${top.toFixed(2)}" width="${2 * halfWidth}" height="${(half - top).toFixed(2)}" class="figure-veil"/>`;
    const { x = 0, y: labelY = topLabelY(half, unitsPerPx), cls = "figure-note" } = label ?? {};
    if (y <= -half) return veil + svgText(x, labelY, "below the horizon", cls);
    return `${veil}<line x1="${-halfWidth}" y1="${y.toFixed(2)}" x2="${halfWidth}" y2="${y.toFixed(2)}" class="figure-horizon"/>`;
}
