import { showCode } from "../code";
import { find } from "../dom";
import { paintRange } from "../range";
import {
    bindCubifyToggle,
    bindRefractionToggle,
    bindScaledToggle,
    type Environment,
    gpu,
    onEnvironment,
    quality,
    setEnvironmentSize,
    setIrradianceSize,
} from "./atmosphere";
import { formatBytes, saveHdr, savePng } from "./download";
import { createPreview, type PreviewOptions, renderPixels, SCALE } from "./preview";

type PanelName = "sky" | "irradiance";
const PANELS: PanelName[] = ["sky", "irradiance"];
const root = find("#environment");
const field = (name: string) => find(`[data-field="${name}"]`, root);
const panel = (name: PanelName) => find<HTMLCanvasElement>(`[data-panel="${name}"] canvas`, root);
const levels = (name: PanelName) => find<HTMLInputElement>(`[data-panel="${name}"] [data-field="levels"]`, root);
// The mip level each panel shows, and how: texel by texel, or interpolated between texel centers as a sampler does.
const shown = { sky: 0, irradiance: 0 };
const filters: Record<PanelName, "linear" | "nearest"> = { sky: "linear", irradiance: "nearest" };

const levelPart = (name: PanelName, field: string) => find(`[data-panel="${name}"] [data-field="${field}"]`, root);

/** The mip level slider fitted to `texture`: its range, and the level and the face size it stands for beside it. */
function offerLevels(name: PanelName, texture: GPUTexture) {
    const slider = levels(name);
    shown[name] = Math.min(shown[name], texture.mipLevelCount - 1);
    slider.max = String(texture.mipLevelCount - 1);
    slider.value = String(shown[name]);
    slider.dataset.size = String(texture.width);
    paintRange(slider);
    showLevel(name);
}

function showLevel(name: PanelName) {
    const size = Number(levels(name).dataset.size);
    levelPart(name, "level").textContent = `mip level ${shown[name]}`;
    levelPart(name, "resolution").textContent = `${Math.max(1, size >> shown[name])}²`;
}

/** Shows mip `level` of a panel, held within its levels. */
function setLevel(name: PanelName, level: number) {
    const slider = levels(name);
    const next = Math.min(Math.max(level, 0), Number(slider.max));
    if (next === shown[name]) return;
    shown[name] = next;
    slider.value = String(next);
    paintRange(slider);
    showLevel(name);
    if (last) draw(last);
}

const luminance = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const previews: Partial<Record<PanelName, ReturnType<typeof createPreview>>> = {};
let last: Environment | null = null;

const textures = ({ cube, cubified = false, ibl }: Environment) => ({
    sky: { texture: cube, cubified },
    irradiance: { texture: ibl?.irradiance ?? null, cubified: false },
});
const previewOptions = (name: PanelName, cubified: boolean): PreviewOptions => ({
    cube: true,
    filter: filters[name],
    scale: SCALE.mean,
    level: shown[name],
    cubified,
});

/** Bytes of a cube map of rgba16float, every mip level included. */
function cubeBytes({ width, mipLevelCount }: GPUTexture) {
    let bytes = 0;
    for (let level = 0; level < mipLevelCount; ++level) bytes += Math.max(1, width >> level) ** 2 * 6 * 8;
    return bytes;
}

// The calls that compute each cube map as it is shown, with the settings it was computed with.
const CALLS: Record<PanelName, (environment: Environment) => string[]> = {
    sky: ({ cube, cubified, scaledWith, scale }) => [
        "const cube = device.createTexture({",
        `    size: [${cube?.width}, ${cube?.width}, 6],`,
        `    mipLevelCount: ${cube?.mipLevelCount}, // each filled, the mean of four above; 1 for none`,
        '    format: "rgba16float",',
        "    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,",
        '    textureBindingViewDimension: "cube",',
        "});",
        `const cubePass = await sky.createCubePass({ format: "rgba16float", samples: 8${cubified ? ", cubify: true" : ""}${scaledWith ? ", scaled: true" : ""} });`,
        "cubePass.encode(encoder, cube);",
        ...(scaledWith
            ? [`const scale = sky.skyViewScale; // 2^${Math.log2(scale)}, read when encoding: cd/m² = texel / scale`]
            : []),
    ],
    irradiance: ({ ibl, cubified }) => [
        "// Every mip level, each from the nine coefficients.",
        `const ibl = await createIrradiancePass(device, { size: ${ibl?.irradiance.width}${cubified ? ", cubified: true" : ""} });`,
        "ibl.encode(encoder, cube);",
        "ibl.irradiance; // and ibl.sh, the nine coefficients",
    ],
};

// Both cube maps unrolled into panoramas on the GPU, tone mapped around their geometric means.
function draw(environment: Environment) {
    last = environment;
    const { sh, sun, buildMs } = environment;
    const all = textures(environment);
    for (const name of PANELS) {
        const { texture, cubified } = all[name];
        if (!texture) continue;
        offerLevels(name, texture);
        showCode(levelPart(name, "call"), CALLS[name](environment).join("\n"));
        // The settings folded into one line: what the cube map is computed with, then how it is shown.
        const built =
            name === "sky"
                ? [
                      cubified ? "cubified" : "plain",
                      ...(environment.scaledWith ? [`scaled 2^${Math.log2(environment.scale)}`] : []),
                      quality.refraction ? "refracted" : "straight",
                  ]
                : [];
        levelPart(name, "summary").textContent = [
            `faces ${texture.width}`,
            ...built,
            `mip level ${shown[name]}`,
            filters[name],
        ].join(", ");
        const preview = previews[name] ?? createPreview(panel(name));
        previews[name] = preview;
        preview.draw(texture, previewOptions(name, cubified));
        find(`[data-panel="${name}"] [data-field="info"]`, root).textContent =
            `${texture.format}, 6 faces, ${texture.mipLevelCount} levels, ${formatBytes(cubeBytes(texture))}`;
    }
    field("timing").textContent = `built in ${buildMs?.toFixed(1)} ms`;
    if (sh)
        showValues(
            sh.map((v) => v / environment.scale),
            sun,
        );
}

// The shown level unrolled into a panorama, four texels of a face across a quarter turn, up to 4096 by 2048: tone mapped
// for PNG, the values themselves for HDR.
async function download(name: PanelName, format: string) {
    if (!last) return;
    const { texture, cubified } = textures(last)[name];
    if (!texture) return;
    const face = Math.max(1, texture.width >> shown[name]);
    const width = Math.min(4 * face, 4096);
    const height = width / 2;
    const pixels = await renderPixels(texture, previewOptions(name, cubified), width, height, format === "hdr");
    // In cd/m², or lux for the irradiance, whether the cube map is scaled or not.
    if (format === "hdr" && last.scale !== 1) for (let i = 0; i < pixels.length; ++i) pixels[i] /= last.scale;
    const file = `himmelszelt-dunstkreis-${name}-${face}${cubified ? "-cubified" : ""}-panorama`;
    if (pixels instanceof Float32Array) saveHdr(pixels, width, height, file);
    else savePng(pixels, width, height, file);
}

const NAMES = ["0, 0", "1, −1", "1, 0", "1, 1", "2, −2", "2, −1", "2, 0", "2, 1", "2, 2"];
const e = (v = 0) => v.toExponential(3).padStart(10);

function showValues(sh: ArrayLike<number>, [r = 0, g = 0, b = 0]: ArrayLike<number> & Iterable<number>) {
    field("sun").textContent =
        `Sunlight at the observer: ${Math.round(luminance(r, g, b)).toLocaleString("en")} lux ` +
        `(rgb ${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
    field("sh").textContent = [
        "l, m        r          g          b",
        ...NAMES.map((name, i) => `${name.padEnd(6)} ${e(sh[i * 3])} ${e(sh[i * 3 + 1])} ${e(sh[i * 3 + 2])}`),
    ].join("\n");
}

if (gpu.error) {
    find(".lut-bar", root).insertAdjacentHTML("afterend", `<p class="note">${gpu.error}</p>`);
} else {
    onEnvironment(draw);
    for (const button of root.querySelectorAll("[data-refraction]")) bindRefractionToggle(button);
    for (const name of PANELS) {
        new ResizeObserver(() => {
            if (last) draw(last);
        }).observe(panel(name));
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>("[data-filter]")) {
        const name = radio.dataset.filter as PanelName;
        radio.checked = radio.value === filters[name];
        radio.addEventListener("change", () => {
            filters[name] = radio.value as "linear" | "nearest";
            if (last) draw(last);
        });
    }
    for (const name of PANELS) {
        levels(name).addEventListener("input", () => setLevel(name, Number(levels(name).value)));
        // The wheel steps a level at a time, over the slider and over both labels: down to the coarser levels.
        for (const target of [levels(name), levelPart(name, "level"), levelPart(name, "resolution")]) {
            target.addEventListener(
                "wheel",
                (event: WheelEvent) => {
                    event.preventDefault();
                    if (event.deltaY !== 0) setLevel(name, shown[name] + Math.sign(event.deltaY));
                },
                { passive: false },
            );
        }
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>("[data-size]")) {
        const set = radio.dataset.size === "sky" ? setEnvironmentSize : setIrradianceSize;
        radio.addEventListener("change", () => set(Number(radio.value)));
    }
    for (const button of root.querySelectorAll("[data-cubify]")) bindCubifyToggle(button);
    for (const button of root.querySelectorAll("[data-scaled]")) bindScaledToggle(button);
    for (const button of root.querySelectorAll<HTMLElement>("[data-download]")) {
        button.addEventListener("click", () =>
            download(button.dataset.panelName as PanelName, button.dataset.download ?? "png"),
        );
    }
}
