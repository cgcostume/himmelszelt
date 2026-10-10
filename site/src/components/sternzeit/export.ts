// A download button on every figure panel marked `data-export="<name>"`: its SVGs (and HTML labels marked
// `data-export-text`) composed into one standalone SVG file, styles inlined, so it opens anywhere as it looks here.
// Nested panels (the locked views over Figure 1, the analemma over Figure 2) are exported on their own, not twice.

// The properties the figures' CSS and Zdog set; inlined from the computed style, since the file carries no stylesheet.
const PROPERTIES = [
    "display",
    "visibility",
    "opacity",
    "mix-blend-mode",
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin",
    "vector-effect",
    "stop-color",
    "stop-opacity",
    "font-family",
    "font-size",
    "font-weight",
    "text-anchor",
    "dominant-baseline",
];
const SVG_NS = "http://www.w3.org/2000/svg";

const f = (n: number) => String(Number(n.toFixed(2)));
const ownedBy = (root: Element, element: Element) => element.closest("[data-export]") === root;

// Mixed colors (color-mix in the CSS) compute to color(srgb ...), which not every SVG viewer reads; rgb() they all do.
const plainColors = (value: string) =>
    value.replace(
        /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/g,
        (_, r: string, g: string, b: string, a: string | undefined) => {
            const [R, G, B] = [r, g, b].map((c) => Math.round(Math.min(1, Math.max(0, Number(c))) * 255));
            return a === undefined ? `rgb(${R}, ${G}, ${B})` : `rgba(${R}, ${G}, ${B}, ${a})`;
        },
    );

function inlineStyles(original: Element, clone: Element) {
    const originals = [original, ...original.querySelectorAll("*")];
    const clones = [clone, ...clone.querySelectorAll("*")];
    originals.forEach((element, i) => {
        const computed = getComputedStyle(element);
        const target = clones[i];
        if (!target) return;
        target.setAttribute(
            "style",
            PROPERTIES.map((name) => `${name}:${plainColors(computed.getPropertyValue(name))}`).join(";"),
        );
        target.removeAttribute("class");
    });
}

// Images (the corona photograph) as data URLs, so the file stands alone.
async function embedImages(clone: Element) {
    for (const image of clone.querySelectorAll("image")) {
        const href = image.getAttribute("href");
        if (!href || href.startsWith("data:")) continue;
        const blob = await (await fetch(href)).blob();
        const url = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.readAsDataURL(blob);
        });
        image.setAttribute("href", url);
    }
}

// The panel's own background, rounded corners and outline, which the page draws in CSS around the SVG.
function frame(svg: SVGSVGElement, box: Box, index: number) {
    const style = getComputedStyle(svg);
    const border = Number.parseFloat(style.borderTopWidth) || 0;
    const background = style.backgroundColor;
    const opaque = background !== "rgba(0, 0, 0, 0)" && background !== "transparent";
    const rect = (attributes: Record<string, string | number>) => {
        const element = document.createElementNS(SVG_NS, "rect");
        const geometry = { ...box, rx: Number.parseFloat(style.borderTopLeftRadius) || 0 };
        for (const [name, value] of Object.entries({ ...geometry, ...attributes }))
            element.setAttribute(name, String(value));
        return element;
    };
    const clip = document.createElementNS(SVG_NS, "clipPath");
    clip.id = `panel-${index}`;
    clip.append(rect({}));
    const fill = opaque ? rect({ fill: background }) : null;
    const inset = border / 2;
    const outline = border
        ? rect({ x: box.x + inset, y: box.y + inset, width: box.width - border, height: box.height - border })
        : null;
    outline?.setAttribute("fill", "none");
    outline?.setAttribute("stroke", style.borderTopColor);
    outline?.setAttribute("stroke-width", String(border));
    return { clip, fill, outline };
}

type Box = { x: number; y: number; width: number; height: number };

async function compose(root: HTMLElement) {
    const svgs = [...root.querySelectorAll("svg")].filter(
        (svg) => ownedBy(root, svg) && !svg.closest("button") && getComputedStyle(svg).visibility !== "hidden",
    );
    const labels = [...root.querySelectorAll("[data-export-text]")].filter(
        (label) => ownedBy(root, label) && getComputedStyle(label).visibility !== "hidden",
    );
    const rects: DOMRect[] = svgs.map((svg) => svg.getBoundingClientRect());
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const width = Math.max(...rects.map((r) => r.right)) - left;
    const height = Math.max(...rects.map((r) => r.bottom)) - top;

    const out = document.createElementNS(SVG_NS, "svg");
    out.setAttribute("xmlns", SVG_NS);
    out.setAttribute("width", f(width));
    out.setAttribute("height", f(height));
    out.setAttribute("viewBox", `0 0 ${f(width)} ${f(height)}`);
    const page = getComputedStyle(document.body);
    out.setAttribute("style", `font-family:${page.fontFamily};font-weight:${page.fontWeight}`);
    const background = document.createElementNS(SVG_NS, "rect");
    for (const [name, value] of [
        ["width", f(width)],
        ["height", f(height)],
        ["fill", page.backgroundColor],
    ])
        background.setAttribute(name, value);
    out.append(background);

    svgs.forEach((svg, i) => {
        const { left: x, top: y, width, height } = rects[i] as DOMRect;
        const box = { x: x - left, y: y - top, width, height };
        const clone = svg.cloneNode(true) as SVGSVGElement;
        inlineStyles(svg, clone);
        for (const name of ["id", "aria-hidden"]) clone.removeAttribute(name);
        if (!clone.hasAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${f(box.width)} ${f(box.height)}`);
        for (const [name, value] of Object.entries(box)) clone.setAttribute(name, f(value));
        const { clip, fill, outline } = frame(svg, box, i);
        const group = document.createElementNS(SVG_NS, "g");
        group.setAttribute("clip-path", `url(#${clip.id})`);
        group.append(...[fill, clone].filter((node) => node !== null));
        out.append(clip, group, ...[outline].filter((node) => node !== null));
    });

    for (const label of labels) {
        const r = label.getBoundingClientRect();
        const style = getComputedStyle(label);
        const text = document.createElementNS(SVG_NS, "text");
        text.textContent = label.textContent;
        text.setAttribute("x", f(r.left + r.width / 2 - left));
        text.setAttribute("y", f(r.top + r.height / 2 - top));
        text.setAttribute(
            "style",
            `fill:${style.color};font-size:${style.fontSize};text-anchor:middle;dominant-baseline:middle`,
        );
        out.append(text);
    }
    await embedImages(out);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(out)}`;
}

async function download(root: HTMLElement) {
    const blob = new Blob([await compose(root)], { type: "image/svg+xml" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `himmelszelt-${root.dataset.export}.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

for (const root of document.querySelectorAll<HTMLElement>("[data-export]")) {
    if (root.querySelector(":scope > .svg-download")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "svg-download";
    button.title = "Download this panel as SVG";
    button.setAttribute("aria-label", button.title);
    // A tray with an arrow down into it.
    button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v7.5M4.75 6.75 8 10l3.25-3.25M2.5 10v3.5h11V10"/></svg>`;
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        download(root);
    });
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    root.append(button);
}
