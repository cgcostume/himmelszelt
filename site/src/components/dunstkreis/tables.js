import { DEFAULT_TEXTURE_CONFIG, readTexture } from "@himmelszelt/dunstkreis";
import { paintRange } from "../range.js";
import { state } from "../sternzeit/state.js";
import { gpu, onSkyView, onTables, quality, recompute, tables } from "./atmosphere.js";

const root = document.querySelector("#tables");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const lut = (name) => root.querySelector(`[data-lut="${name}"]`);

const srgb = (c) => {
    const v = Math.min(Math.max(c, 0), 1);
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
};
const luminance = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

// Each table by its own scale: transmittance as it is, multiple scattering by its maximum, the sky view tone mapped
// around its geometric mean, since it spans from night to the sun's glow.
const SCALES = {
    transmittance: () => (c) => c,
    multiScattering: (d) => {
        let max = 1e-12;
        for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
        return (c) => c / max;
    },
    skyView: (d) => {
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += Math.log2(Math.max(luminance(d, i), 1e-6));
        const key = 0.18 / 2 ** (sum / (d.length / 4));
        return (c, l) => (c * key) / (1 + l * key);
    },
};

const DEG = 180 / Math.PI;
const shown = {};
// Altitude up, like a plot; the sky view as seen, the zenith at the top.
const flipped = (name) => name !== "skyView";
const part = (name, field) => lut(name).querySelector(`[data-field="${field}"]`);

async function show(name, texture) {
    const model = tables().luts.model;
    const heightKm = state.heightM / 1000;
    const { width, height, data } = await readTexture(gpu.device, texture);
    // Tone mapped once per readback, in display order, four bytes a texel.
    const scale = SCALES[name](data);
    const colors = new Uint8ClampedArray(width * height * 4);
    const flip = flipped(name);
    for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
            const i = (y * width + x) * 4;
            const o = ((flip ? height - 1 - y : y) * width + x) * 4;
            const l = luminance(data, i);
            for (let c = 0; c < 3; ++c) colors[o + c] = srgb(scale(data[i + c], l));
            colors[o + 3] = 255;
        }
    }
    shown[name] = { width, height, data, colors, model, heightKm };
    part(name, "image").parentElement.style.aspectRatio = `${width} / ${Math.max(height, width / 8)}`;
    part(name, "info").textContent =
        `${width}×${height} ${texture.format}, ${((width * height * 8) / 1024).toFixed(0)} KiB`;
    paint(name);
}

/**
 * Which texel each device pixel shows, and where each texel starts: texel i covers the pixels from round(i · P / n) to
 * the next one's start. The image, the highlight and the pointer all go through these, so they never disagree.
 */
function cells(n, pixels) {
    const start = Array.from({ length: n + 1 }, (_, i) => Math.round((i * pixels) / n));
    const texel = new Int32Array(pixels);
    for (let i = 0; i < n; ++i) texel.fill(i, start[i], start[i + 1]);
    return { start, texel };
}

// Drawn in device pixels, texel by texel, rather than scaled by the browser, whose rounding is its own.
function paint(name) {
    const table = shown[name];
    if (!table) return;
    const image = part(name, "image");
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(image.clientWidth * dpr));
    const H = Math.max(1, Math.round(image.clientHeight * dpr));
    table.columns = cells(table.width, W);
    table.rows = cells(table.height, H);
    const pixels = new ImageData(W, H);
    for (let py = 0; py < H; ++py) {
        const row = table.rows.texel[py] * table.width;
        for (let px = 0; px < W; ++px) {
            const i = (row + table.columns.texel[px]) * 4;
            const o = (py * W + px) * 4;
            pixels.data.set(table.colors.subarray(i, i + 4), o);
        }
    }
    for (const canvas of [image, part(name, "overlay")]) Object.assign(canvas, { width: W, height: H });
    image.getContext("2d").putImageData(pixels, 0, 0);
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

function leave(name) {
    const table = shown[name];
    if (table) table.hover = null;
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
    field("refraction").setAttribute("aria-pressed", String(quality.refraction));
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
    onSkyView((pass) => show("skyView", pass.skyViewTexture));
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
    field("refraction").addEventListener("click", () => {
        quality.refraction = !quality.refraction;
        recompute();
    });
    for (const name of Object.keys(READOUTS)) {
        const image = part(name, "image");
        image.addEventListener("pointermove", (event) => hover(name, event));
        image.addEventListener("pointerleave", () => leave(name));
        new ResizeObserver(() => paint(name)).observe(image);
    }
    field("reset").addEventListener("click", () => {
        quality.config = structuredClone(DEFAULT_TEXTURE_CONFIG);
        recompute();
    });
}
