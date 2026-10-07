// The indicator for a body outside a panel, shared by every figure so it looks the same everywhere: an arrow at the
// panel's edge pointing towards the body, its tail a disc colored like the body (white for the Sun, muted for the Moon).
// Sizes are screen pixels; each figure passes how many of its own units one pixel is.
const INSET_PX = 10;
const LENGTH_PX = 12;
const HEAD_LENGTH_PX = 4;
const HEAD_HALF_WIDTH_PX = 2.4;
const TAIL_DIAMETER_PX = 5;
const TAIL_GAP_PX = 1.5;

/**
 * The arrow towards `point` (x right, y down, relative to the panel's center) on a square panel of half size `half`, in
 * panel units, or null while the point is inside the panel. Its tip is the point clamped to the panel's inset edge.
 */
export function offPanelArrow(point, half, unitsPerPx) {
    if (Math.abs(point.x) <= half && Math.abs(point.y) <= half) return null;
    const inset = half - INSET_PX * unitsPerPx;
    const clamp = (value) => Math.max(-inset, Math.min(inset, value));
    const tip = { x: clamp(point.x), y: clamp(point.y) };
    const length = Math.hypot(point.x - tip.x, point.y - tip.y) || 1;
    return arrow(tip, (point.x - tip.x) / length, (point.y - tip.y) / length, unitsPerPx);
}

/** The arrow along `direction` as seen from the panel's center: its tip where that ray meets the panel's inset edge. */
export function offPanelArrowFromCenter(direction, half, unitsPerPx) {
    const length = Math.hypot(direction.x, direction.y) || 1;
    const [ux, uy] = [direction.x / length, direction.y / length];
    const reach = (half - INSET_PX * unitsPerPx) / Math.max(Math.abs(ux), Math.abs(uy));
    return arrow({ x: ux * reach, y: uy * reach }, ux, uy, unitsPerPx);
}

/**
 * The arrow along `direction` around a symbol at `center`, centered on a circle of `radius` panel units around it: for a
 * body off the panel of a view that keeps the other one at its center.
 */
export function arrowAround(center, direction, radius, unitsPerPx) {
    const length = Math.hypot(direction.x, direction.y) || 1;
    const [ux, uy] = [direction.x / length, direction.y / length];
    const reach = radius + ((LENGTH_PX + TAIL_GAP_PX + TAIL_DIAMETER_PX / 2) / 2) * unitsPerPx;
    return arrow({ x: center.x + ux * reach, y: center.y + uy * reach }, ux, uy, unitsPerPx);
}

function arrow(tip, ux, uy, unitsPerPx) {
    const along = (px) => ({ x: tip.x - ux * px * unitsPerPx, y: tip.y - uy * px * unitsPerPx });
    const base = along(HEAD_LENGTH_PX);
    const [sx, sy] = [-uy * HEAD_HALF_WIDTH_PX * unitsPerPx, ux * HEAD_HALF_WIDTH_PX * unitsPerPx];
    return {
        shaft: [along(LENGTH_PX), base],
        head: [tip, { x: base.x + sx, y: base.y + sy }, { x: base.x - sx, y: base.y - sy }],
        tail: along(LENGTH_PX + TAIL_GAP_PX + TAIL_DIAMETER_PX / 2),
        tailDiameter: TAIL_DIAMETER_PX * unitsPerPx,
    };
}

/** The arrow as SVG markup, drawn in the body's own look (see .off-panel in sternzeit.css). */
export function offPanelArrowSvg(arrow, isSun) {
    const f = (n) => n.toFixed(2);
    const [a, b] = arrow.shaft;
    return `<g class="off-panel ${isSun ? "off-panel-sun" : "off-panel-moon"}">
        <line x1="${f(a.x)}" y1="${f(a.y)}" x2="${f(b.x)}" y2="${f(b.y)}"/>
        <polygon points="${arrow.head.map((p) => `${f(p.x)},${f(p.y)}`).join(" ")}"/>
        <circle cx="${f(arrow.tail.x)}" cy="${f(arrow.tail.y)}" r="${f(arrow.tailDiameter / 2)}"/></g>`;
}
