/**
 * Insets, a panel laid over a figure. Over a drawing, a frame of the dim dotted leader line and a leader from the frame
 * to the point the panel shows (`.inset-drawn` in figure.css, `leader` here); over a render, a dithered edge of whole
 * device pixels (`ditherEdge`), so the panel reads as cut into the render rather than laid on it with a line.
 */
import { barSvg, placement, scale, step, watch } from "./dither";

const num = (value: number) => String(Math.round(value * 1e4) / 1e4);

/** Draws a checker `thickness` cells wide along the inside of `inset`'s edge, redrawn whenever its box or the scaling changes. */
export function ditherEdge(inset: HTMLElement, thickness = 2, color = "var(--inset-edge)") {
    if (inset.querySelector(":scope > .inset-edge")) return;
    const svg = barSvg("inset-edge");
    inset.append(svg);
    watch(svg, () => {
        const outer = inset.getBoundingClientRect();
        if (!outer.width) return;
        // A step of room around the inset, so the snapped SVG still covers it; the cells start inside its real edge.
        const room = step();
        const { left, top } = placement(svg, svg.getBoundingClientRect(), [-room, -room]);
        const { unit } = scale();
        const [x0, y0] = [Math.ceil(-left / unit), Math.ceil(-top / unit)];
        const [x1, y1] = [Math.floor((outer.width - left) / unit), Math.floor((outer.height - top) / unit)];
        const d: string[] = [];
        const run = (row: number, from: number, to: number) => {
            const start = from + ((from + row) % 2);
            if (start < to) d.push(`M${num(start * unit)} ${num((row + 0.5) * unit)}H${num(to * unit)}`);
        };
        for (let row = y0; row < y1; row++) {
            if (row < y0 + thickness || row >= y1 - thickness) run(row, x0, x1);
            else {
                run(row, x0, x0 + thickness);
                run(row, x1 - thickness, x1);
            }
        }
        const [width, height] = [outer.width + 2 * room, outer.height + 2 * room];
        return () => {
            Object.assign(svg.style, {
                left: `${left}px`,
                top: `${top}px`,
                width: `${width}px`,
                height: `${height}px`,
            });
            svg.innerHTML = `<path shape-rendering="crispEdges" style="fill:none;stroke:${color};stroke-width:${num(unit)};stroke-dasharray:${num(unit)} ${num(unit)}" d="${d.join("")}"/>`;
        };
    });
}

/** Sets `path` to the dim dotted leader from the edge of `box` nearest to `point` to `gap` short of it, all in the path's coordinates. */
export function leader(
    path: Element,
    box: { left: number; top: number; right: number; bottom: number },
    point: [number, number],
    gap = 0,
) {
    const [px, py] = point;
    const [sx, sy] = [Math.min(Math.max(px, box.left), box.right), Math.min(Math.max(py, box.top), box.bottom)];
    const length = Math.hypot(px - sx, py - sy);
    if (!(length > gap)) {
        path.setAttribute("d", "");
        return;
    }
    const [ex, ey] = [px - ((px - sx) * gap) / length, py - ((py - sy) * gap) / length];
    path.setAttribute("d", `M${num(sx)} ${num(sy)}L${num(ex)} ${num(ey)}`);
}

for (const inset of document.querySelectorAll<HTMLElement>(".fig-inset")) ditherEdge(inset);
