import type { AtmosphereModel } from "@himmelszelt/dunstkreis";
import {
    clampObserverHeight,
    DEFAULT_TEXTURE_CONFIG,
    MULTI_SCATTERING_LOG2_OFFSET,
    readTexture,
    refractionAngle,
    spectrumToRgb,
} from "@himmelszelt/dunstkreis";
import { showCode } from "../code";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { state } from "../sternzeit/state";
import {
    bindRefractionToggle,
    gpu,
    gpuDevice,
    onSkyView,
    onTables,
    quality,
    recompute,
    type Sky,
    tables,
} from "./atmosphere";
import { formatBytes, saveHdr, savePng } from "./download";
import { geometry, multiScatteringAt, skyViewAt, type TableName, transmittanceAt } from "./lutmap";
import { pick, type Ray, unpoint } from "./pick";
import { createPreview, type PreviewOptions, renderPixels, TABLE_PREVIEW, texelOf } from "./preview";

const root = find("#tables");
const field = (name: string) => find(`[data-field="${name}"]`, root);
const lut = (name: TableName) => find(`[data-lut="${name}"]`, root);
const NAMES: TableName[] = ["transmittance", "multiScattering", "skyView"];

type Cells = ReturnType<typeof cells>;
/** A table as shown: its texture and size, its texels once read back, and what it was computed with. */
type Shown = {
    texture: GPUTexture;
    width: number;
    height: number;
    data: Float32Array | null;
    model: AtmosphereModel;
    heightKm: number;
    scale: number;
    columns?: Cells;
    rows?: Cells;
    hover?: { column: number; row: number } | null;
    pointer?: MouseEvent | null;
    reading?: Promise<void>;
};
type Readout = { x: string; y: string; lines: string[] };

/** The luminance of a texel's four wavelengths, through the model's matrix to RGB. */
function luminance(model: AtmosphereModel, d: Float32Array, i: number) {
    const [r = 0, g = 0, b = 0] = spectrumToRgb(model).map((row) =>
        row.reduce((sum, m, j) => sum + m * (d[i + j] ?? 0), 0),
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DEG = 180 / Math.PI;
const shown: Partial<Record<TableName, Shown>> = {};
const previews: Partial<Record<TableName, ReturnType<typeof createPreview>>> = {};
// How each table is shown: texel by texel, or interpolated between texel centers as the shaders sample it.
const filters: Record<TableName, "nearest" | "linear"> = {
    transmittance: "nearest",
    multiScattering: "nearest",
    skyView: "nearest",
};
const flipped = (name: TableName) => TABLE_PREVIEW[name].flip;
// The sky view shown twice as wide, its mirror image to the left, as the sky pass reads it for the sun's other side.
const mirrored = (name: TableName) => name === "skyView";
const shownColumns = (name: TableName, width: number) => (mirrored(name) ? 2 * width : width);
const part = <T extends HTMLElement = HTMLElement>(name: TableName, field: string) =>
    find<T>(`[data-field="${field}"]`, lut(name));

const modelLine = () =>
    quality.refraction
        ? "const model = DEFAULT_ATMOSPHERE_MODEL;"
        : "const model = { ...DEFAULT_ATMOSPHERE_MODEL, refractivity: 0 }; // straight rays";
const configLines = (name: TableName, { width, height }: { width: number; height: number }) => [
    "const config = structuredClone(DEFAULT_TEXTURE_CONFIG);",
    `config.${name} = { width: ${width}, height: ${height} };`,
    `config.integralSamples.${name} = ${quality.config.integralSamples[name]};`,
];
const fixed3 = (v: number) => Number(v.toFixed(3));
let lastSky: Sky | null = null;

// The calls that compute each table as it is shown, with the settings it was computed with.
const CALLS: Record<TableName, (size: { width: number; height: number }) => string[]> = {
    transmittance: (size) => [
        modelLine(),
        ...configLines("transmittance", size),
        "const luts = await precomputeAtmosphere(device, { model, config });",
        "luts.transmittance;",
    ],
    multiScattering: (size) => [
        modelLine(),
        ...configLines("multiScattering", size),
        "// Computed with the transmittance, which it reads.",
        "const luts = await precomputeAtmosphere(device, { model, config });",
        "luts.multiScattering;",
    ],
    skyView: (size) => [
        modelLine(),
        ...configLines("skyView", size),
        "const luts = await precomputeAtmosphere(device, { model, config });",
        'const sky = await createSkyPass(device, { luts, format: "rgba8unorm" });',
        "// Rebuilds the table only when the sun or the observer moved.",
        `sky.update({ sunDirection: [${(lastSky?.sunDirection ?? [0, 0, 1]).map(fixed3).join(", ")}], observerHeightM: ${fixed3(clampObserverHeight(state.heightM))} });`,
        "sky.skyViewTexture;",
    ],
};

function show(name: TableName, texture: GPUTexture, scale = 1) {
    const table = tables();
    if (!table) return;
    showCode(part(name, "call"), CALLS[name](texture).join("\n"));
    const { width, height } = texture;
    const { model } = table.luts;
    const heightKm = clampObserverHeight(state.heightM) / 1000;
    // Read back only when pointed at, for the readouts.
    shown[name] = { texture, width, height, data: null, model, heightKm, scale };
    // Framed in the default size's shape whatever the size, so resizing a table does not move the page; its own size
    // on top.
    const shape = DEFAULT_TEXTURE_CONFIG[name];
    const frame = part(name, "image").parentElement;
    if (frame) frame.style.aspectRatio = `${shownColumns(name, shape.width)} / ${shape.height}`;
    part(name, "size").textContent = `${width}×${height}`;
    part(name, "info").textContent = `${texture.format}, ${formatBytes(width * height * 8)}`;
    paint(name);
}

/** Which texel each device pixel shows, as the preview picks it, and where each texel starts. */
function cells(n: number, pixels: number) {
    const texel = Int32Array.from({ length: pixels }, (_, p) => texelOf(p, n, pixels));
    const start: number[] = new Array(n + 1).fill(pixels);
    for (let p = pixels - 1; p >= 0; --p) start[texel[p] ?? 0] = p;
    // A texel no pixel shows, when there are more texels than pixels, starts where the next one does.
    for (let i = n - 1; i >= 0; --i) start[i] = Math.min(start[i] ?? pixels, start[i + 1] ?? pixels);
    return { start, texel };
}

// Drawn on the GPU in device pixels; the highlight and the pointer go through the same texel mapping.
function paint(name: TableName) {
    const table = shown[name];
    if (!table) return;
    const image = part<HTMLCanvasElement>(name, "image");
    const preview = previews[name] ?? createPreview(image);
    previews[name] = preview;
    preview.draw(table.texture, previewOptions(name));
    // The settings folded into one line: what the table is computed with, then how it is shown.
    const samples = quality.config.integralSamples[name];
    part(name, "summary").textContent =
        `${table.width}×${table.height}, ${samples} samples, ${quality.refraction ? "refracted" : "straight"}, ` +
        `${filters[name]}`;
    const overlay = part<HTMLCanvasElement>(name, "overlay");
    Object.assign(overlay, { width: image.width, height: image.height });
    table.columns = cells(shownColumns(name, table.width), image.width);
    table.rows = cells(table.height, image.height);
    drawOverlay(name);
}

const fixed = (v: number, digits: number) => v.toFixed(digits);
const exp = (v: number) => v.toExponential(2);
/** A texel's four wavelengths, labelled by them. */
const spectral = (model: AtmosphereModel, d: Float32Array, i: number, format: (v: number) => string) =>
    `at ${model.wavelengths.join(", ")}\u202fnm: ${[0, 1, 2, 3].map((c) => format(d[i + c] ?? 0)).join(", ")}`;

// What a texel stands for: short values for the two axes, and the lines of the tooltip.
const READOUTS: Record<
    TableName,
    (table: Shown, x: number, y: number, i: number, leftOfSun: boolean, data: Float32Array) => Readout
> = {
    transmittance(table, x, y, i, _, data) {
        const g = geometry(table.model);
        const { r, mu, d } = transmittanceAt(g, table, x, y);
        const angle = Math.asin(mu) * DEG;
        return {
            x: `${fixed(angle, 2)}°`,
            y: `${fixed(r - g.Rg, 2)}\u202fkm`,
            lines: [
                `altitude ${fixed(r - g.Rg, 3)}\u202fkm`,
                `light from ${fixed(angle, 3)}° above the horizontal, μ ${fixed(mu, 5)}`,
                `${fixed(d, 1)}\u202fkm to the top`,
                `transmittance ${spectral(table.model, data, i, (v) => fixed(v, 4))}`,
            ],
        };
    },
    multiScattering(table, x, y, i, _, data) {
        const { altitude, muS } = multiScatteringAt(geometry(table.model), table, x, y);
        return {
            x: `${fixed(Math.asin(muS) * DEG, 1)}°`,
            y: `${fixed(altitude, 1)}\u202fkm`,
            lines: [
                `altitude ${fixed(altitude, 2)}\u202fkm`,
                `sun ${fixed(Math.asin(muS) * DEG, 2)}° high, μs ${fixed(muS, 4)}`,
                `per unit of sunlight and scattering ${spectral(table.model, data, i, exp)}`,
            ],
        };
    },
    skyView(table, x, y, i, leftOfSun, data) {
        const g = geometry(table.model);
        const h = Math.min(Math.max(table.heightKm, 1e-6), g.top);
        const { below, zenithHorizon, ...view } = skyViewAt(g, table, h, x, y);
        // Counterclockwise from the sun, to its left, negative: the mirror image of the same texel.
        const azimuth = (leftOfSun ? -1 : 1) * view.azimuth * DEG;
        const altitude = 90 - (zenithHorizon + below) * DEG;
        const bent = below < 0 ? refractionAngle(table.model, h * 1000, altitude) : null;
        return {
            x: `${fixed(azimuth, 1)}°`,
            y: `${fixed(-below * DEG, 2)}°`,
            lines: [
                `azimuth ${fixed(azimuth, 2)}° from the sun${leftOfSun ? ", the mirror image of its texel" : ""}`,
                `${fixed(90 - (zenithHorizon + below) * DEG, 3)}° above the horizontal`,
                `${fixed(-below * DEG, 3)}° above the visible horizon, seen from ${fixed(h, 3)}\u202fkm`,
                `luminance ${exp(luminance(table.model, data, i))} cd/m²`,
                spectral(table.model, data, i, exp),
                bent === null ? "ends on the ground" : `bent by ${fixed(bent * 60, 2)}′`,
            ],
        };
    },
};

// The hovered texel's row and column lit faintly, the texel itself outlined; mirrored, on both sides of the mirror axis,
// which is drawn dashed.
function drawOverlay(name: TableName) {
    const table = shown[name];
    if (!table?.columns || !table.rows) return;
    const overlay = part<HTMLCanvasElement>(name, "overlay");
    const context = overlay.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, overlay.width, overlay.height);
    const dpr = window.devicePixelRatio || 1;
    context.lineWidth = Math.max(1, dpr);
    const columns = table.columns.start.length - 1;
    if (mirrored(name)) {
        const axis = table.columns.start[columns / 2] ?? 0;
        context.strokeStyle = "rgba(255, 255, 255, 0.5)";
        context.setLineDash([4 * dpr, 4 * dpr]);
        context.beginPath();
        context.moveTo(axis, 0);
        context.lineTo(axis, overlay.height);
        context.stroke();
        context.setLineDash([]);
    }
    if (!table.hover) return;
    const { column, row } = table.hover;
    const [y0 = 0, y1 = 0] = [table.rows.start[row], table.rows.start[row + 1]];
    context.fillStyle = "rgba(255, 255, 255, 0.14)";
    context.fillRect(0, y0, overlay.width, y1 - y0);
    context.strokeStyle = getComputedStyle(root).getPropertyValue("--accent");
    for (const c of mirrored(name) ? [column, columns - 1 - column] : [column]) {
        const [x0 = 0, x1 = 0] = [table.columns.start[c], table.columns.start[c + 1]];
        context.fillRect(x0, 0, x1 - x0, overlay.height);
        context.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
    }
}

// What the texel under the pointer stands for, as a ray to pick: the other tables and figures follow it.
function rayAt(name: TableName, table: Shown, x: number, y: number, leftOfSun: boolean): Ray {
    const g = geometry(table.model);
    if (name === "transmittance") {
        const { r, mu } = transmittanceAt(g, table, x, y);
        return { kind: name, r, mu };
    }
    if (name === "multiScattering") return { kind: name, ...multiScatteringAt(g, table, x, y) };
    const h = Math.min(Math.max(table.heightKm, 1e-6), g.top);
    const { mu, azimuth } = skyViewAt(g, table, h, x, y);
    // The table holds the sun's right side, clockwise from it; its mirror image the left.
    return { kind: "view", mu, azimuth: leftOfSun ? -azimuth : azimuth };
}

// Marks on the axes where the texel sits, with its values, like the axes' own end labels.
function mark(name: TableName, axis: "x" | "y", fraction: number, text: string | null) {
    const bar = find(`.lut-${axis}`, lut(name));
    let marker = bar.querySelector<HTMLElement>(".lut-mark");
    if (!marker) marker = bar.appendChild(Object.assign(document.createElement("span"), { className: "lut-mark" }));
    marker.hidden = text === null;
    marker.textContent = text ?? "";
    // The y axis is turned upside down to read bottom up, so its start is at the bottom.
    marker.style.insetInlineStart = `${(axis === "y" ? 1 - fraction : fraction) * 100}%`;
}

/** The texel under the pointer: its column and row as shown, and its coordinates as stored. */
function texelAt(name: TableName, table: Shown & { columns: Cells; rows: Cells }, event: MouseEvent) {
    const image = part<HTMLCanvasElement>(name, "image");
    const rect = image.getBoundingClientRect();
    const px = Math.floor(((event.clientX - rect.left) / rect.width) * image.width);
    const py = Math.floor(((event.clientY - rect.top) / rect.height) * image.height);
    const column = table.columns.texel[Math.min(Math.max(px, 0), image.width - 1)] ?? 0;
    const row = table.rows.texel[Math.min(Math.max(py, 0), image.height - 1)] ?? 0;
    const leftOfSun = mirrored(name) && column < table.width;
    const x = mirrored(name) ? (leftOfSun ? table.width - 1 - column : column - table.width) : column;
    return { column, row, x, y: flipped(name) ? table.height - 1 - row : row, leftOfSun };
}

/** The table, once its pixels are mapped to texels. */
function mapped(name: TableName) {
    const table = shown[name];
    return table?.columns && table.rows ? (table as Shown & { columns: Cells; rows: Cells }) : null;
}

function hover(name: TableName, event: MouseEvent) {
    const table = mapped(name);
    if (!table) return;
    const { column, row, x, y, leftOfSun } = texelAt(name, table, event);
    table.hover = { column, row };
    drawOverlay(name);
    pick(rayAt(name, table, x, y, leftOfSun));
    const { data } = table;
    if (!data) {
        // The texels, read back once per table, then the readout for wherever the pointer is by then.
        table.pointer = event;
        table.reading ??= readTexture(gpuDevice(), table.texture).then(({ data }) => {
            // The multiple scattering as the values themselves, not their stored log2.
            const log2 = TABLE_PREVIEW[name].log2;
            // All four wavelengths, the sky view in cd/m² rather than times its scale.
            table.data = data.map(log2 ? (v) => 2 ** (v - MULTI_SCATTERING_LOG2_OFFSET) : (v) => v / table.scale);
            if (shown[name] === table && table.pointer) hover(name, table.pointer);
        });
        return;
    }
    const rect = part(name, "image").getBoundingClientRect();
    const readout = READOUTS[name](table, x, y, (y * table.width + x) * 4, leftOfSun, data);
    const center = (start: number[], i: number, n: number) =>
        ((start[i] ?? 0) + (start[i + 1] ?? 0)) / 2 / (start[n] ?? 1);
    mark(name, "x", center(table.columns.start, column, table.columns.start.length - 1), readout.x);
    mark(name, "y", center(table.rows.start, row, table.height), readout.y);

    const tip = part(name, "tip");
    tip.hidden = false;
    tip.textContent = [
        `texel ${x}, ${y} · uv ${fixed((x + 0.5) / table.width, 4)}, ${fixed((y + 0.5) / table.height, 4)}`,
        ...readout.lines,
    ].join("\n");
    // Beside the pointer, on whichever side has the room.
    const [left, top] = [event.clientX - rect.left, event.clientY - rect.top];
    const right = left > rect.width / 2;
    const below = top < rect.height / 2;
    tip.style.left = right ? "" : `${left + 16}px`;
    tip.style.right = right ? `${rect.width - left + 16}px` : "";
    tip.style.top = below ? `${top + 16}px` : "";
    tip.style.bottom = below ? "" : `${rect.height - top + 16}px`;
}

const previewOptions = (name: TableName): PreviewOptions => ({
    ...TABLE_PREVIEW[name],
    filter: filters[name],
    mirror: mirrored(name),
});

// A texel a pixel, the rows as shown: tone mapped for PNG, the values themselves for HDR.
async function download(name: TableName, format: string) {
    const table = shown[name];
    if (!table) return;
    const { texture, width, height } = table;
    const pixels = await renderPixels(
        texture,
        { ...previewOptions(name), filter: "nearest", mirror: false },
        width,
        height,
        format === "hdr",
    );
    const file = `himmelszelt-dunstkreis-${name}-${width}x${height}`;
    if (pixels instanceof Float32Array) saveHdr(pixels, width, height, file);
    else savePng(pixels, width, height, file);
}

function leave(name: TableName) {
    const table = shown[name];
    if (table) Object.assign(table, { hover: null, pointer: null });
    unpoint();
    drawOverlay(name);
    part(name, "tip").hidden = true;
    mark(name, "x", 0, null);
    mark(name, "y", 0, null);
}

// A setting of the tables' configuration by its path, such as "skyView.width".
type Config = Record<string, unknown>;
const read = (key = "") =>
    Number(key.split(".").reduce<unknown>((object, part) => (object as Config)[part], quality.config));
function write(key = "", value: number) {
    const parts = key.split(".");
    const last = parts.pop() ?? "";
    (parts.reduce<unknown>((object, part) => (object as Config)[part], quality.config) as Config)[last] = value;
}

function showControls() {
    for (const radio of root.querySelectorAll<HTMLInputElement>("[data-preset]")) {
        radio.checked = Number(radio.value) === read(radio.dataset.preset);
    }
    for (const input of root.querySelectorAll<HTMLInputElement>("[data-config]")) {
        input.value = String(read(input.dataset.config));
        if (input.type === "range") paintRange(input);
        const output = input.parentElement?.querySelector("output");
        if (output) output.textContent = input.value;
    }
}

if (gpu.error) {
    find(".lut-bar", root).insertAdjacentHTML("afterend", `<p class="note">${gpu.error}</p>`);
} else {
    showControls();
    const showTables = () => {
        const table = tables();
        if (!table) return;
        show("transmittance", table.luts.transmittance);
        show("multiScattering", table.luts.multiScattering);
        return table;
    };
    onTables(() => {
        showControls();
        const table = showTables();
        field("timing").textContent =
            `transmittance and multiple scattering computed in ${table?.precomputeMs.toFixed(1)} ms`;
    });
    // The sky view changes with every moment: shown while its table is on screen.
    const requestSkyView = onDemand(() => {
        if (lastSky) show("skyView", lastSky.pass.skyViewTexture, lastSky.pass.skyViewScale);
    }, lut("skyView"));
    onSkyView((sky) => {
        lastSky = sky;
        requestSkyView();
    });
    showTables();

    for (const input of root.querySelectorAll<HTMLInputElement>("[data-config]")) {
        const output = input.parentElement?.querySelector("output");
        input.addEventListener("input", () => {
            if (output) output.textContent = input.value;
        });
        // Whole texels and samples, held within the input's range: a typed value may lie outside it.
        input.addEventListener("change", () => {
            const value = Math.round(
                Math.min(Math.max(Number(input.value) || 0, Number(input.min)), Number(input.max)),
            );
            input.value = String(value);
            if (input.type === "range") paintRange(input);
            if (value === read(input.dataset.config)) return;
            write(input.dataset.config, value);
            recompute();
        });
    }
    // A preset writes its size into the field beside it, as if typed there.
    for (const radio of root.querySelectorAll<HTMLInputElement>("[data-preset]")) {
        radio.addEventListener("change", () => {
            const input = find<HTMLInputElement>(`input[type="number"][data-config="${radio.dataset.preset}"]`, root);
            input.value = radio.value;
            input.dispatchEvent(new Event("change"));
        });
    }
    for (const button of root.querySelectorAll("[data-refraction]")) bindRefractionToggle(button);
    for (const name of NAMES) {
        const image = part(name, "image");
        image.addEventListener("pointermove", (event) => hover(name, event));
        image.addEventListener("pointerleave", () => leave(name));
        image.addEventListener("click", (event) => {
            const table = mapped(name);
            if (!table) return;
            const { x, y, leftOfSun } = texelAt(name, table, event);
            pick(rayAt(name, table, x, y, leftOfSun), true);
        });
        new ResizeObserver(() => paint(name)).observe(image);
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>("[data-filter]")) {
        const name = radio.dataset.filter as TableName;
        radio.checked = radio.value === filters[name];
        radio.addEventListener("change", () => {
            filters[name] = radio.value as "nearest" | "linear";
            paint(name);
        });
    }
    for (const button of root.querySelectorAll<HTMLElement>("[data-download]")) {
        button.addEventListener("click", () =>
            download(button.dataset.panelName as TableName, button.dataset.download ?? "png"),
        );
    }
    field("reset").addEventListener("click", () => {
        quality.config = structuredClone(DEFAULT_TEXTURE_CONFIG);
        recompute();
    });
}
