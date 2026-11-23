// The cost figures' bars for comparison (costs.css), dithered in their part's color on whole device pixels: an SVG over
// each such bar, drawn by dither.ts, redrawn when its bar's width or the scaling changes.
import { barSvg, drawBar, placement, watch, wholeCells } from "./dither";

/** Dithers every bar for comparison under `root` not dithered yet, the legend's swatch among them. */
export function ditherBars(root: ParentNode) {
    for (const bar of root.querySelectorAll<HTMLElement>(".budget-reference:not(:has(> .budget-dither))")) {
        const svg = barSvg("budget-dither");
        bar.append(svg);
        watch(svg, () => {
            const box = svg.getBoundingClientRect();
            if (!box.width || !svg.isConnected) return;
            const { left, top } = placement(svg, box);
            const [width, height] = [wholeCells(box.width), wholeCells(box.height)];
            return () => {
                Object.assign(svg.style, { left: `${left}px`, top: `${top}px` });
                drawBar(svg, { height, stretches: [{ from: 0, to: width, color: "var(--budget-fill)" }] });
            };
        });
    }
}
