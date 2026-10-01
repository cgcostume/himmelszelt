import { showCode } from "../code.js";
import { paintRange } from "../range.js";
import {
    bindCubifyToggle,
    bindRefractionToggle,
    gpu,
    onEnvironment,
    quality,
    setEnvironmentSize,
    setIrradianceSize,
} from "./atmosphere.js";
import { formatBytes, saveHdr, savePng } from "./download.js";
import { createPreview, renderPixels, SCALE } from "./preview.js";

const root = document.querySelector("#environment");
const field = (name) => root.querySelector(`[data-field="${name}"]`);
const panel = (name) => root.querySelector(`[data-panel="${name}"] canvas`);
const levels = (name) => root.querySelector(`[data-panel="${name}"] [data-field="levels"]`);
// The mip level each panel shows, and how: texel by texel, or interpolated between texel centers as a sampler does.
const shown = { sky: 0, irradiance: 0 };
const filters = { sky: "nearest", irradiance: "nearest" };

const levelPart = (name, field) => root.querySelector(`[data-panel="${name}"] [data-field="${field}"]`);

/** The mip level slider fitted to `texture`: its range, and the level and the face size it stands for beside it. */
function offerLevels(name, texture) {
    const slider = levels(name);
    shown[name] = Math.min(shown[name], texture.mipLevelCount - 1);
    slider.max = String(texture.mipLevelCount - 1);
    slider.value = String(shown[name]);
    slider.dataset.size = String(texture.width);
    paintRange(slider);
    showLevel(name);
}

function showLevel(name) {
    const size = Number(levels(name).dataset.size);
    levelPart(name, "level").textContent = `mip level ${shown[name]}`;
    levelPart(name, "resolution").textContent = `${Math.max(1, size >> shown[name])}²`;
}

/** Shows mip `level` of a panel, held within its levels. */
function setLevel(name, level) {
    const slider = levels(name);
    const next = Math.min(Math.max(level, 0), Number(slider.max));
    if (next === shown[name]) return;
    shown[name] = next;
    slider.value = String(next);
    paintRange(slider);
    showLevel(name);
    if (last) draw(last);
}

const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const previews = {};
let last = null;

const textures = ({ cube, cubified, ibl }) => ({
    sky: { texture: cube, cubified },
    irradiance: { texture: ibl.irradiance, cubified: false },
});
const previewOptions = (name, cubified) => ({
    cube: true,
    filter: filters[name],
    scale: SCALE.mean,
    level: shown[name],
    cubified,
});

/** Bytes of a cube map of rgba16float, every mip level included. */
function cubeBytes({ width, mipLevelCount }) {
    let bytes = 0;
    for (let level = 0; level < mipLevelCount; ++level) bytes += Math.max(1, width >> level) ** 2 * 6 * 8;
    return bytes;
}

// The calls that compute each cube map as it is shown, with the settings it was computed with.
const CALLS = {
    sky: ({ cube, cubified }) => [
        "const cube = device.createTexture({",
        `    size: [${cube.width}, ${cube.width}, 6],`,
        `    mipLevelCount: ${cube.mipLevelCount}, // each filled, the mean of four above; 1 for none`,
        '    format: "rgba16float",',
        "    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,",
        '    textureBindingViewDimension: "cube",',
        "});",
        `const cubePass = await sky.createCubePass({ format: "rgba16float", samples: 8${cubified ? ", cubify: true" : ""} });`,
        "cubePass.encode(encoder, cube);",
    ],
    irradiance: ({ ibl, cubified }) => [
        "// Every mip level, each from the nine coefficients.",
        `const ibl = await createIrradiancePass(device, { size: ${ibl.irradiance.width}${cubified ? ", cubified: true" : ""} });`,
        "ibl.encode(encoder, cube);",
        "ibl.irradiance; // and ibl.sh, the nine coefficients",
    ],
};

// Both cube maps unrolled into panoramas on the GPU, tone mapped around their geometric means.
function draw(environment) {
    last = environment;
    const { sh, sun, buildMs } = environment;
    for (const [name, { texture, cubified }] of Object.entries(textures(environment))) {
        offerLevels(name, texture);
        showCode(levelPart(name, "call"), CALLS[name](environment).join("\n"));
        // The settings folded into one line: what the cube map is computed with, then how it is shown.
        const built =
            name === "sky" ? [cubified ? "cubified" : "plain", quality.refraction ? "refracted" : "straight"] : [];
        levelPart(name, "summary").textContent = [
            `faces ${texture.width}`,
            ...built,
            `mip level ${shown[name]}`,
            filters[name],
        ].join(", ");
        previews[name] ??= createPreview(panel(name));
        previews[name].draw(texture, previewOptions(name, cubified));
        root.querySelector(`[data-panel="${name}"] [data-field="info"]`).textContent =
            `${texture.format}, 6 faces, ${texture.mipLevelCount} levels, ${formatBytes(cubeBytes(texture))}`;
    }
    field("timing").textContent = `built in ${buildMs.toFixed(1)} ms`;
    showValues(sh, sun);
}

// The shown level unrolled into a panorama, four texels of a face across a quarter turn, up to 4096 by 2048: tone mapped
// for PNG, the values themselves for HDR.
async function download(name, format) {
    if (!last) return;
    const { texture, cubified } = textures(last)[name];
    const face = Math.max(1, texture.width >> shown[name]);
    const width = Math.min(4 * face, 4096);
    const height = width / 2;
    const pixels = await renderPixels(texture, previewOptions(name, cubified), width, height, format === "hdr");
    const file = `himmelszelt-dunstkreis-${name}-${face}${cubified ? "-cubified" : ""}-panorama`;
    if (format === "hdr") saveHdr(pixels, width, height, file);
    else savePng(pixels, width, height, file);
}

const NAMES = ["0, 0", "1, −1", "1, 0", "1, 1", "2, −2", "2, −1", "2, 0", "2, 1", "2, 2"];
const e = (v) => v.toExponential(3).padStart(10);

function showValues(sh, [r, g, b]) {
    field("sun").textContent =
        `Sunlight at the observer: ${Math.round(luminance(r, g, b)).toLocaleString("en")} lux ` +
        `(rgb ${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
    field("sh").textContent = [
        "l, m        r          g          b",
        ...NAMES.map((name, i) => `${name.padEnd(6)} ${e(sh[i * 3])} ${e(sh[i * 3 + 1])} ${e(sh[i * 3 + 2])}`),
    ].join("\n");
}

if (gpu.error) {
    root.querySelector(".lut-bar").insertAdjacentHTML("afterend", `<p class="note">${gpu.error}</p>`);
} else {
    onEnvironment(draw);
    for (const button of root.querySelectorAll("[data-refraction]")) bindRefractionToggle(button);
    for (const name of ["sky", "irradiance"]) {
        new ResizeObserver(() => {
            if (last) draw(last);
        }).observe(panel(name));
    }
    for (const radio of root.querySelectorAll("[data-filter]")) {
        radio.checked = radio.value === filters[radio.dataset.filter];
        radio.addEventListener("change", () => {
            filters[radio.dataset.filter] = radio.value;
            if (last) draw(last);
        });
    }
    for (const name of ["sky", "irradiance"]) {
        levels(name).addEventListener("input", () => setLevel(name, Number(levels(name).value)));
        // The wheel steps a level at a time, over the slider and over both labels: down to the coarser levels.
        for (const target of [levels(name), levelPart(name, "level"), levelPart(name, "resolution")]) {
            target.addEventListener(
                "wheel",
                (event) => {
                    event.preventDefault();
                    if (event.deltaY !== 0) setLevel(name, shown[name] + Math.sign(event.deltaY));
                },
                { passive: false },
            );
        }
    }
    for (const radio of root.querySelectorAll("[data-size]")) {
        const set = radio.dataset.size === "sky" ? setEnvironmentSize : setIrradianceSize;
        radio.addEventListener("change", () => set(Number(radio.value)));
    }
    for (const button of root.querySelectorAll("[data-cubify]")) bindCubifyToggle(button);
    for (const button of root.querySelectorAll("[data-download]")) {
        button.addEventListener("click", () => download(button.dataset.panelName, button.dataset.download));
    }
}
