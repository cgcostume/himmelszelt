import type { AtmosphereLUTs, AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import {
    apparentDirection,
    clampObserverHeight,
    createSkyPass,
    DEFAULT_AUTO_EXPOSURE_KEYS,
    refractionAngle,
} from "@himmelszelt/dunstkreis";
import type { CloudParams, CloudPass, LayerMotion, Weather, WeatherName } from "@himmelszelt/gewoelk";
import {
    continuedMotion,
    createCloudPass,
    DEFAULT_CLOUDSCAPE,
    DEFAULT_SHEET,
    SUNLIGHT_ENTRIES,
    WEATHER,
} from "@himmelszelt/gewoelk";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import {
    bindHdr,
    configureCanvas,
    currentSky,
    displayOutput,
    gpuDevice,
    needEnvironment,
    onDisplay,
    onEnvironment,
    onTables,
    quality,
    SDR,
    gpu as shared,
    skyViewChanged,
    tables,
} from "../dunstkreis/atmosphere";
import { flightIn } from "../dunstkreis/flight";
import { groundGrid } from "../dunstkreis/groundgrid";
import { type Basis, cameraBasis, lookAround, project } from "../dunstkreis/skycamera";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { COMPASS } from "../sternzeit/figure";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";
import { skyWhite } from "../white";
import { changeLab } from "./change";
import { SHOW, texturePanel } from "./textures";

const DEG = Math.PI / 180;
// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
// A stop more than the clear sky's meter, as a photographer exposes for clouds: metered, a cloudy sky comes out gray.
const CLOUD_COMPENSATION = 1;
// Seconds since J2000 drive the wind and the evolution: any epoch does, the same every frame.
// How far the aerial perspective volume reaches, in km: past the horizon to the top of the clouds, `CLOUD_TOP_KM`, as seen
// from `heightM` up, in steps of doubling from 400 km, so the sky pass is not made again for every meter climbed. Beyond
// its reach the volume holds its last slice, and a cloud farther off would show darker by a sharp edge.
const CLOUD_TOP_KM = 10;
const AERIAL_LEAST_KM = 400;
function aerialReach(heightM: number, radiusKm: number) {
    const beyond = (heightKm: number) => Math.sqrt(Math.max((radiusKm + heightKm) ** 2 - radiusKm ** 2, 0));
    const farthest = beyond(Math.max(heightM, 0) / 1000) + beyond(CLOUD_TOP_KM);
    return AERIAL_LEAST_KM * 2 ** Math.max(0, Math.ceil(Math.log2(farthest / AERIAL_LEAST_KM)));
}
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
        return { device: gpuDevice(), context, format: SDR, adapterName: shared.adapterName };
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
    let sky: { pass: SkyPass; luts: AtmosphereLUTs; reach: number } | null = null;
    let skyBuilding: { luts: AtmosphereLUTs; reach: number } | null = null;
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
    // The sun's light aloft comes from gewoelk's own table, through dunstkreis' air; with the sun switched off, none.
    const noSunlight = Array.from({ length: 4 * SUNLIGHT_ENTRIES }, (): [number, number, number] => [0, 0, 0]);
    const requestRender = onDemand(render, root);
    // The cloud pass reads the tables it was made with: a new set makes a new pass.
    const lutIds = new WeakMap<AtmosphereLUTs, number>();
    let lutCount = 0;
    function lutsId(luts: AtmosphereLUTs): number {
        if (!lutIds.has(luts)) lutIds.set(luts, ++lutCount);
        return lutIds.get(luts) ?? 0;
    }

    function buildSky(luts: AtmosphereLUTs, reach: number) {
        if (!gpu || (skyBuilding?.luts === luts && skyBuilding.reach === reach)) return;
        const building = { luts, reach };
        skyBuilding = building;
        createSkyPass(gpu.device, {
            luts,
            format: "rgba32float",
            toneMap: false,
            autoExposure: false,
            groundLight: quality.groundLight,
            dither: false,
            // No veil of a Sun the clouds may hide.
            veil: 0,
            // The air in front of the clouds, out to the farthest cloud in sight.
            aerialPerspective: { maxDistanceKm: reach },
        }).then((pass) => {
            if (skyBuilding !== building) return pass.destroy();
            sky?.pass.destroy();
            sky = { pass, luts, reach };
            skyBuilding = null;
            skyViewFor = "";
            requestRender();
        });
    }
    function buildClouds(
        key: string,
        scale: number,
        maxSteps: number,
        grid: { layers: number; size?: number },
        luts: AtmosphereLUTs,
        keyframes = false,
        output: { format: GPUTextureFormat; headroom: number } = { format: SDR, headroom: 1 },
    ) {
        if (!gpu || cloudsBuilding === key) return;
        cloudsBuilding = key;
        const { atmosphereBuffer, transmittance, sampler, model } = luts;
        const atmosphere = {
            atmosphereBuffer,
            transmittance,
            sampler,
            apparentElevation: (altitudeKm: number, elevation: number) => lifted(model, altitudeKm, elevation),
        };
        // On an HDR display into the page's headroom, dithered only in 8 bits.
        const { format, headroom } = output;
        const dither = format === SDR;
        const options = { format, headroom, dither, scale, maxSteps, grid, atmosphere, keyframes, ...lab?.created };
        createCloudPass(gpu.device, options).then((pass) => {
            if (cloudsBuilding !== key) return pass.destroy();
            clouds?.pass.destroy();
            clouds = { pass, key };
            lab?.reset(pass);
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
        if (lab) {
            note.textContent = gpu.adapterName ?? "";
            return;
        }
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

    const textures = gpu ? texturePanel(root, gpu.device) : null;
    const groundPass = gpu ? groundGrid(gpu.device) : null;
    // Flight, and the height and the place over the ground the figure is seen from: its own, no other figure follows.
    const { flown, height: heightM } = flightIn(root, canvas, camera, () => requestRender());
    // Each layer's motion as last drawn: a new wind or evolution goes on from where the clouds stand.
    const motions: (LayerMotion | undefined)[] = [];
    function moving(layer: number, wind: [number, number], evolution: number, timeS: number): LayerMotion {
        const last = motions[layer];
        const next = { wind, evolution };
        const same = last && last.wind[0] === wind[0] && last.wind[1] === wind[1] && last.evolution === evolution;
        if (!same) motions[layer] = last ? { ...next, ...continuedMotion(last, next, timeS) } : next;
        // Flown over: the clouds lie as far back as the observer has come, their own motion as it was.
        const motion = motions[layer] as LayerMotion;
        const [east, north] = motion.driftOffsetKm ?? [0, 0];
        return { ...motion, driftOffsetKm: [east - flown.east, north - flown.north] };
    }

    // The lab's weather cycle: the next preset, its button checked as a click would.
    function nextWeather() {
        const choices = [...root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-weather"]`)];
        const next = choices[(choices.findIndex((input) => input.checked) + 1) % choices.length];
        if (!next) return;
        next.checked = true;
        changeWeather(next.value as WeatherName);
    }
    // With `data-lab`, the figure's lab: a clock of its own, the cloudscape by keyframes, and what each part costs.
    const lab =
        gpu && root.hasAttribute("data-lab")
            ? changeLab(root, gpu.device, { requestRender, nextWeather, timed: () => textures?.refresh() })
            : null;

    function cloudParams(): Partial<CloudParams> {
        const timeS = seconds() + (lab?.clock.seconds ?? 0);
        const windOf = (speed: number, azimuth: number): [number, number] => [
            speed * Math.sin(azimuth * DEG),
            speed * Math.cos(azimuth * DEG),
        ];
        const sunOn = pressed("light.sun");
        const ambientOn = pressed("light.ambient");
        return {
            sunIlluminance: sunOn ? sunIlluminance : [0, 0, 0],
            sunlight: sunOn ? null : noSunlight,
            skyIrradiance: ambientOn ? skyIrradiance : [0, 0, 0],
            groundIrradiance: ambientOn ? groundIrradiance : [0, 0, 0],
            horizonLuminance: horizon,
            ev100: ev100 - CLOUD_COMPENSATION,
            timeS,
            cloudscape: {
                ...DEFAULT_CLOUDSCAPE,
                enabled: pressed("cloudscape.enabled"),
                coverage: slider("cloudscape.coverage"),
                sharpness: slider("cloudscape.sharpness"),
                baseKm: slider("cloudscape.baseKm"),
                heightKm: slider("cloudscape.heightKm"),
                offset: slider("cloudscape.offset"),
                ...moving(
                    0,
                    windOf(slider("cloudscape.windSpeed"), slider("cloudscape.windFrom") + 180),
                    slider("cloudscape.evolution"),
                    timeS,
                ),
                clearingKm: slider("cloudscape.clearingKm"),
                clearingFromKm: slider("cloudscape.clearingFromKm"),
                variation: slider("cloudscape.variation"),
                towers: slider("cloudscape.towers"),
                extinction: slider("cloudscape.extinction"),
                size: slider("cloudscape.size"),
                towerScale: slider("cloudscape.towerScale"),
                billows: slider("cloudscape.billows"),
                detailShiftKm: lab?.clock.detailShiftKm ?? 0,
                multiScatter: pressed("light.multi") ? DEFAULT_CLOUDSCAPE.multiScatter : 0,
            },
            sheets: [
                {
                    ...DEFAULT_SHEET,
                    enabled: pressed("sheet.enabled"),
                    coverage: slider("sheet.coverage"),
                    altitudeKm: slider("sheet.altitudeKm"),
                    opticalDepth: slider("sheet.opticalDepth"),
                    ...moving(
                        1,
                        windOf(slider("sheet.windSpeed"), slider("sheet.windFrom") + 180),
                        DEFAULT_SHEET.evolution,
                        timeS,
                    ),
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
        const reach = aerialReach(heightM(), table.luts.model.planet.groundRadiusKm);
        if (sky?.luts !== table.luts) {
            buildSky(table.luts, reach);
            return;
        }
        // A new reach keeps the sky it has until the next one is made.
        if (sky.reach !== reach) buildSky(table.luts, reach);
        const scale = Number(choice("scale")) || 1;
        const maxSteps = Number(choice("steps")) || 128;
        const layers = Number(choice("layers")) || 64;
        const grid = lab ? { layers, size: lab.gridSize } : { layers };
        const output = displayOutput();
        const key = `${scale},${maxSteps},${layers},${lutsId(table.luts)},${lab?.keyframes},${lab?.gridSize},${output.format},${output.headroom}`;
        if (clouds?.key !== key) {
            buildClouds(key, scale, maxSteps, grid, table.luts, lab?.keyframes, output);
            return;
        }
        if (output.format !== gpu.format) {
            configureCanvas(gpu.context, output.format);
            gpu.format = output.format;
        }
        lab?.tick();
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
        const observerHeightM = clampObserverHeight(heightM());
        const basis = cameraBasis(camera, width / height);
        const ivp = inverseViewProjection(basis);
        sky.pass.update({
            sunDirection,
            sunAngularDiameter,
            observerHeightM: heightM(),
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
        const skyViewKey = `${state.jd},${state.latitude},${state.longitude},${heightM()},${sky.luts === table.luts}`;
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
            // Once, by the pass that composes the clouds over the sky and finishes the frame.
            whiteBalance: skyWhite(sunDirection),
        };
        const encoder = gpu.device.createCommandEncoder({ label: "sternwarte:clouds" });
        if (lab) lab.update(clouds.pass, params, encoder);
        else clouds.pass.update(params);

        placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
        sky.pass.encode(encoder, background);
        // The ground's grid, drawn onto the sky's ground before the clouds are composed over it.
        const radiusKm = table.luts.model.planet.groundRadiusKm;
        const behind =
            groundPass && pressed("ground.grid")
                ? groundPass.encode(encoder, background, {
                      inverseViewProjection: ivp,
                      projectionDistance: basis.d,
                      heightM: observerHeightM,
                      radiusKm,
                      flown,
                  })
                : background;
        // The air in front of the clouds from dunstkreis' volume, or, chosen so, a blend into the sky behind them.
        const aerialPerspective = choice("air") === "volume" ? sky.pass.aerialPerspective : null;
        const timestamps = timing && !timing.busy && !lab;
        clouds.pass.encode(encoder, gpu.context.getCurrentTexture(), {
            background: behind,
            ...(aerialPerspective ? { aerialPerspective } : {}),
            ...lab?.march(),
            ...(timestamps
                ? { timestampWrites: { querySet: timing.set, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
                : {}),
        });
        if (timestamps) {
            encoder.resolveQuerySet(timing.set, 0, 2, timing.resolve, 0);
            encoder.copyBufferToBuffer(timing.resolve, 0, timing.read, 0, 16);
        }
        lab?.finish(encoder);
        const { mapTexture, modelingTexture, lightTexture, ambientTexture, detailTexture } = clouds.pass;
        // In the lab, what each texture last took to compute.
        const took = (part: Parameters<NonNullable<typeof lab>["took"]>[0], timed = "") =>
            lab ? { ms: () => lab.took(part), timed } : {};
        textures?.show([
            {
                label: "cloud map",
                title: "The cloud map's red channel, one tile from above, north up: how tall each column of cloud is, after coverage and sharpness. Its other channels say which clouds are billowy and which frayed, hold the noise before shaping, which the march reads again to thin the clouds out far off, and mark where towers grow. Everything else is built from this map.",
                texture: mapTexture,
                kind: "array",
                mode: SHOW.red,
                ...took("map"),
            },
            {
                label: "cirrus map",
                title: "The high sheet's map: how much cirrus lies where, before its fibers are drawn in per pixel.",
                texture: mapTexture,
                kind: "array",
                at: 1,
                mode: SHOW.red,
                ...took("sheets"),
            },
            {
                label: "shape + distance",
                title: "An upright cut through the voxel volume, east to west: the modeling data. Inside a cloud, warm to white, how deep a point lies under the surface: the shape the detail noise erodes. Outside, in blues, the distance to the nearest cloud: how far a ray may step without missing one.",
                texture: modelingTexture,
                kind: "3d",
                at: -1,
                mode: SHOW.modeling,
                ...took("volume"),
            },
            {
                label: "light",
                title: "The same cut through the light grid: how much cloud lies between each voxel and the Sun, summed once per Sun position, bright where the Sun reaches and dark in shadow. The march reads it instead of marching a second ray towards the Sun.",
                texture: lightTexture,
                kind: "3d",
                at: -1,
                mode: SHOW.shade,
                scale: 8,
                channel: 1,
                ...took("light"),
            },
            {
                label: "sky's light",
                title: "The same cut through the ambient grid, at half the resolution: how much of the sky's light reaches a voxel through the clouds around it. A second channel holds the same for the ground's light from below. Together they give the clouds their gray undersides.",
                texture: ambientTexture,
                kind: "3d",
                at: -1,
                mode: SHOW.red,
                ...took("ambient"),
            },
            {
                label: "billows",
                title: "A level slice of the detail noise, a 3D texture that tiles: its coarse billows. At every sample the noise erodes the smooth voxel shape into a cloud's surface, rounding it into lumps.",
                texture: detailTexture,
                kind: "3d",
                at: 0.5,
                mode: SHOW.blue,
                ...took("detail", "once"),
            },
            {
                label: "wisps",
                title: "The same slice of the detail noise, its coarse wisps: where the air around eats into a cloud and leaves webs and curls. The map's type decides how much of each a cloud gets.",
                texture: detailTexture,
                kind: "3d",
                at: 0.5,
                mode: SHOW.red,
                ...took("detail", "once"),
            },
        ]);
        textures?.encode(encoder, pressed("textures.on"));
        gpu.device.queue.submit([encoder.finish()]);
        if (timestamps) readTiming();
        else showTiming();
        lab?.submitted();
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
        onDisplay(requestRender);
        bindHdr(find('[data-hdr="note"]', root), find('[data-hdr="choice"]', root));
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
