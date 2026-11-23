/**
 * Dithered bars, drawn as inline SVG: a checker of cells that are whole device pixels at any scaling (one at 100% and
 * 200%, two at 150%), in a box placed on a pixel whole in CSS and device pixels alike, so that no cell falls between
 * two of them. Colors are CSS variables, so a theme or a hover changes them without a redraw; a bar is redrawn only
 * when the scaling changes, the window, the page or its own box is resized, or its owner asks.
 */

/** The device pixels to a CSS pixel, the device pixels to a cell, and a cell in CSS pixels. */
export function scale() {
    const ratio = devicePixelRatio || 1;
    const cell = Math.max(1, Math.round(ratio));
    return { ratio, cell, unit: cell / ratio };
}

/** A length in CSS pixels to the nearest whole number of cells, one at least: 4 px are three cells at 150%. */
export function wholeCells(px: number) {
    const { ratio, cell, unit } = scale();
    return Math.max(1, Math.round((px * ratio) / cell)) * unit;
}

/** A length in CSS pixels to whole device pixels, one at least. */
export function wholeDevice(px: number) {
    const { ratio } = scale();
    return Math.max(1, Math.round(px * ratio)) / ratio;
}

// Layout keeps places in 64ths of a CSS pixel, so only a place whole in CSS pixels is exact on the device too: every
// second one at 150%, every fourth at 125% and 175%.
export function step() {
    const { ratio } = scale();
    return [0.5, 1, 2, 4, 8].find((size) => Number.isInteger(size * ratio)) ?? 1;
}

/**
 * Where an element goes to lie on the nearest such pixel, as the left and top to give it, from its box as measured
 * now: positioned relatively, or absolutely with `at` as the place in its containing block it should have (CSS
 * pixels). Measured in the window, where a sticky element stays put, and the page scrolls by whole device pixels. Not
 * a translate: Chrome snaps a replaced element's box to device pixels, then moves it by the translate, off them again.
 */
export function placement(element: SVGElement | HTMLElement, box: DOMRect, at: [number, number] = [0, 0]) {
    const size = step();
    const [left, top] = [Number.parseFloat(element.style.left) || 0, Number.parseFloat(element.style.top) || 0];
    const snap = (now: number, was: number, wanted: number) => {
        const there = now - was + wanted;
        return wanted + Math.round(there / size) * size - there;
    };
    return { left: snap(box.left, left, at[0]), top: snap(box.top, top, at[1]) };
}

/** A stretch of a bar: a checker of `color` from `from` to `to`, CSS pixels from the bar's left. */
export interface Stretch {
    from: number;
    to: number;
    color: string;
}

/** A solid box, as a cursor or a cap: its left, top, width and height in CSS pixels in the SVG, its color. */
export interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    className?: string;
}

const NS = "http://www.w3.org/2000/svg";
const num = (value: number) => String(Math.round(value * 1e4) / 1e4);

/**
 * Draws a bar into `svg`: its stretches as checkers `height` high from `top`, `dots`, each a dotted line of cells as
 * [from, to, y, color], and `boxes` over them. The SVG keeps the size its CSS gives it. Dashed lines, not a pattern:
 * Chrome draws a pattern's tile half a device pixel off at some places on the page.
 */
export interface Bar {
    top?: number;
    height: number;
    stretches: readonly Stretch[];
    boxes?: readonly Box[];
    dots?: readonly (readonly [number, number, number, string])[];
}
export function drawBar(svg: SVGSVGElement, { top = 0, height, stretches, boxes = [], dots = [] }: Bar) {
    const { unit } = scale();
    // Each row of a stretch one line, dashed a cell on and a cell off from its first cell, which every line starts on.
    const lines = new Map<string, string[]>();
    const add = (color: string, column: number, end: number, y: number) => {
        if (column >= end) return;
        const list = lines.get(color) ?? [];
        lines.set(color, list);
        list.push(`M${num(column * unit)} ${num(y + unit / 2)}H${num(end * unit)}`);
    };
    // Cells counted from the bar's left and top, so the checker is the same wherever a stretch begins.
    const rows = Math.round(height / unit);
    for (const { from, to, color } of stretches) {
        const [first, last] = [Math.round(from / unit), Math.round(to / unit)];
        for (let row = 0; row < rows; row++) add(color, first + ((first + row) % 2), last, top + row * unit);
    }
    for (const [from, to, y, color] of dots) add(color, Math.round(from / unit), Math.round(to / unit), y);
    const dash = num(unit);
    const paths = [...lines]
        .map(
            ([color, list]) =>
                `<path style="fill:none;stroke:${color};stroke-width:${dash};stroke-dasharray:${dash} ${dash}" d="${list.join("")}"/>`,
        )
        .join("");
    const solid = boxes
        .map(
            (b) =>
                `<rect${b.className ? ` class="${b.className}"` : ""} x="${num(b.x)}" y="${num(b.y)}" width="${num(b.width)}" height="${num(b.height)}" style="fill:${b.color}"/>`,
        )
        .join("");
    svg.innerHTML = `<g shape-rendering="crispEdges">${paths}${solid}</g>`;
}

/** Makes an empty SVG for a bar, hidden from assistive technology. */
export function barSvg(className: string) {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    return svg;
}

/** What redraws a bar: it measures, then returns what writes, so that many bars are measured before any is changed. */
export type Redraw = () => (() => void) | undefined;

// Everything drawn here, redrawn when the scaling changes or the window is resized, once a frame at most.
const redraws = new Map<Element, Redraw>();
const run = (elements: Iterable<Element>) => {
    const writes = [];
    for (const element of elements) writes.push(redraws.get(element)?.());
    for (const write of writes) write?.();
};
let pending = false;
function redrawAll() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
        pending = false;
        for (const element of redraws.keys()) if (!element.isConnected) redraws.delete(element);
        run(redraws.keys());
    });
}
const resized = new ResizeObserver((entries) => run(entries.map((entry) => entry.target)));
let watching = false;
function watchScaling() {
    if (watching) return;
    watching = true;
    const arm = () =>
        matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
            "change",
            () => {
                arm();
                redrawAll();
            },
            { once: true },
        );
    arm();
    addEventListener("resize", redrawAll);
    // What grows or shrinks above a bar moves it, by a fraction of a pixel or out from under a containing block's place.
    new ResizeObserver(redrawAll).observe(document.body);
    document.fonts?.ready.then(redrawAll);
}

/** Redraws `element`'s bar whenever its box, the window or the scaling changes, first once it is laid out. */
export function watch(element: Element, redraw: Redraw) {
    watchScaling();
    redraws.set(element, redraw);
    resized.observe(element);
}

/** Redraws now, as after a change only its owner knows of. */
export function redrawNow(element: Element) {
    redraws.get(element)?.()?.();
}

/**
 * A plain bar of `height` CSS pixels in `svg`, as the rail's reading progress or a download's: a dense checker of
 * `fill` up to its share, a sparse one of `rest` after. Returns the function that sets the share, 0 to 1.
 */
export function progressBar(svg: SVGSVGElement, height: number, fill = "var(--text)", rest = "var(--line)") {
    let share = 0;
    svg.style.position = "relative";
    const draw: Redraw = () => {
        const box = svg.getBoundingClientRect();
        if (!box.width) return;
        const tall = wholeCells(height);
        const { left, top } = placement(svg, box);
        const pair = 2 * scale().unit;
        const width = Math.floor(box.width / pair) * pair;
        const at = Math.round((share * width) / pair) * pair;
        return () => {
            Object.assign(svg.style, { height: `${tall}px`, left: `${left}px`, top: `${top}px` });
            drawBar(svg, {
                height: tall,
                stretches: [
                    { from: 0, to: at, color: fill },
                    { from: at, to: width, color: rest },
                ],
            });
        };
    };
    watch(svg, draw);
    return (value: number) => {
        const next = Math.min(1, Math.max(0, value));
        if (next === share) return;
        share = next;
        redrawNow(svg);
    };
}
