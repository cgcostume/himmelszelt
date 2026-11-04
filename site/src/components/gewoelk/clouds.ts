import type { AtmosphereLUTs, AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import {
    apparentDirection,
    clampObserverHeight,
    createSkyPass,
    DEFAULT_AUTO_EXPOSURE_KEYS,
    refractionAngle,
} from "@himmelszelt/dunstkreis";
import type { CloudParams, CloudPass, Weather, WeatherName } from "@himmelszelt/gewoelk";
import {
    createCloudPass,
    DEFAULT_CLOUD_PARAMS,
    DEFAULT_CLOUDSCAPE,
    DEFAULT_SHEET,
    sunlightRows,
    WEATHER,
} from "@himmelszelt/gewoelk";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import {
    configureCanvas,
    currentSky,
    gpuDevice,
    needEnvironment,
    onEnvironment,
    onTables,
    quality,
    SDR,
    gpu as shared,
    skyViewChanged,
    tables,
} from "../dunstkreis/atmosphere";
import { type Basis, cameraBasis, lookAround, project } from "../dunstkreis/skycamera";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { COMPASS } from "../sternzeit/figure";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";
import { createAerialRgb } from "./aerial";
import { createSunlight } from "./sunlight";

const DEG = Math.PI / 180;
// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
// A stop more than the clear sky's meter, as a photographer exposes for clouds: metered, a cloudy sky comes out gray.
const CLOUD_COMPENSATION = 1;
// Seconds since J2000 drive the wind and the evolution: any epoch does, the same every frame.
const seconds = () => (state.jd - 2451545) * 86_400;

// The cosine lobe's weights per spherical harmonics band, and the basis at the zenith and the nadir, as rundbild's.
const LOBE = [Math.PI, 2.094395, 2.094395, 2.094395, 0.785398, 0.785398, 0.785398, 0.785398, 0.785398];
function irradianceAt(sh: Float32Array, up: 1 | -1, scale: number): [number, number, number] {
    const basis = [0.282095, 0, 0.488603 * up, 0, 0, 0, 0.315392 * 2, 0, 0];
    const e: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 9; ++c) {
        const weight = (LOBE[c] ?? 0) * (basis[c] ?? 0);
        for (let k = 0; k < 3; ++k) e[k] = (e[k] ?? 0) + (weight * (sh[c * 3 + k] ?? 0)) / scale;
    }
    return e.map((v) => Math.max(v, 0)) as [number, number, number];
}

/** The sky's luminance along the horizon, averaged over the azimuths: the zonal terms of the coefficients at z = 0. */
// Where the sun shows from an altitude, lifted by the air, for true elevations from -4° to 10° in steps of 0.1°: traced
// once per model and altitude, as dunstkreis' refractionAngle does it, then looked up. Above, the lift is a few
// arcminutes at most, and taken as none.
const LIFT_FROM = -4 * DEG;
const LIFT_STEP = 0.1 * DEG;
const LIFT_COUNT = 141;
const lifts = new WeakMap<AtmosphereModel, Map<number, Float64Array>>();

function lifted(model: AtmosphereModel, altitudeKm: number, elevation: number): number {
    const byAltitude = lifts.get(model) ?? new Map<number, Float64Array>();
    lifts.set(model, byAltitude);
    let table = byAltitude.get(altitudeKm);
    if (!table) {
        table = new Float64Array(LIFT_COUNT);
        for (let i = 0; i < LIFT_COUNT; i++) {
            const e = LIFT_FROM + i * LIFT_STEP;
            // The apparent altitude a whose ray, bent by refractionAngle(a), leaves towards e: a = e + bend(a).
            let a = e + 0.6 * DEG;
            for (let k = 0; k < 5; k++) {
                const bend = refractionAngle(model, altitudeKm * 1000, a / DEG);
                if (bend === null) break;
                a = e + bend * DEG;
            }
            table[i] = a;
        }
        byAltitude.set(altitudeKm, table);
    }
    const f = (elevation - LIFT_FROM) / LIFT_STEP;
    if (f < 0) return elevation;
    if (f >= LIFT_COUNT - 1) return elevation;
    const i = Math.floor(f);
    return (table[i] as number) + ((table[i + 1] as number) - (table[i] as number)) * (f - i);
}

function horizonLuminance(sh: Float32Array, scale: number): [number, number, number] {
    const l = [0, 1, 2].map((k) => Math.max((0.282095 * (sh[k] ?? 0) - 0.315392 * (sh[18 + k] ?? 0)) / scale, 0));
    return [l[0] ?? 0, l[1] ?? 0, l[2] ?? 0];
}

/** The clouds figure on `root`, a `figure[data-clouds]`: dunstkreis' sky in cd/m² into a float texture, gewoelk's
 *  clouds marched over it and composed into the canvas, both on the page's moment, place and tables. */
const prefixed = (prefix: string, values: object) =>
    Object.fromEntries(Object.entries(values).map(([key, value]) => [`${prefix}.${key}`, value as number | undefined]));

export function cloudsFigure(root: HTMLElement) {
    const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const maybe = <T extends HTMLElement = HTMLElement>(name: string) =>
        root.querySelector<T>(`[data-field="${name}"]`);
    const canvas = field<HTMLCanvasElement>("canvas");
    const compass = field("compassLabels");
    const pressed = (name: string) => maybe(name)?.getAttribute("aria-pressed") === "true";
    const sliders = [...root.querySelectorAll<HTMLInputElement>("input[data-param]")];
    const slider = (param: string) => Number(sliders.find((input) => input.dataset.param === param)?.value ?? 0);
    const choice = (name: string) =>
        root.querySelector<HTMLInputElement>(`input[name="${root.id}-${name}"]:checked`)?.value ?? "";

    const camera = { yaw: 20 * DEG, pitch: 12 * DEG, fov: 75 * DEG };
    const marks = () => Number(field("marks").dataset.level);
    field("marks").addEventListener("click", () => requestRender());

    function showError(html: string) {
        const error = document.createElement("div");
        error.className = "sky-error";
        error.innerHTML = `<p>${html}</p>`;
        canvas.replaceWith(error);
    }
    function setup() {
        if (shared.error) {
            showError(shared.error);
            return null;
        }
        const context = canvas.getContext("webgpu");
        if (!context) return null;
        configureCanvas(context, SDR);
        return { device: gpuDevice(), context, adapterName: shared.adapterName };
    }
    const gpu = setup();

    function inverseViewProjection({ f, r, u, tx, ty }: Basis) {
        return new Float32Array([...r.map((c) => c * tx), 0, ...u.map((c) => c * ty), 0, 0, 0, 0, 1, ...f, 0]);
    }
    const labels = COMPASS.map((name) =>
        compass.appendChild(Object.assign(document.createElement("span"), { textContent: name })),
    );
    function placeCompass(basis: Basis, width: number, height: number) {
        compass.hidden = marks() < 1;
        labels.forEach((label, i) => {
            const at = project([Math.sin(i * 45 * DEG), Math.cos(i * 45 * DEG), 0], basis, width, height);
            label.hidden = at === null;
            if (at === null) return;
            label.style.left = `${at.x}px`;
            label.style.top = `${at.y}px`;
        });
    }

    // The sky pass for the page's tables, the cloud pass for the chosen scale and steps, each remade when needed.
    let sky: { pass: SkyPass; luts: AtmosphereLUTs } | null = null;
    let skyBuilding: AtmosphereLUTs | null = null;
    let clouds: { pass: CloudPass; key: string } | null = null;
    let cloudsBuilding = "";
    let background: GPUTexture | null = null;
    // What the sky pass measured last: the metered exposure and the sunlight, read back after each sky-view rebuild.
    let ev100 = 14;
    let sunIlluminance: [number, number, number] = [0, 0, 0];
    let skyViewFor = "";
    let skyIrradiance: [number, number, number] = [0, 0, 0];
    let groundIrradiance: [number, number, number] = [0, 0, 0];
    let horizon: [number, number, number] = [0, 0, 0];
    // The sun's light aloft by altitude and its elevation over the local horizon, read back when the rows change.
    const sunlight = gpu ? createSunlight(gpu.device) : null;
    const aerialRgb = gpu ? createAerialRgb(gpu.device) : null;
    let sunTable: [number, number, number][] | undefined;
    let sunTableFor = "";
    const requestRender = onDemand(render, root);

    function buildSky(luts: AtmosphereLUTs) {
        if (!gpu || skyBuilding === luts) return;
        skyBuilding = luts;
        createSkyPass(gpu.device, {
            luts,
            format: "rgba32float",
            toneMap: false,
            autoExposure: false,
            groundLight: quality.groundLight,
            dither: false,
            // The air in front of the clouds, out to beyond the farthest in sight.
            aerialPerspective: { maxDistanceKm: 400 },
        }).then((pass) => {
            if (skyBuilding !== luts) return pass.destroy();
            sky?.pass.destroy();
            sky = { pass, luts };
            skyBuilding = null;
            skyViewFor = "";
            requestRender();
        });
    }
    function buildClouds(key: string, scale: number, maxSteps: number, layers: number) {
        if (!gpu || cloudsBuilding === key) return;
        cloudsBuilding = key;
        createCloudPass(gpu.device, { format: SDR, scale, maxSteps, grid: { layers } }).then((pass) => {
            if (cloudsBuilding !== key) return pass.destroy();
            clouds?.pass.destroy();
            clouds = { pass, key };
            cloudsBuilding = "";
            requestRender();
        });
    }

    // Timestamps around the cloud pass, where the device has them.
    const timing = gpu?.device.features.has("timestamp-query")
        ? {
              set: gpu.device.createQuerySet({ type: "timestamp", count: 2 }),
              resolve: gpu.device.createBuffer({
                  size: 16,
                  usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
              }),
              read: gpu.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
              busy: false,
          }
        : null;
    let cloudsMs = Number.NaN;
    async function readTiming() {
        if (!timing || timing.busy) return;
        timing.busy = true;
        await timing.read.mapAsync(GPUMapMode.READ);
        const [start, end] = new BigInt64Array(timing.read.getMappedRange());
        timing.read.unmap();
        timing.busy = false;
        cloudsMs = Number((end ?? 0n) - (start ?? 0n)) / 1e6;
        showTiming();
    }
    function showTiming() {
        const note = maybe("timing");
        if (!note || !gpu) return;
        const cost = Number.isFinite(cloudsMs) ? `clouds ${cloudsMs.toFixed(2)} ms on the GPU` : "no GPU timestamps";
        note.textContent = `${gpu.adapterName} · ${cost}`;
    }

    // A change of weather: the sliders blended from where they stand to the preset's over a few seconds, the frames
    // drawn only while it lasts.
    let weatherFrame = 0;
    function changeWeather(name: WeatherName) {
        const { noise, ...sheet } = (WEATHER[name] as Weather).sheet;
        const target = Object.entries({
            ...prefixed("cloudscape", WEATHER[name].cloudscape),
            ...prefixed("sheet", sheet),
            ...prefixed("sheet.noise", noise ?? {}),
        }).flatMap(([param, to]) => {
            const input = sliders.find((s) => s.dataset.param === param);
            return input && to !== undefined ? [{ input, from: Number(input.value), to }] : [];
        });
        const start = performance.now();
        cancelAnimationFrame(weatherFrame);
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / 3000);
            const s = t * t * (3 - 2 * t);
            for (const { input, from, to } of target) {
                input.value = String(from + (to - from) * s);
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
            if (t < 1) weatherFrame = requestAnimationFrame(step);
        };
        weatherFrame = requestAnimationFrame(step);
    }

    // A layer's sliders as a preset for gewoelk's WEATHER, to paste: the shape only, without the wind and the time.
    const UNSHAPED = new Set(["windSpeed", "windFrom", "evolution"]);
    function preset(layer: string): string {
        const values = (prefix: string) =>
            sliders.flatMap((input) => {
                const key = input.dataset.param?.slice(prefix.length + 1) ?? "";
                const own = input.dataset.param?.startsWith(`${prefix}.`) && !key.includes(".") && !UNSHAPED.has(key);
                return own ? [`${key}: ${Number(input.value)}`] : [];
            });
        const inner = values(layer);
        if (layer === "sheet") inner.push(`noise: { ${values("sheet.noise").join(", ")} }`);
        return `${layer}: { ${inner.join(", ")} },`;
    }

    function cloudParams(): Partial<CloudParams> {
        const windOf = (speed: number, azimuth: number): [number, number] => [
            speed * Math.sin(azimuth * DEG),
            speed * Math.cos(azimuth * DEG),
        ];
        const sunOn = pressed("light.sun");
        const ambientOn = pressed("light.ambient");
        return {
            sunIlluminance: sunOn ? sunIlluminance : [0, 0, 0],
            ...(sunOn && sunTable ? { sunlight: sunTable } : {}),
            skyIrradiance: ambientOn ? skyIrradiance : [0, 0, 0],
            groundIrradiance: ambientOn ? groundIrradiance : [0, 0, 0],
            horizonLuminance: horizon,
            ev100: ev100 - CLOUD_COMPENSATION,
            timeS: seconds(),
            cloudscape: {
                ...DEFAULT_CLOUDSCAPE,
                enabled: pressed("cloudscape.enabled"),
                coverage: slider("cloudscape.coverage"),
                sharpness: slider("cloudscape.sharpness"),
                baseKm: slider("cloudscape.baseKm"),
                heightKm: slider("cloudscape.heightKm"),
                offset: slider("cloudscape.offset"),
                wind: windOf(slider("cloudscape.windSpeed"), slider("cloudscape.windFrom") + 180),
                evolution: slider("cloudscape.evolution"),
                clearingKm: slider("cloudscape.clearingKm"),
                clearingFromKm: slider("cloudscape.clearingFromKm"),
                variation: slider("cloudscape.variation"),
                towers: slider("cloudscape.towers"),
                extinction: slider("cloudscape.extinction"),
                size: slider("cloudscape.size"),
                towerScale: slider("cloudscape.towerScale"),
                billows: slider("cloudscape.billows"),
                multiScatter: pressed("light.multi") ? DEFAULT_CLOUDSCAPE.multiScatter : 0,
            },
            sheets: [
                {
                    ...DEFAULT_SHEET,
                    enabled: pressed("sheet.enabled"),
                    coverage: slider("sheet.coverage"),
                    altitudeKm: slider("sheet.altitudeKm"),
                    opticalDepth: slider("sheet.opticalDepth"),
                    wind: windOf(slider("sheet.windSpeed"), slider("sheet.windFrom") + 180),
                    ripples: slider("sheet.ripples"),
                    noise: Object.fromEntries(
                        sliders
                            .filter((input) => input.dataset.param?.startsWith("sheet.noise."))
                            .map((input) => [input.dataset.param?.slice(12) ?? "", Number(input.value)]),
                    ),
                },
            ],
        };
    }

    function render() {
        const table = tables();
        if (!gpu || !table) return;
        if (sky?.luts !== table.luts) {
            buildSky(table.luts);
            return;
        }
        const scale = Number(choice("scale")) || 1;
        const maxSteps = Number(choice("steps")) || 128;
        const layers = Number(choice("layers")) || 64;
        const key = `${scale},${maxSteps},${layers}`;
        if (clouds?.key !== key) {
            buildClouds(key, scale, maxSteps, layers);
            return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        if (!background || background.width !== width || background.height !== height) {
            background?.destroy();
            background = gpu.device.createTexture({
                label: "sternwarte:cloudsBackground",
                size: [width, height],
                format: "rgba32float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        }

        const time = fromJulianDay(state.jd);
        const position = sun.horizontalPosition(time, state);
        const sunDirection = sun.direction(time, state);
        const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
        const observerHeightM = clampObserverHeight(state.heightM);
        const basis = cameraBasis(camera, width / height);
        const ivp = inverseViewProjection(basis);
        sky.pass.update({
            sunDirection,
            sunAngularDiameter,
            observerHeightM: state.heightM,
            inverseViewProjection: ivp,
            projectionDistance: basis.d,
            pixelRatio: dpr,
            ev100: UNIT_EV100,
            autoExposureKeys: DEFAULT_AUTO_EXPOSURE_KEYS,
        });
        const [x, y, z] = apparentDirection(sunDirection, table.luts.model, observerHeightM);
        const sunNote = maybe("sun");
        if (sunNote) {
            sunNote.textContent =
                `Sun ${position.altitude.toFixed(2)}° high (${(Math.asin(z) / DEG).toFixed(2)}° apparent), ` +
                `azimuth ${position.azimuth.toFixed(2)}°`;
        }
        // Whenever the sky view may have been rebuilt: the meter's reading and the sunlight, read back, and the
        // environment that gives the clouds their ambient light.
        const skyViewKey = `${state.jd},${state.latitude},${state.longitude},${state.heightM},${sky.luts === table.luts}`;
        if (skyViewKey !== skyViewFor) {
            skyViewFor = skyViewKey;
            const { pass } = sky;
            skyViewChanged({ pass, sunDirection, apparentSun: [x, y, z], sunAngularDiameter, observerHeightM });
            Promise.all([pass.meteredEV100(), pass.sunIlluminance()]).then(([metered, illuminance]) => {
                if (sky?.pass !== pass) return;
                const changed = Math.abs(metered - ev100) > 0.02 || illuminance.some((v, i) => v !== sunIlluminance[i]);
                ev100 = metered;
                sunIlluminance = illuminance;
                if (changed) requestRender();
            });
        }
        const params = {
            sunDirection,
            observerHeightM,
            inverseViewProjection: ivp,
            projectionDistance: basis.d,
            planetRadiusKm: table.luts.model.planet.groundRadiusKm,
            ...cloudParams(),
        };
        const rows = sunlightRows({ ...DEFAULT_CLOUD_PARAMS, ...params });
        const rowsKey = `${JSON.stringify(rows)},${sky.luts === table.luts}`;
        if (rowsKey !== sunTableFor && sunlight) {
            const luts = sky.luts;
            sunlight
                .table(luts, rows, (h, e) => lifted(luts.model, h, e))
                .then((values) => {
                    if (!values || sky?.luts !== luts) return;
                    sunTableFor = rowsKey;
                    sunTable = values;
                    requestRender();
                });
        }
        clouds.pass.update(params);

        placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
        const encoder = gpu.device.createCommandEncoder({ label: "sternwarte:clouds" });
        sky.pass.encode(encoder, background);
        // The air in front of the clouds from dunstkreis' volume, or, chosen so, a blend into the sky behind them.
        const volume = sky.pass.aerialPerspective;
        const aerialPerspective =
            choice("air") === "volume" && volume && aerialRgb
                ? aerialRgb.encode(encoder, sky.luts, volume, sky.pass.skyViewScale)
                : undefined;
        const timestamps = timing && !timing.busy;
        clouds.pass.encode(encoder, gpu.context.getCurrentTexture(), {
            background,
            ...(aerialPerspective ? { aerialPerspective } : {}),
            ...(timestamps
                ? { timestampWrites: { querySet: timing.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
                : {}),
        });
        if (timestamps) {
            encoder.resolveQuerySet(timing.set, 0, 2, timing.resolve, 0);
            encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
        }
        gpu.device.queue.submit([encoder.finish()]);
        if (timestamps) readTiming();
        else showTiming();
        for (const input of sliders) {
            const output = input.parentElement?.querySelector("output");
            if (output) output.textContent = input.value;
        }
    }

    if (gpu) {
        needEnvironment(root);
        onEnvironment((env) => {
            if (!env.sh) return;
            skyIrradiance = irradianceAt(env.sh, 1, env.scale);
            groundIrradiance = irradianceAt(env.sh, -1, env.scale);
            horizon = horizonLuminance(env.sh, env.scale);
            requestRender();
        });
        const sky0 = currentSky();
        if (sky0) requestRender();
        onChange(requestRender);
        onTables(requestRender);
        new ResizeObserver(requestRender).observe(canvas);
        for (const input of sliders) {
            paintRange(input);
            input.addEventListener("input", requestRender);
        }
        for (const input of root.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
            input.addEventListener("change", requestRender);
        }
        for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-weather"]`)) {
            input.addEventListener("change", () => changeWeather(input.value as WeatherName));
        }
        for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
            button.addEventListener("click", async () => {
                await navigator.clipboard.writeText(preset(button.dataset.copy ?? ""));
                button.textContent = "copied";
                setTimeout(() => (button.textContent = "copy"), 1200);
            });
        }
        for (const button of root.querySelectorAll<HTMLButtonElement>("button.view-toggle[data-field]")) {
            button.addEventListener("click", () => {
                button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
                requestRender();
            });
        }
        maybe("png")?.addEventListener("click", () => {
            render();
            const copy = document.createElement("canvas");
            Object.assign(copy, { width: canvas.width, height: canvas.height });
            const context = copy.getContext("2d");
            if (!context) return;
            context.drawImage(canvas, 0, 0);
            const scale = canvas.width / canvas.clientWidth;
            Object.assign(context, {
                font: `${12 * scale}px ${getComputedStyle(root).fontFamily}`,
                fillStyle: "rgb(255 255 255 / 0.85)",
                textAlign: "left",
                textBaseline: "bottom",
                shadowColor: "rgb(0 0 0 / 0.8)",
                shadowBlur: 3 * scale,
            });
            context.fillText(momentAndPlace(), 8 * scale, copy.height - 6 * scale);
            copy.toBlob((blob) => {
                if (!blob) return;
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = `himmelszelt-${root.id}-${momentStamp()}.png`;
                link.click();
                setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            });
        });
        lookAround(canvas, camera, { onChange: requestRender });
        requestRender();
    }
}
