// The indicator for a body outside a panel, shared by every figure so it looks the same everywhere: an arrow on a
// circle around the panel's center pointing towards the body, its tail a disc colored like the body (white for the
// Sun, muted for the Moon).
// Sizes are screen pixels; each figure passes how many of its own units one pixel is.
const LENGTH_PX = 12;
const HEAD_LENGTH_PX = 4;
const HEAD_HALF_WIDTH_PX = 2.4;
const TAIL_DIAMETER_PX = 5;
const TAIL_GAP_PX = 1.5;

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
