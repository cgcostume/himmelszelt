import { save } from "../dunstkreis/download";
import { momentAndPlace, momentStamp } from "../sternzeit/state";

// What the stylesheet gives a diagram's parts, written onto them, so a copy draws the same anywhere.
const STYLED = [
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "stroke-linejoin",
    "stroke-linecap",
    "opacity",
    "font-family",
    "font-size",
    "font-weight",
    "text-anchor",
    "dominant-baseline",
];

/** An SVG of the page as a standalone document, the colors and type as the page shows them: to draw it into an image. */
export function standaloneSvg(svg: SVGSVGElement, width: number, height: number) {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const sources = svg.querySelectorAll("*");
    copy.querySelectorAll("*").forEach((element, k) => {
        const style = getComputedStyle(sources[k] as Element);
        for (const name of STYLED) element.setAttribute(name, style.getPropertyValue(name));
        element.removeAttribute("class");
    });
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(width));
    copy.setAttribute("height", String(height));
    return new XMLSerializer().serializeToString(copy);
}

/**
 * Saves a figure of tiles as PNG: its WebGPU `canvas` as `render` draws it, at the canvas' own resolution, and around it
 * the page's `svgs` and `texts` where they stand, over the page's ground, the moment and the place in the top left
 * corner, `grounds` filled with their own background first, a panel wider than its canvas. `render` has to draw the
 * canvas before it returns: a WebGPU canvas keeps its picture only for that task.
 */
export async function saveFigure(
    root: HTMLElement,
    canvas: HTMLCanvasElement,
    render: () => void,
    {
        grounds = [],
        svgs = [],
        texts = [],
    }: { grounds?: Iterable<HTMLElement>; svgs?: Iterable<SVGSVGElement>; texts?: Iterable<HTMLElement> } = {},
) {
    render();
    const scale = canvas.width / (canvas.clientWidth || 1);
    const frame = canvas.getBoundingClientRect();
    // Shown, by their boxes: an inline element's clientWidth is 0.
    const shown = <T extends Element>(elements: Iterable<T>) =>
        [...elements].filter((element) => element.getBoundingClientRect().width > 0);
    const panels = shown(grounds);
    const parts = shown(svgs);
    const labels = shown(texts);
    const boxes = [frame, ...[...panels, ...parts, ...labels].map((element) => element.getBoundingClientRect())];
    const left = Math.min(...boxes.map((box) => box.left));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const copy = Object.assign(document.createElement("canvas"), {
        width: Math.round((right - left) * scale),
        height: Math.round((bottom - frame.top + 8) * scale),
    });
    const context = copy.getContext("2d");
    if (!context) return;
    const at = (box: DOMRect) => [(box.left - left) * scale, (box.top - frame.top) * scale] as const;
    context.fillStyle = getComputedStyle(document.body).backgroundColor;
    context.fillRect(0, 0, copy.width, copy.height);
    for (const ground of panels) {
        const box = ground.getBoundingClientRect();
        context.fillStyle = getComputedStyle(ground).backgroundColor;
        context.fillRect(...at(box), box.width * scale, box.height * scale);
    }
    context.drawImage(canvas, ...at(frame));
    await Promise.all(
        parts.map(async (svg) => {
            const box = svg.getBoundingClientRect();
            const image = new Image();
            image.src = URL.createObjectURL(
                new Blob([standaloneSvg(svg, box.width, box.height)], { type: "image/svg+xml" }),
            );
            await image.decode();
            context.drawImage(image, ...at(box), box.width * scale, box.height * scale);
            URL.revokeObjectURL(image.src);
        }),
    );
    context.textAlign = "center";
    context.textBaseline = "middle";
    for (const text of labels) {
        const style = getComputedStyle(text);
        const box = text.getBoundingClientRect();
        const [x, y] = at(box);
        context.font = `${style.fontWeight} ${Number.parseFloat(style.fontSize) * scale}px ${style.fontFamily}`;
        context.fillStyle = style.color;
        context.fillText(text.textContent?.trim() ?? "", x + (box.width * scale) / 2, y + (box.height * scale) / 2);
    }
    context.font = `${12 * scale}px ${getComputedStyle(root).fontFamily}`;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillStyle = "rgb(255 255 255 / 0.85)";
    context.fillText(momentAndPlace(), 8 * scale, 6 * scale);
    copy.toBlob((blob) => save(blob, `himmelszelt-${root.id}-${momentStamp()}.png`), "image/png");
}
