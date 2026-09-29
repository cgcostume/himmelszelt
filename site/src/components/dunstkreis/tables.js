import { clampObserverHeight, DEFAULT_TEXTURE_CONFIG, readTexture } from "@himmelszelt/dunstkreis";
import { showCode } from "../code.js";
import { paintRange } from "../range.js";
import { state } from "../sternzeit/state.js";
import { bindRefractionToggle, gpu, onSkyView, onTables, quality, recompute, tables } from "./atmosphere.js";
import { formatBytes, saveHdr, savePng } from "./download.js";
import { createPreview, renderPixels, SCALE, texelOf } from "./preview.js";

const root = document.querySelector("#tables");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const lut = (name) => root.querySelector(`[data-lut="${name}"]`);

const luminance = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

// Each table by its own scale: transmittance as it is, multiple scattering by its maximum, the sky view tone mapped
// around its geometric mean, since it spans from night to the sun's glow.
const SCALES = { transmittance: SCALE.none, multiScattering: SCALE.max, skyView: SCALE.mean };

const DEG = 180 / Math.PI;
const shown = {};
const previews = {};
// How each table is shown: texel by texel, or interpolated between texel centers as the shaders sample it.
const filters = { transmittance: "nearest", multiScattering: "nearest", skyView: "nearest" };
// Altitude up, like a plot; the sky view as seen, the zenith at the top.
const flipped = (name) => name !== "skyView";
const part = (name, field) => lut(name).querySelector(`[data-field="${field}"]`);

const modelLine = () =>
    quality.refraction
        ? "const model = DEFAULT_ATMOSPHERE_MODEL;"
        : "const model = { ...DEFAULT_ATMOSPHERE_MODEL, refractivity: 0 }; // straight rays";
const configLines = (name, { width, height }) => [
    "const config = structuredClone(DEFAULT_TEXTURE_CONFIG);",
    `config.${name} = { width: ${width}, height: ${height} };`,
    `config.integralSamples.${name} = ${quality.config.integralSamples[name]};`,
];
const fixed3 = (v) => Number(v.toFixed(3));
let lastSky = null;

// The calls that compute each table as it is shown, with the settings it was computed with.
const CALLS = {
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
        'const sky = createSkyPass(device, { luts, format: "rgba8unorm" });',
        "// Rebuilds the table only when the sun or the observer moved.",
        `sky.update({ sunDirection: [${(lastSky?.sunDirection ?? [0, 0, 1]).map(fixed3).join(", ")}], observerHeightM: ${fixed3(clampObserverHeight(state.heightM))} });`,
        "sky.skyViewTexture;",
    ],
};

function show(name, texture) {
    showCode(part(name, "call"), CALLS[name](texture).join("\n"));
    const { width, height } = texture;
    const model = tables().luts.model;
    const heightKm = clampObserverHeight(state.heightM) / 1000;
    // Read back only when pointed at, for the readouts.
    shown[name] = { texture, width, height, data: null, model, heightKm };
    part(name, "image").parentElement.style.aspectRatio = `${width} / ${height}`;
    part(name, "info").textContent = `${texture.format}, ${formatBytes(width * height * 8)}`;
    paint(name);
}

/** Which texel each device pixel shows, as the preview picks it, and where each texel starts. */
function cells(n, pixels) {
    const texel = Int32Array.from({ length: pixels }, (_, p) => texelOf(p, n, pixels));
    const start = new Array(n + 1).fill(pixels);
    for (let p = pixels - 1; p >= 0; --p) start[texel[p]] = p;
    // A texel no pixel shows, when there are more texels than pixels, starts where the next one does.
    for (let i = n - 1; i >= 0; --i) start[i] = Math.min(start[i], start[i + 1]);
    return { start, texel };
}

// Drawn on the GPU in device pixels; the highlight and the pointer go through the same texel mapping.
function paint(name) {
    const table = shown[name];
    if (!table) return;
    const image = part(name, "image");
    previews[name] ??= createPreview(image);
    previews[name].draw(table.texture, previewOptions(name));
    // The settings folded into one line: what the table is computed with, then how it is shown.
    const samples = quality.config.integralSamples[name];
    part(name, "summary").textContent =
        `${table.width}×${table.height}, ${samples} samples, ${quality.refraction ? "refracted" : "straight"}, ` +
        `${filters[name]}`;
    const overlay = part(name, "overlay");
    Object.assign(overlay, { width: image.width, height: image.height });
    table.columns = cells(table.width, image.width);
    table.rows = cells(table.height, image.height);
    if (table.hover) highlight(name, table.hover);
}

// The tables' mappings inverted, in double precision: what a texel stands for. Twins of lut.wgsl's.
function geometry(model) {
    const Rg = model.planet.groundRadiusKm;
    const Rt = Rg + model.planet.thicknessKm;
    const HR = model.rayleigh.scaleHeightKm;
    const n = (h) => 1 + model.refractivity * Math.exp(-h / HR);
    const toTop = (r, mu) => -r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + Rt * Rt, 0));
    return {
        Rg,
        Rt,
        top: Rt - Rg,
        toTop,
        horizonMu(h) {
            const nr = n(h) * (Rg + h);
            const n0 = n(0) * Rg;
            return -Math.sqrt(Math.max(nr * nr - n0 * n0, 0)) / nr;
        },
        muMin(r) {
            const m = 1.1 * model.refractivity * Math.sqrt((2 * Math.PI * Rg) / HR);
            const rho = Math.sqrt(r * r - Rg * Rg);
            return (-rho / r) * Math.cos(m) - (Rg / r) * Math.sin(m);
        },
    };
}

const unit = (i, n) => (n > 1 ? i / (n - 1) : 0);
const fixed = (v, digits) => v.toFixed(digits);
const rgb = (d, i, digits) => `${fixed(d[i], digits)} ${fixed(d[i + 1], digits)} ${fixed(d[i + 2], digits)}`;
const exp = (v) => v.toExponential(2);

// What a texel stands for: short values for the two axes, and the lines of the tooltip.
const READOUTS = {
    transmittance({ width, height, data, model }, x, y, i) {
        const g = geometry(model);
        const H = Math.sqrt(g.Rt * g.Rt - g.Rg * g.Rg);
        const rho = H * unit(y, height);
        const r = Math.sqrt(rho * rho + g.Rg * g.Rg);
        const dMin = g.Rt - r;
        const d = dMin + unit(x, width) * (g.toTop(r, g.muMin(r)) - dMin);
        const mu = d > 0 ? Math.min(Math.max((H * H - rho * rho - d * d) / (2 * r * d), -1), 1) : 1;
        const angle = Math.asin(mu) * DEG;
        return {
            x: `${fixed(angle, 2)}°`,
            y: `${fixed(r - g.Rg, 2)} km`,
            lines: [
                `altitude ${fixed(r - g.Rg, 3)} km`,
                `light from ${fixed(angle, 3)}° above the horizontal, μ ${fixed(mu, 5)}`,
                `${fixed(d, 1)} km to the top`,
                `transmittance ${rgb(data, i, 4)}`,
            ],
        };
    },
    multiScattering({ width, height, data, model }, x, y, i) {
        const g = geometry(model);
        const muS = unit(x, width) * 2 - 1;
        const altitude = unit(y, height) * g.top;
        return {
            x: `${fixed(Math.asin(muS) * DEG, 1)}°`,
            y: `${fixed(altitude, 1)} km`,
            lines: [
                `altitude ${fixed(altitude, 2)} km`,
                `sun ${fixed(Math.asin(muS) * DEG, 2)}° high, μs ${fixed(muS, 4)}`,
                `per unit of sunlight and scattering ${rgb(data, i, 4)}`,
            ],
        };
    },
    skyView({ width, height, data, model, heightKm }, x, y, i) {
        const g = geometry(model);
        const h = Math.min(Math.max(heightKm, 1e-6), g.top);
        const zenithHorizon = Math.acos(g.horizonMu(h));
        const v = unit(y, height);
        const t = v < 0.5 ? 1 - v * 2 : v * 2 - 1;
        const below = v < 0.5 ? -zenithHorizon * t * t : (Math.PI - zenithHorizon) * t * t;
        const s = unit(x, width);
        const azimuth = Math.acos(Math.min(Math.max(1 - 2 * s * s, -1), 1)) * DEG;
        const bend = Math.asin(Math.min(Math.max(data[i + 3], -1), 1)) * DEG * 60;
        return {
            x: `${fixed(azimuth, 1)}°`,
            y: `${fixed(-below * DEG, 2)}°`,
            lines: [
                `azimuth ${fixed(azimuth, 2)}° from the sun`,
                `${fixed(90 - (zenithHorizon + below) * DEG, 3)}° above the horizontal`,
                `${fixed(-below * DEG, 3)}° above the visible horizon, seen from ${fixed(h, 3)} km`,
                `luminance ${exp(luminance(data, i))} cd/m²`,
                `rgb ${exp(data[i])} ${exp(data[i + 1])} ${exp(data[i + 2])}`,
                `bent by ${fixed(bend, 2)}′`,
            ],
        };
    },
};

// The hovered texel's row and column lit faintly, the texel itself outlined.
function highlight(name, { column, row }) {
    const table = shown[name];
    const overlay = part(name, "overlay");
    const context = overlay.getContext("2d");
    context.clearRect(0, 0, overlay.width, overlay.height);
    const [x0, x1] = [table.columns.start[column], table.columns.start[column + 1]];
    const [y0, y1] = [table.rows.start[row], table.rows.start[row + 1]];
    context.fillStyle = "rgba(255, 255, 255, 0.14)";
    context.fillRect(x0, 0, x1 - x0, overlay.height);
    context.fillRect(0, y0, overlay.width, y1 - y0);
    context.strokeStyle = getComputedStyle(root).getPropertyValue("--accent");
    context.lineWidth = Math.max(1, window.devicePixelRatio || 1);
    context.strokeRect(x0 - 0.5, y0 - 0.5, x1 - x0 + 1, y1 - y0 + 1);
}

// Marks on the axes where the texel sits, with its values, like the axes' own end labels.
function mark(name, axis, fraction, text) {
    const bar = lut(name).querySelector(`.lut-${axis}`);
    let marker = bar.querySelector(".lut-mark");
    if (!marker) marker = bar.appendChild(Object.assign(document.createElement("span"), { className: "lut-mark" }));
    marker.hidden = text === null;
    marker.textContent = text ?? "";
    // The y axis is turned upside down to read bottom up, so its start is at the bottom.
    marker.style.insetInlineStart = `${(axis === "y" ? 1 - fraction : fraction) * 100}%`;
}

function hover(name, event) {
    const table = shown[name];
    if (!table?.columns) return;
    if (!table.data) {
        // The texels, read back once per table, then the readout for wherever the pointer is by then.
        table.pointer = event;
        table.reading ??= readTexture(gpu.device, table.texture).then(({ data }) => {
            table.data = data;
            if (shown[name] === table && table.pointer) hover(name, table.pointer);
        });
        return;
    }
    const image = part(name, "image");
    const rect = image.getBoundingClientRect();
    const px = Math.floor(((event.clientX - rect.left) / rect.width) * image.width);
    const py = Math.floor(((event.clientY - rect.top) / rect.height) * image.height);
    const column = table.columns.texel[Math.min(Math.max(px, 0), image.width - 1)];
    const row = table.rows.texel[Math.min(Math.max(py, 0), image.height - 1)];
    table.hover = { column, row };
    highlight(name, table.hover);

    const x = column;
    const y = flipped(name) ? table.height - 1 - row : row;
    const readout = READOUTS[name](table, x, y, (y * table.width + x) * 4);
    const center = (start, i, n) => (start[i] + start[i + 1]) / 2 / start[n];
    mark(name, "x", center(table.columns.start, column, table.width), readout.x);
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

const previewOptions = (name) => ({
    filter: filters[name],
    scale: SCALES[name],
    flip: flipped(name),
    split: name === "skyView",
});

// A texel a pixel, the rows as shown: tone mapped for PNG, the values themselves for HDR.
async function download(name, format) {
    const table = shown[name];
    if (!table) return;
    const { texture, width, height } = table;
    const pixels = await renderPixels(
        texture,
        { ...previewOptions(name), filter: "nearest" },
        width,
        height,
        format === "hdr",
    );
    const file = `himmelszelt-dunstkreis-${name}-${width}x${height}`;
    if (format === "hdr") saveHdr(pixels, width, height, file);
    else savePng(pixels, width, height, file);
}

function leave(name) {
    const table = shown[name];
    if (table) Object.assign(table, { hover: null, pointer: null });
    const overlay = part(name, "overlay");
    overlay.getContext("2d").clearRect(0, 0, overlay.width, overlay.height);
    part(name, "tip").hidden = true;
    mark(name, "x", 0, null);
    mark(name, "y", 0, null);
}

const path = (key) => key.split(".");
const read = (key) => path(key).reduce((object, part) => object[part], quality.config);
function write(key, value) {
    const parts = path(key);
    const last = parts.pop();
    parts.reduce((object, part) => object[part], quality.config)[last] = value;
}

function showControls() {
    for (const radio of root.querySelectorAll("[data-preset]")) {
        radio.checked = Number(radio.value) === read(radio.dataset.preset);
    }
    for (const input of root.querySelectorAll("[data-config]")) {
        input.value = String(read(input.dataset.config));
        if (input.type === "range") paintRange(input);
        const output = input.parentElement.querySelector("output");
        if (output) output.textContent = input.value;
    }
}

if (gpu.error) {
    root.querySelector(".lut-bar").insertAdjacentHTML("afterend", `<p class="note">${gpu.error}</p>`);
} else {
    showControls();
    onTables(({ luts, precomputeMs }) => {
        showControls();
        field("timing").textContent = `transmittance and multiple scattering computed in ${precomputeMs.toFixed(1)} ms`;
        show("transmittance", luts.transmittance);
        show("multiScattering", luts.multiScattering);
    });
    onSkyView((sky) => {
        lastSky = sky;
        show("skyView", sky.pass.skyViewTexture);
    });
    const { luts } = tables();
    show("transmittance", luts.transmittance);
    show("multiScattering", luts.multiScattering);

    for (const input of root.querySelectorAll("[data-config]")) {
        const output = input.parentElement.querySelector("output");
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
    for (const radio of root.querySelectorAll("[data-preset]")) {
        radio.addEventListener("change", () => {
            const input = root.querySelector(`input[type="number"][data-config="${radio.dataset.preset}"]`);
            input.value = radio.value;
            input.dispatchEvent(new Event("change"));
        });
    }
    for (const button of root.querySelectorAll("[data-refraction]")) bindRefractionToggle(button);
    for (const name of Object.keys(READOUTS)) {
        const image = part(name, "image");
        image.addEventListener("pointermove", (event) => hover(name, event));
        image.addEventListener("pointerleave", () => leave(name));
        new ResizeObserver(() => paint(name)).observe(image);
    }
    for (const radio of root.querySelectorAll("[data-filter]")) {
        radio.checked = radio.value === filters[radio.dataset.filter];
        radio.addEventListener("change", () => {
            filters[radio.dataset.filter] = radio.value;
            paint(radio.dataset.filter);
        });
    }
    for (const button of root.querySelectorAll("[data-download]")) {
        button.addEventListener("click", () => download(button.dataset.panelName, button.dataset.download));
    }
    field("reset").addEventListener("click", () => {
        quality.config = structuredClone(DEFAULT_TEXTURE_CONFIG);
        recompute();
    });
}
