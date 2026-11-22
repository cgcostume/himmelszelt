// Every figure's actions, in one group at its top right, always shown: its own buttons first, then the download, an SVG
// of a panel marked `data-export` (export.ts) or a PNG of a stage marked `data-actions="png"`, then Copy
// (figure-info.ts), then full screen where the figure has it. A group already in the figure's markup (`.fig-actions`)
// is filled, otherwise one is made in the host's corner; `data-actions-in` names another place in the figure for it,
// a row of controls above a plot, or the group of another panel. `data-actions="copy"` asks for Copy alone.

import { downloadSvg, standaloneSvg } from "./export";
import { figureInfo } from "./figure-info";
import { drawNow } from "./frame";
import { icon } from "./icons";
import { momentAndPlace, momentStamp } from "./sternzeit/state";

const COPY_TITLE = "Copy this view: a link to it, its caption and every setting it shows, as JSON";
const DOWNLOADS = "[data-field=png], [data-field=download], [data-action=svg], [data-action=png]";
const FULL_SCREEN = "[data-field=fullscreen], [data-env=fullscreen], [data-field=full-screen]";

function button(name: string, title: string, label = title) {
    const element = Object.assign(document.createElement("button"), { type: "button", className: "view-icon", title });
    element.setAttribute("aria-label", label);
    element.innerHTML = icon(name as Parameters<typeof icon>[0]);
    // A drag that starts on a button does not turn the view under it.
    element.addEventListener("pointerdown", (event) => event.stopPropagation());
    return element;
}

/** The host's group: in the place its `data-actions-in` names, the one its markup holds, or one in its corner. */
function groupOf(host: HTMLElement, figure: HTMLElement) {
    const into = host.dataset.actionsIn ? figure.querySelector<HTMLElement>(host.dataset.actionsIn) : null;
    if (into?.matches(".fig-actions")) return into;
    if (into) {
        const group = into.querySelector<HTMLElement>(":scope > .fig-actions");
        if (group) return group;
        const made = Object.assign(document.createElement("span"), {
            className: "view-buttons fig-actions fig-actions-row",
        });
        into.append(made);
        return made;
    }
    const own = [...host.querySelectorAll<HTMLElement>(".fig-actions")].find(
        (group) => group.parentElement?.closest("[data-actions], [data-export]") === host,
    );
    if (own) return own;
    const group = Object.assign(document.createElement("span"), { className: "view-buttons fig-actions" });
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.append(group);
    return group;
}

/** Downloads, then Copy, then full screen, at the group's end, in that order. Two downloads side by side each say
 *  their format in a word, the last of their title, as one icon twice would not tell them apart. */
function order(group: HTMLElement) {
    for (const selector of [DOWNLOADS, "[data-field=copyInfo]", FULL_SCREEN])
        for (const element of group.querySelectorAll<HTMLElement>(`:scope > :is(${selector})`)) group.append(element);
    const downloads = [...group.querySelectorAll<HTMLElement>(`:scope > :is(${DOWNLOADS})`)];
    if (downloads.length < 2) return;
    for (const download of downloads) {
        const format = /\bas (\w+)$/.exec(download.title)?.[1];
        if (!format || !download.classList.contains("view-icon")) continue;
        download.classList.replace("view-icon", "view-toggle");
        download.textContent = format.toLowerCase();
    }
}

const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

/** What a cost figure measured (costs.css): per row, by its group, each column's lines as their titles say them. */
function measured(grid: Element) {
    const rows: Record<string, unknown>[] = [];
    let group: string | undefined;
    let row: Record<string, unknown> | undefined;
    for (const cell of grid.children) {
        if (cell.matches(".budget-head") || text(cell) === "") continue;
        if (cell.matches(".budget-size")) {
            const [name, note] = [...cell.children].map(text);
            row = { ...(group ? { group } : {}), row: name ?? text(cell), ...(note ? { note } : {}) };
            rows.push(row);
        } else if (cell.matches(".budget-cell") && row) {
            const lines = [...cell.querySelectorAll<HTMLElement>(".budget-line")].filter((line) => !line.hidden);
            row[(cell as HTMLElement).dataset.label ?? "value"] = lines.map((line) => line.title || text(line));
        } else group = text(cell);
    }
    return rows;
}

/** The figure's Copy in `group`: moved there if the figure has one elsewhere, made if it has none. */
function copyInto(figure: HTMLElement, group: HTMLElement) {
    let copy = figure.querySelector<HTMLElement>("[data-field=copyInfo]");
    if (!copy) {
        copy = button("copy", COPY_TITLE, "Copy this view");
        copy.classList.add("copy-info");
        copy.dataset.field = "copyInfo";
    }
    if (!copy.closest(".fig-actions")) group.append(copy);
    const grid = figure.querySelector(".budget-grid");
    if (grid) figureInfo(figure, () => ({ measured: measured(grid) }));
    else figureInfo(figure);
}

const shown = (element: Element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0;
};
const CONTROLS = ".view-buttons, button, label, .term-tip, .sky-options, select, figcaption, .view-status";
// The height of the row the moment and place are written in, under a figure that is not a picture of the sky.
const STAMP_ROW = 22;

/** A part's `clip-path: inset(...)` as the lengths cut off its top, right, bottom and left, in CSS pixels. */
function insetOf(part: Element, box: DOMRect) {
    const inset = /inset\(([^)]*?)(?: round [^)]*)?\)/.exec(getComputedStyle(part).clipPath)?.[1];
    if (!inset) return null;
    const values = inset.trim().split(/\s+/);
    const [t = "0", r = t, b = t, l = r] = values;
    const length = (value: string, of: number) =>
        value.endsWith("%") ? (Number.parseFloat(value) / 100) * of : Number.parseFloat(value) || 0;
    return [length(t, box.height), length(r, box.width), length(b, box.height), length(l, box.width)] as const;
}

/**
 * Saves what `host` shows as a PNG, at its canvases' own resolution: its canvases, images and SVGs where they stand,
 * over the page's ground, and its `data-export-text` labels, signed with the moment and place unless the figure is
 * marked `data-export-timeless`: over a picture of the sky (`.as-seen`) in its corner, under anything else in a row of
 * its own. The figure's WebGPU canvases are drawn again first, in this task: a WebGPU canvas keeps its picture only
 * for the task that drew it.
 */
async function savePng(host: HTMLElement, figure: HTMLElement) {
    const parts = [...host.querySelectorAll<HTMLElement>("canvas, img, svg, [data-export-text]")].filter(
        (part) =>
            !part.closest(CONTROLS) &&
            !(part.tagName.toLowerCase() === "svg" && part.parentElement?.closest("svg")) &&
            shown(part),
    );
    if (parts.length === 0) return;
    const boxes = parts.map((part) => part.getBoundingClientRect());
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const width = Math.max(...boxes.map((box) => box.right)) - left;
    const height = Math.max(...boxes.map((box) => box.bottom)) - top;
    const canvases = parts.filter((part): part is HTMLCanvasElement => part instanceof HTMLCanvasElement);
    const sharpest = Math.max(devicePixelRatio, ...canvases.map((canvas) => canvas.width / (canvas.clientWidth || 1)));
    const scale = Math.min(sharpest, 8192 / width, 8192 / height);
    const timeless = figure.hasAttribute("data-export-timeless") || host.hasAttribute("data-export-timeless");
    const seen = host.matches(".as-seen") || host.querySelector(":scope > .as-seen, :scope > * > .as-seen") !== null;
    const row = timeless || seen ? 0 : STAMP_ROW;
    const out = Object.assign(document.createElement("canvas"), {
        width: Math.round(width * scale),
        height: Math.round((height + row) * scale),
    });
    const context = out.getContext("2d");
    if (!context) return;
    context.fillStyle = getComputedStyle(document.body).backgroundColor;
    context.fillRect(0, 0, out.width, out.height);
    // The SVGs drawn as images first, all of them, then everything in the page's order, so a canvas drawn over an SVG
    // stays over it.
    const images = new Map<Element, HTMLImageElement>();
    await Promise.all(
        parts.map(async (part, i) => {
            if (!(part instanceof SVGSVGElement)) return;
            const box = boxes[i] as DOMRect;
            const image = new Image();
            const url = URL.createObjectURL(
                new Blob([await standaloneSvg(part, box.width, box.height)], { type: "image/svg+xml" }),
            );
            image.src = url;
            await image.decode().catch(() => {});
            URL.revokeObjectURL(url);
            images.set(part, image);
        }),
    );
    drawNow(figure);
    parts.forEach((part, i) => {
        const box = boxes[i] as DOMRect;
        const [x, y, w, h] = [
            (box.left - left) * scale,
            (box.top - top) * scale,
            box.width * scale,
            box.height * scale,
        ];
        if (part instanceof HTMLCanvasElement || part instanceof HTMLImageElement) {
            // A split shows a part only on one side of its line.
            const cut = insetOf(part, box);
            context.save();
            if (cut) {
                const [t, r, b, l] = cut.map((length) => length * scale) as [number, number, number, number];
                context.beginPath();
                context.rect(x + l, y + t, w - l - r, h - t - b);
                context.clip();
            }
            context.drawImage(part, x, y, w, h);
            context.restore();
        } else if (part instanceof SVGSVGElement) {
            const image = images.get(part);
            if (image?.complete && image.naturalWidth > 0) context.drawImage(image, x, y, w, h);
        } else {
            const style = getComputedStyle(part);
            context.font = `${style.fontWeight} ${Number.parseFloat(style.fontSize) * scale}px ${style.fontFamily}`;
            context.fillStyle = style.color;
            context.textAlign = "center";
            context.textBaseline = "middle";
            context.fillText(part.textContent?.trim() ?? "", x + w / 2, y + h / 2);
        }
    });
    if (!timeless) {
        context.font = `${12 * scale}px ${getComputedStyle(figure).fontFamily}`;
        context.textAlign = "left";
        context.textBaseline = "bottom";
        if (seen) {
            // Over the sky, bottom left, as a camera dates a photo.
            Object.assign(context, { fillStyle: "rgb(255 255 255 / 0.85)", shadowColor: "rgb(0 0 0 / 0.8)" });
            context.shadowBlur = 3 * scale;
            context.fillText(momentAndPlace(), 8 * scale, out.height - 6 * scale);
        } else {
            context.fillStyle = getComputedStyle(figure).getPropertyValue("color");
            context.globalAlpha = 0.6;
            context.fillText(momentAndPlace(), 0, out.height - 5 * scale);
        }
    }
    try {
        out.toBlob((blob) => {
            if (!blob) return;
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `himmelszelt-${figure.id || "figure"}${timeless ? "" : `-${momentStamp()}`}.png`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }, "image/png");
    } catch {
        host.querySelector<HTMLElement>("[data-action=png]")?.setAttribute("title", "This figure cannot be saved here");
    }
}

/** The SVG download of a panel marked `data-export`; Copy beside it on the figure's first such panel. */
function svgActions(panel: HTMLElement) {
    if (panel.querySelector(":scope > .fig-actions [data-action=svg]")) return;
    const figure = panel.closest<HTMLElement>("figure:not(figure figure)") ?? panel;
    // In a row of the figure's own, a small button there (the calendar's head); otherwise the group in the corner.
    const row = panel.dataset.downloadIn ? panel.querySelector<HTMLElement>(panel.dataset.downloadIn) : null;
    // In another panel's group, named: that group has a download of its own.
    const name = panel.dataset.actionsIn ? `the ${panel.dataset.export?.replaceAll("-", " ")}` : "this panel";
    const download = button("download", `Download ${name} as SVG`);
    download.dataset.action = "svg";
    download.addEventListener("click", (event) => {
        event.stopPropagation();
        downloadSvg(panel);
    });
    const first = figure.querySelector("[data-export]") === panel || figure === panel;
    const nested = Boolean(panel.parentElement?.closest("[data-export]"));
    if (row) {
        download.className = "view-toggle button-square";
        row.append(download);
        const copy = figure.querySelector<HTMLElement>("[data-field=copyInfo]");
        if (first && !copy) {
            const made = button("copy", COPY_TITLE, "Copy this view");
            made.className = "view-toggle button-square copy-info";
            made.dataset.field = "copyInfo";
            row.append(made);
        }
        if (first) figureInfo(figure);
        return;
    }
    const group = groupOf(panel, figure);
    // A panel inside another figure panel (the locked views, the analemma) shows its download on hover only.
    if (nested) group.classList.add("fig-actions-nested");
    group.append(download);
    if (first) copyInto(figure, group);
    order(group);
}

function pngActions(host: HTMLElement, actions: string[]) {
    const figure = host.closest<HTMLElement>("figure:not(figure figure)") ?? host;
    const group = groupOf(host, figure);
    if (actions.includes("png") && !host.querySelector("[data-field=png], [data-field=download], [data-action=png]")) {
        const download = button("download", "Download the view as PNG");
        download.dataset.action = "png";
        download.addEventListener("click", (event) => {
            event.stopPropagation();
            savePng(host, figure);
        });
        group.append(download);
    }
    if (actions.includes("copy")) copyInto(figure, group);
    order(group);
}

for (const host of document.querySelectorAll<HTMLElement>("[data-actions]"))
    pngActions(host, (host.dataset.actions ?? "").split(/\s+/));
for (const panel of document.querySelectorAll<HTMLElement>("[data-export]")) svgActions(panel);
