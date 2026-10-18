import { clampObserverHeight, MULTI_SCATTERING_LOG2_OFFSET, readTexture } from "@himmelszelt/dunstkreis";
import { showCode } from "../code";
import { find } from "../dom";
import { onDemand } from "../frame";
import { state } from "../sternzeit/state";
import {
    bindCubifyToggle,
    bindModelChoice,
    bindRefractionToggle,
    bindScaledToggle,
    currentSky,
    type Environment,
    environment,
    gpu,
    gpuDevice,
    needEnvironment,
    onEnvironment,
    onSkyView,
    onTables,
    quality,
    recompute,
    setEnvironmentSize,
    setIrradianceSize,
    tables,
} from "./atmosphere";
import { save, saveHdr } from "./download";
import { createPreview, type PreviewOptions, renderPixels, SCALE, TABLE_PREVIEW } from "./preview";

const root = find("#generator");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const file = (name: string) => find(`[data-file="${name}"]`, root);
type TableName = keyof typeof TABLE_PREVIEW;
const TABLES: TableName[] = ["transmittance", "multiScattering", "skyView"];
const CUBES = ["sky", "irradiance"] as const;
type CubeName = (typeof CUBES)[number];

const variant = () => root.dataset.variant ?? "a";
// To the second: a moment set to the minute comes back from its Julian day a hair before it.
const utc = () => new Date(Math.round((state.jd - 2440587.5) * 86_400) * 1000).toISOString();
const stamp = () => utc().slice(0, 16).replace(":", "");
const fileName = (what: string) => `himmelszelt-dunstkreis-${what}-${stamp()}`;

/** A table as the page holds it now, and what its values are multiplied by: the sky view's scale, 1 for the others. */
function table(name: TableName) {
    if (name !== "skyView") {
        const texture = tables()?.luts[name];
        return texture ? { texture, scale: 1 } : null;
    }
    const sky = currentSky();
    return sky ? { texture: sky.pass.skyViewTexture, scale: sky.pass.skyViewScale } : null;
}

/** A cube map of the environment built last, and whether it is cubified; the irradiance never is. */
function cube(name: CubeName, { cube, ibl, cubified = false }: Environment) {
    return name === "sky" ? { texture: cube, cubified } : { texture: ibl?.irradiance ?? null, cubified: false };
}
const cubeOptions = (cubified: boolean): PreviewOptions => ({
    cube: true,
    filter: "linear",
    scale: SCALE.mean,
    cubified,
});
const tableOptions = (name: TableName): PreviewOptions => ({ ...TABLE_PREVIEW[name], filter: "nearest" });

const divide = <T extends Float32Array>(pixels: T, scale: number): T => {
    if (scale !== 1) for (let i = 0; i < pixels.length; ++i) pixels[i] = (pixels[i] ?? 0) / scale;
    return pixels;
};

async function downloadTable(name: TableName, format: string) {
    const found = table(name);
    if (!found) return;
    const { texture, scale } = found;
    const { width, height } = texture;
    const what = `${name}-${width}x${height}`;
    if (format === "hdr") {
        const pixels = await renderPixels(texture, tableOptions(name), width, height, true);
        saveHdr(divide(pixels as Float32Array, scale), width, height, fileName(what));
        return;
    }
    const { data } = await readTexture(gpuDevice(), texture);
    const values = Float32Array.from(
        data,
        name === "multiScattering" ? (v) => 2 ** (v - MULTI_SCATTERING_LOG2_OFFSET) : (v) => v,
    );
    save(new Blob([divide(values, scale)]), `${fileName(`${what}-rgba32f`)}.f32`);
}

// The faces read back level by level down to one at most 1024 texels wide, which a 4096 cube map's 400 MB would not.
const FACES_MAX = 1024;

async function downloadCube(name: CubeName, format: string) {
    const { texture, cubified } = cube(name, environment);
    if (!texture) return;
    const { scale } = environment;
    const suffix = cubified ? "-cubified" : "";
    if (format === "panorama") {
        const width = Math.min(Math.max(4 * texture.width, 512), 4096);
        const pixels = await renderPixels(texture, cubeOptions(cubified), width, width / 2, true);
        saveHdr(
            divide(pixels as Float32Array, scale),
            width,
            width / 2,
            fileName(`${name}-panorama-${width}x${width / 2}`),
        );
        return;
    }
    let level = 0;
    while (texture.width >> level > FACES_MAX) ++level;
    const face = Math.max(1, texture.width >> level);
    const faces = await Promise.all([0, 1, 2, 3, 4, 5].map((layer) => readTexture(gpuDevice(), texture, layer, level)));
    const strip = new Float32Array(6 * face * face * 4);
    faces.forEach(({ data }, f) => {
        for (let y = 0; y < face; ++y)
            strip.set(data.subarray(y * face * 4, (y + 1) * face * 4), (y * 6 + f) * face * 4);
    });
    saveHdr(divide(strip, scale), 6 * face, face, fileName(`${name}-faces-${face}${suffix}`));
}

const LM = ["0,0", "1,-1", "1,0", "1,1", "2,-2", "2,-1", "2,0", "2,1", "2,2"];
// The cosine lobe's weights per order and the basis functions' constants, as dunstkreis' irradiance.comp.wgsl has them.
const LOBE = [Math.PI, (2 * Math.PI) / 3, (2 * Math.PI) / 3, (2 * Math.PI) / 3, ...Array(5).fill(Math.PI / 4)];
const BASIS = [
    "0.282095",
    "0.488603 * n.y",
    "0.488603 * n.z",
    "0.488603 * n.x",
    "1.092548 * n.x * n.y",
    "1.092548 * n.y * n.z",
    "0.315392 * (3.0 * n.z * n.z - 1.0)",
    "1.092548 * n.x * n.z",
    "0.546274 * (n.x * n.x - n.y * n.y)",
];

/** The nine coefficients in cd/m², whether the cube map is scaled or not, rgb after rgb. */
const coefficients = () => {
    const { sh, scale } = environment;
    return sh ? LM.map((_, i) => [0, 1, 2].map((c) => (sh[i * 3 + c] ?? 0) / scale)) : null;
};
const where = () =>
    `${utc().slice(0, 16).replace("T", " ")} UTC, ${state.latitude.toFixed(3)}°, ${state.longitude.toFixed(3)}°, ` +
    `${clampObserverHeight(state.heightM).toFixed(0)} m`;
const float = (v: number) => {
    const text = String(Number(v.toPrecision(6)));
    return /[.e]/.test(text) ? text : `${text}.0`;
};

function wgslIrradiance(sh: number[][]) {
    const terms = sh.map((rgb, i) => {
        const weighted = rgb.map((v) => float(v * (LOBE[i] ?? 0))).join(", ");
        return `        vec3f(${weighted}) * ${BASIS[i]}`;
    });
    return [
        `// The sky's irradiance in lux on a surface facing \`n\`, a unit ENU normal, from dunstkreis' nine coefficients`,
        `// of ${where()}. A white Lambertian surface shows it divided by pi, in cd/m².`,
        "fn skyIrradiance(n: vec3f) -> vec3f {",
        "    return max(",
        `${terms.join(" +\n")},`,
        "        vec3f(0.0),",
        "    );",
        "}",
        "",
    ].join("\n");
}

function downloadCoefficients(format: string) {
    const sh = coefficients();
    if (!sh) return;
    if (format === "wgsl") {
        save(new Blob([wgslIrradiance(sh)], { type: "text/plain" }), `${fileName("irradiance")}.wgsl`);
        return;
    }
    const json = {
        what: "Radiance of the sky in real spherical harmonics up to order 2, without the Sun's disc",
        unit: "cd/m²",
        directions: "ENU: x east, y north, z up",
        order: LM,
        coefficients: sh,
        irradiance: "lux for normal n: the sum of coefficient times lobe times basis(n), the lobe pi, 2 pi / 3, pi / 4",
        sunIlluminanceLux: [...environment.sun],
    };
    save(new Blob([`${JSON.stringify(json, null, 4)}\n`], { type: "application/json" }), `${fileName("sh")}.json`);
}

/** Everything the files are made with, enough to make them again. */
function settings() {
    const sky = environment.sky ?? currentSky();
    return {
        library: "@himmelszelt/dunstkreis",
        moment: { utc: utc(), julianDay: state.jd },
        place: { latitude: state.latitude, longitude: state.longitude, heightM: state.heightM },
        sun: sky && {
            direction: sky.sunDirection,
            apparentDirection: sky.apparentSun,
            angularDiameter: sky.sunAngularDiameter,
        },
        observerHeightM: sky?.observerHeightM,
        modelName: quality.model,
        refraction: quality.refraction,
        model: tables()?.luts.model,
        config: quality.config,
        groundLight: quality.groundLight,
        cubeMap: {
            format: "rgba16float",
            size: environment.cube?.width,
            mipLevelCount: environment.cube?.mipLevelCount,
            samples: 8,
            cubify: environment.cubified,
            scaled: environment.scaledWith,
            scale: environment.scale,
        },
        irradiance: { size: environment.ibl?.irradiance.width },
        meteredEV100: environment.ev100,
    };
}

function downloadSettings() {
    const json = `${JSON.stringify(settings(), null, 4)}\n`;
    save(new Blob([json], { type: "application/json" }), `${fileName("settings")}.json`);
}

const fixed3 = (v: number) => Number(v.toFixed(3));

/** The code that makes the same tables, cube map and coefficients, with the settings as they are. */
function recipe() {
    const sky = environment.sky ?? currentSky();
    const { config } = quality;
    const size = (name: TableName) => `{ width: ${config[name].width}, height: ${config[name].height} }`;
    const samples = TABLES.map((name) => `${name}: ${config.integralSamples[name]}`).join(", ");
    const model = { fitted: "DEFAULT", rgb: "RGB", osghimmel: "OSGHIMMEL" }[quality.model];
    const faces = environment.cube?.width ?? environment.size;
    const cubeFlags = `${environment.cubified ? ", cubify: true" : ""}${environment.scaledWith ? ", scaled: true" : ""}`;
    return [
        "import {",
        "    createIrradiancePass,",
        "    createSkyPass,",
        `    ${model}_ATMOSPHERE_MODEL,`,
        "    precomputeAtmosphere,",
        '} from "@himmelszelt/dunstkreis";',
        "",
        "const model = " +
            (quality.refraction ? `${model}_ATMOSPHERE_MODEL;` : `{ ...${model}_ATMOSPHERE_MODEL, refractivity: 0 };`),
        "const config = {",
        ...TABLES.map((name) => `    ${name}: ${size(name)},`),
        `    integralSamples: { ${samples} },`,
        "};",
        "const luts = await precomputeAtmosphere(device, { model, config });",
        'const sky = await createSkyPass(device, { luts, format: "rgba8unorm" });',
        "sky.update({",
        `    sunDirection: [${(sky?.sunDirection ?? [0, 0, 1]).map(fixed3).join(", ")}],`,
        `    observerHeightM: ${fixed3(sky?.observerHeightM ?? clampObserverHeight(state.heightM))},`,
        "});",
        "const cube = device.createTexture({",
        `    size: [${faces}, ${faces}, 6],`,
        `    mipLevelCount: ${Math.floor(Math.log2(faces)) + 1},`,
        '    format: "rgba16float",',
        "    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,",
        '    textureBindingViewDimension: "cube",',
        "});",
        "const cubePass = await sky.createCubePass({",
        `    format: "rgba16float", samples: 8${cubeFlags},`,
        "});",
        "const ibl = await createIrradiancePass(device, {",
        `    size: ${environment.ibl?.irradiance.width ?? environment.irradianceSize}${environment.cubified ? ", cubified: true" : ""},`,
        "});",
        "const encoder = device.createCommandEncoder();",
        "cubePass.encode(encoder, cube);",
        "ibl.encode(encoder, cube);",
        "device.queue.submit([encoder.finish()]);",
        "const sh = await ibl.readSH(); // nine coefficients, rgb each",
    ].join("\n");
}

// What each file comes to, under its name.
function details() {
    const detail = (name: string, text: string) => {
        find('[data-field="detail"]', file(name)).textContent = text;
    };
    const wavelengths = tables()?.luts.model.wavelengths ?? [];
    for (const name of TABLES) {
        const found = table(name);
        if (found) detail(name, `${found.texture.width}×${found.texture.height}, ${[...new Set(wavelengths)].length}λ`);
    }
    const { cube: sky, ibl, cubified, scaledWith, scale } = environment;
    if (sky)
        detail(
            "sky",
            `faces ${sky.width}${cubified ? ", cubified" : ""}${scaledWith ? `, stored times 2^${Math.log2(scale)}` : ""}, cd/m²`,
        );
    const sh = coefficients();
    if (ibl && sh) {
        // On the ground, a surface facing up: the order 0 term and the two zonal ones, which depend on z alone.
        const up = [0, 1, 2].map(
            (c) =>
                (sh[0]?.[c] ?? 0) * Math.PI * 0.282095 +
                (sh[2]?.[c] ?? 0) * ((2 * Math.PI) / 3) * 0.488603 +
                (sh[6]?.[c] ?? 0) * (Math.PI / 4) * 0.315392 * 2,
        );
        const lux = 0.2126 * (up[0] ?? 0) + 0.7152 * (up[1] ?? 0) + 0.0722 * (up[2] ?? 0);
        detail("irradiance", `faces ${ibl.irradiance.width}, lux, ${lux.toPrecision(2)} on the ground`);
    }
    detail("coefficients", "l ≤ 2, rgb, cd/m²");
    detail("settings", where());
}

function showControls() {
    for (const input of root.querySelectorAll<HTMLInputElement>("[data-config]")) input.value = String(read(input));
    for (const input of root.querySelectorAll<HTMLInputElement>('input[name="generator-model"]'))
        input.checked = input.value === quality.model;
    for (const input of root.querySelectorAll<HTMLInputElement>("[data-size]")) {
        const size = input.dataset.size === "sky" ? environment.size : environment.irradianceSize;
        input.checked = Number(input.value) === size;
    }
    const { config } = quality;
    field("summary").textContent = [
        { fitted: "dunstkreis 4λ", rgb: "Bruneton’08 3λ", osghimmel: "osgHimmel’12 3λ" }[quality.model],
        quality.refraction ? "refracted" : "straight",
        `sky view ${config.skyView.width}×${config.skyView.height}`,
        `cube ${environment.size}${environment.cubify ? " cubified" : ""}`,
        `irradiance ${environment.irradianceSize}`,
    ].join(", ");
}

// A setting of the tables' configuration by its path, such as "skyView.width".
type Config = Record<string, unknown>;
const path = (input: HTMLInputElement) => (input.dataset.config ?? "").split(".");
const read = (input: HTMLInputElement) =>
    Number(path(input).reduce<unknown>((object, part) => (object as Config)[part], quality.config));
function write(input: HTMLInputElement, value: number) {
    const parts = path(input);
    const last = parts.pop() ?? "";
    (parts.reduce<unknown>((object, part) => (object as Config)[part], quality.config) as Config)[last] = value;
}

const previews = new Map<HTMLCanvasElement, ReturnType<typeof createPreview>>();
const drawInto = (canvas: HTMLCanvasElement, texture: GPUTexture, options: PreviewOptions) => {
    const preview = previews.get(canvas) ?? createPreview(canvas);
    previews.set(canvas, preview);
    preview.draw(texture, options);
};
const thumb = (name: string) => find<HTMLCanvasElement>('[data-field="thumb"]', file(name));

function draw() {
    showControls();
    details();
    if (environment.cube) {
        const { texture, cubified } = cube("sky", environment);
        if (texture && variant() === "a")
            drawInto(field<HTMLCanvasElement>("panorama"), texture, cubeOptions(cubified));
    }
    if (variant() === "b") {
        showCode(field("recipe"), recipe());
        for (const name of TABLES) {
            const found = table(name);
            if (found) drawInto(thumb(name), found.texture, tableOptions(name));
        }
        for (const name of CUBES) {
            const { texture, cubified } = cube(name, environment);
            if (texture) drawInto(thumb(name), texture, cubeOptions(cubified));
        }
    }
    field("timing").textContent = environment.buildMs ? `built in ${environment.buildMs.toFixed(1)} ms` : "";
}

if (gpu.error) {
    field("recipe").insertAdjacentHTML("afterend", `<p class="note">${gpu.error}</p>`);
} else {
    const request = onDemand(draw, root);
    onEnvironment(request);
    onTables(request);
    onSkyView(request);
    needEnvironment(root);
    request();

    bindModelChoice(root.querySelectorAll<HTMLInputElement>('input[name="generator-model"]'));
    bindRefractionToggle(find("[data-refraction]", root));
    bindCubifyToggle(find("[data-cubify]", root));
    bindScaledToggle(find("[data-scaled]", root));
    for (const radio of root.querySelectorAll<HTMLInputElement>("[data-size]")) {
        const set = radio.dataset.size === "sky" ? setEnvironmentSize : setIrradianceSize;
        radio.addEventListener("change", () => {
            set(Number(radio.value));
            request();
        });
    }
    // Whole texels and samples, held within the input's range: a typed value may lie outside it.
    for (const input of root.querySelectorAll<HTMLInputElement>("[data-config]")) {
        input.addEventListener("change", () => {
            const value = Math.round(
                Math.min(Math.max(Number(input.value) || 0, Number(input.min)), Number(input.max)),
            );
            input.value = String(value);
            if (value === read(input)) return;
            write(input, value);
            recompute();
        });
    }
    for (const item of root.querySelectorAll<HTMLElement>("[data-file]")) {
        const name = item.dataset.file ?? "";
        for (const button of item.querySelectorAll<HTMLElement>("[data-download]")) {
            const format = button.dataset.download ?? "";
            button.addEventListener("click", () => {
                if ((TABLES as string[]).includes(name)) downloadTable(name as TableName, format);
                else if ((CUBES as readonly string[]).includes(name)) downloadCube(name as CubeName, format);
                else if (name === "coefficients") downloadCoefficients(format);
                else downloadSettings();
            });
        }
    }
    for (const radio of root.querySelectorAll<HTMLInputElement>('input[name="generator-variant"]')) {
        radio.addEventListener("change", () => {
            root.dataset.variant = radio.value;
            find<HTMLDetailsElement>(".generator-fold", root).open = radio.value === "a";
            request();
        });
    }
    new ResizeObserver(request).observe(root);
}
