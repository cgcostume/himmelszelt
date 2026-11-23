import { barSvg, drawBar, placement, redrawNow, scale, watch } from "./dither";

// Every switch in a figure's options listing gets its square drawn as an SVG of 8 px, placed on whole device pixels and
// edged by one cell of the dither (see dither.ts), so that its edge is equal on every side at any scaling.
const SWITCHES = ".sky-options .view-toggle[aria-pressed]";
// Placed anew whenever one comes into view, as what is laid out above it may have moved it by a fraction of a pixel.
const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) redrawNow(entry.target);
});

const SIZE = 8;

function square(toggle: Element) {
    if (toggle.querySelector(":scope > .switch-square")) return;
    const svg = barSvg("switch-square");
    toggle.append(svg);
    watch(svg, () => {
        const measured = svg.getBoundingClientRect();
        if (!measured.width) return;
        const { left, top } = placement(svg, measured);
        const { unit } = scale();
        const edge = (x: number, y: number, width: number, height: number) => ({
            ...{ x, y, width, height },
            color: "var(--switch-edge)",
        });
        const inner = SIZE - 2 * unit;
        return () => {
            Object.assign(svg.style, { left: `${left}px`, top: `${top}px` });
            drawBar(svg, {
                height: 0,
                stretches: [],
                boxes: [
                    { x: unit, y: unit, width: inner, height: inner, color: "var(--switch-fill)" },
                    edge(0, 0, SIZE, unit),
                    edge(0, SIZE - unit, SIZE, unit),
                    edge(0, unit, unit, inner),
                    edge(SIZE - unit, unit, unit, inner),
                ],
            });
        };
    });
    seen.observe(svg);
}

for (const toggle of document.querySelectorAll(SWITCHES)) square(toggle);
new MutationObserver((records) => {
    for (const record of records)
        for (const node of record.addedNodes)
            if (node instanceof Element)
                for (const toggle of [node, ...node.querySelectorAll(SWITCHES)])
                    if (toggle.matches(SWITCHES)) square(toggle);
}).observe(document.body, { childList: true, subtree: true });
