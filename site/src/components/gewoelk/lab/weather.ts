import {
    cloudQuality,
    createLayeredCloudPass,
    type LayeredCloudPass,
    type LayeredQuality,
    type LayeredSky,
    type QualityLevel,
} from "@himmelszelt/gewoelk";
import { HDR, onTables, tables } from "../../dunstkreis/atmosphere";
import { createStarsRenderer, type FrameLight, skyAt } from "../../sternenheer/renderer";
import { bindStarGroups, offsetOf } from "../../sternenheer/stargroups";
import { state } from "../../sternzeit/state";
import { SHOW, type Shown, texturePanel } from "../textures";
import { composer } from "./composer";
import { createComposite } from "./composite";
import { designerHeight, designerKinds, designerOrbit, designerSwap, designerTime, PATCH } from "./designer";
import { type Design, KIND_VALUE, kindPresets, kindSource, type Place, placeOf, presetOf, skyFrom } from "./kinds";
import { createLab, type Lab, labPipeline } from "./lab";
import { cloudModel } from "./model";
import { routeTrails } from "./routes";
import shader from "./weather.comp.wgsl";

const DEG = Math.PI / 180;
type Rgb = [number, number, number];
// The sines of the heights under which the sun no longer lights the highest cloud, and the Moon none.
export const SUN_GONE = -0.11;
export const MOON_GONE = -0.05;
// The stops a moonlit night is drawn darker than the stars figure's meter exposes it, which does not see the clouds
// the Moon lights: in full for a sky of 0.01 to 0.3 cd/m², and not at all under 0.001, a moonless night, or over 3,
// the end of civil twilight.
const NIGHT_STOPS = 0.5;
export function nightStops(skyLuminance: number) {
    const decade = Math.log10(Math.max(skyLuminance, 1e-9));
    const ramp = (from: number, to: number) => Math.min(Math.max((decade - from) / (to - from), 0), 1);
    return NIGHT_STOPS * ramp(-3, -2) * (1 - ramp(-0.5, 0.5));
}

// The clouds' light, still a stand-in for dunstkreis' air: the sun's above the air, in lux, reddened by the air mass
// in its way, a clear sky's colors overhead and at the horizon, and the ground's share of what falls on it.
export const SUNLIGHT = 128000;
// The whole sky's light on a cloud: between the zenith's blue and the horizon's pale, and half of it gray.
export const OVERHEAD: Rgb = [0.39, 0.45, 0.6];
export const PALE: Rgb = [0.42, 0.58, 0.85];
export const GROUND_ALBEDO = 0.25;
const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
};
export function sunlightAt(altitudeKm: number, elevation: number, scale: number): Rgb {
    const sine = Math.sin(elevation);
    const mass = Math.exp(-altitudeKm / 8) / (Math.max(sine, 0) + 0.035);
    const up = smoothstep(-0.07, 0.02, sine + 0.012 * Math.sqrt(Math.max(altitudeKm, 0)));
    return [0.085, 0.15, 0.33].map((k) => SUNLIGHT * Math.exp(-k * mass) * up * scale) as Rgb;
}
// The meter exposes for the sky and does not see the clouds. Lit by a sun that has set for the ground, they are many
// times as bright as the sky behind them: what a cloud sends back of the light on it, how many times as bright as the
// sky the clouds may be before the frame is drawn darker for them, and the most stops it is.
const CLOUD_ALBEDO = 0.6;
const CLOUDS_OVER_SKY = 6;
export const CLOUD_STOPS = 6;
type Lit = { coverage: number; illuminance: Rgb };
/** The luminance of the brightest of `clouds`, each of `coverage` under `illuminance` lux, in cd/m². */
export const brightest = (clouds: readonly Lit[]) =>
    Math.max(
        0,
        ...clouds.map(({ coverage, illuminance: [r, g, b] }) => {
            const lux = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            return (Math.min(coverage, 1) * CLOUD_ALBEDO * lux) / Math.PI;
        }),
    );
/** The stops a frame is drawn darker for `clouds` over a sky of `skyLuminance`. */
const cloudStops = (clouds: readonly Lit[], skyLuminance: number) =>
    Math.min(Math.max(Math.log2(brightest(clouds) / (CLOUDS_OVER_SKY * skyLuminance)), 0), CLOUD_STOPS);
// A designer's frame is its cloud, seen from above with no sky for the meter: where the Sun's or the Moon's light on the
// cloud outshines the sky, the frame is exposed for the cloud, which then shows this bright before the tone curve.
export const PATCH_WHITE = 0.9;
// And its ground is a stage: drawn this much darker than the air shows it, so a thin sheet of cloud, which sends back
// no more light than pale ground does, stands out against it.
export const PATCH_GROUND = 0.35;
// Seen from above, the thin sheet of high cloud sends back a fraction of what a thick cloud does: its frame is exposed
// this many stops brighter, and its ground drawn as much darker again.
const PATCH_SHEET_STOPS = 1.5;
export const lit = (color: Rgb, luminance: number): Rgb => {
    const own = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    return color.map((c) => (c * luminance) / own) as Rgb;
};

// A designer's patch: where its clouds thin out, as a share of its radius, the field of view it is seen by, and how many
// times its radius the air's fade and the march's reach are, so that neither hides a patch seen from far above.
export const PATCH_FROM = 0.85;
export const PATCH_FOV = 40;
export const PATCH_AIR = 400;
const PATCH_REACH = 5;
// What a designer's gallery shows of a texture: its name, how it is shown, the share of a tile across, 0 for all, and
// what it holds as its tooltip.
type Asset = [label: string, mode: number, at: number, title: string, scale?: number];
const HIGH_ASSETS: Asset[] = [
    ["puffs", SHOW.red, 0.125, "An eighth of a tile across: the puffs and their trails, as a height."],
    ["veil", SHOW.green, 0.25, "A quarter of a tile across: the veil with its striations, ribs and trails."],
    [
        "broad field",
        SHOW.blue,
        0,
        "The whole tile: a broad field, read again at other sizes for the sheet's patches, bands and flakes.",
    ],
    [
        "fine noise",
        SHOW.alpha,
        0.25,
        "A quarter of a tile across: the noise the billows eat into the puffs by, and the veil's fibers are drawn from, read per pixel at a far smaller size.",
    ],
];
const HEIGHTS: Asset = [
    "heights",
    SHOW.red,
    0,
    "One tile from above, north up: how much of the layer's depth each column of cloud fills.",
];
const STEEPNESS: Asset = [
    "steepness",
    SHOW.alpha,
    0,
    "How steep the columns' tops are, per km: by it the march turns a height over a top into a distance from it.",
    0.25,
];
const ANVILS: Asset = ["anvils", SHOW.green, 0, "The skirts of the anvils around the tallest towers, frayed."];
const SHIELD: Asset = ["shade", SHOW.blue, 0, "How far a front shades what lies under it."];
const LAYER_ASSETS: Record<Exclude<Design, "high">, Asset[]> = {
    low: [HEIGHTS, STEEPNESS],
    towers: [HEIGHTS, ANVILS, STEEPNESS],
    front: [HEIGHTS, ANVILS, SHIELD, STEEPNESS],
    middle: [HEIGHTS, STEEPNESS],
};
// What a designer's textures make together, from above over its patch, where they are composed before the march.
const COMPOSED: Partial<Record<Design, [label: string, title: string]>> = {
    towers: [
        "towers under their anvils",
        "The patch from above, north up: the columns the march finds, each as tall as its height, under the anvils' thin ice.",
    ],
    front: [
        "wall, shield and anvils",
        "The patch from above, north up: the front's columns, each as tall as its height, under the anvils' thin ice.",
    ],
    high: [
        "the sheet's density",
        "The patch from above, north up: the density every pixel's read composes, the puffs kept where the broad field leaves patches and flakes, eaten by the billows, with the veil in its fibers.",
    ],
};
const LAYER_INDEX = { low: 0, deep: 1, middle: 2 } as const;
// A designer's thumbnails, in texels across.
export const ASSET_SIZE = 256;

/**
 * The whole-sky research figure on `root`, a `figure[data-weather-lab]`: gewoelk's layered clouds, three marched
 * layers and a sheet of high cloud, over dunstkreis' sky with sternenheer's stars and nachtgestirn's Moon, exposed by
 * the stars figure's meter. The clouds' light is still a stand-in, the sun's by day and the Moon's share of it by
 * night, with the real sky's luminance for their ambient light. Its weather is composed, see `composer.ts`. Also the
 * designers' figure, a `figure[data-cloud-designer]` whose `data-design` names what it designs: a patch of that place
 * of the sky alone, seen from a camera that orbits it, at a time of day of its own, with the library's kinds of cloud
 * and the reader's own as presets, its map and its model beside it, and its numbers to copy as a kind.
 */
export async function weatherFigure(root: HTMLElement) {
    let draw: (lab: Lab) => void = () => {};
    const design = root.dataset.design as Design | undefined;
    const designed = design && placeOf(design);
    const orbit = design && designerOrbit(design);
    const time = design && designerTime(root, () => lab?.request());
    const lookAt = orbit && designerHeight(root, orbit, () => lab?.request());
    if (design) designerSwap(root);
    const lab = createLab(root, (current) => draw(current), {
        presets: designed ? kindPresets(designed) : {},
        camera: { yaw: 230 * DEG, pitch: 16 * DEG, fov: (design ? PATCH_FOV : 95) * DEG },
        ...(orbit && { orbit }),
        ...(time && { speed: time.speed }),
    });
    if (!lab) return;
    const { device } = lab;
    const compose = await labPipeline(device, "weatherCompose", shader, "weatherCompose");
    if (!compose) return;
    const renderer = createStarsRenderer(device, () => lab.request());
    const textures = texturePanel(root, device, design ? ASSET_SIZE : undefined, () => lab?.request());
    // Towers, a front and the sheet are made of several textures: a designer shows what they make together.
    const composite = design && COMPOSED[design] ? await createComposite(device) : null;
    lab.timed = textures.refresh;
    const dimmed = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    let over: GPUTexture | null = null;
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();
    let exposure = "";
    let darker = 0;
    let bake = 0;
    // Timestamps for the passes named, each under the key the library asks for it by.
    const stamped = <K extends string>(names: Record<K, string>) =>
        Object.fromEntries(
            Object.entries<string>(names).flatMap(([key, name]) => {
                const writes = lab.timer.writes(name);
                return writes ? [[key, writes]] : [];
            }),
        ) as Partial<Record<K, GPUComputePassTimestampWrites>>;
    bindStarGroups(root, () => lab.request(), false);

    // The contrails: in the whole sky those over the invented routes, and in the high sheet's designer one across the
    // patch, as old at its far end as the trail lasts, so its whole life shows in the patch's width.
    const YOUNG_KM = 0.03;
    const trails = (wind: readonly [number, number], centerKm: readonly [number, number], radiusKm: number) => {
        const air = {
            persistenceS: 60 * lab.value("contrail.minutes"),
            spreadMps: lab.value("contrail.spread"),
            opticalDepth: lab.value("contrail.depth"),
            wind,
        };
        if (!designed) return lab.pressed("contrails.on") ? routeTrails(lab.clock, air) : [];
        if (designed !== "high" || !(air.opticalDepth > 0)) return [];
        const [east, north] = [0.94 * 0.8 * radiusKm, 0.34 * 0.8 * radiusKm];
        return [
            {
                fromKm: [centerKm[0] + east, centerKm[1] + north] as const,
                toKm: [centerKm[0] - east, centerKm[1] - north] as const,
                fromWidthKm: YOUNG_KM,
                toWidthKm: YOUNG_KM + (air.spreadMps * air.persistenceS) / 1000,
                opticalDepth: air.opticalDepth,
            },
        ];
    };

    // The pass of the chosen quality and options, made when it is first asked for: its maps' sizes, its steps, god rays and
    // the adaptive stride are fixed at creation. Blue noise and the box filter are switched from frame to frame.
    const passes = new Map<string, LayeredCloudPass | Promise<LayeredCloudPass>>();
    // The figure's dials of quality, gewoelk's: a designer has none and is "medium".
    const level = (dial: string) => (lab.choice(dial) || "medium") as QualityLevel;
    const quality = (): LayeredQuality => {
        const chosen = cloudQuality({ sampling: level("sampling") }).layered;
        // A designer keeps the maps it does not show small.
        if (!designed) return chosen;
        return { ...chosen, mapSize: designed === "high" ? 64 : 512, ...(designed !== "high" && { highMapSize: 256 }) };
    };
    // The reach sets the sliders it stands for, which stay the reader's to move.
    const reach = (eased: boolean) => {
        const { clearing, march } = cloudQuality({ reach: level("reach") });
        const values = { clearing: clearing.clearingKm, clearFrom: clearing.clearingFromKm, reachKm: march.reachKm };
        lab.apply("reach", values, eased);
    };
    const reaches = root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-reach"]`);
    for (const input of reaches) input.addEventListener("change", () => reach(true));
    if (reaches.length > 0) reach(false);
    const clouds = () => {
        const chosen = quality();
        const godRays = lab.pressed("rays.on");
        const adaptiveStride = lab.pressed("stride.adaptive");
        const key = JSON.stringify([chosen, godRays, adaptiveStride]);
        const made = passes.get(key);
        if (made && !(made instanceof Promise)) return made;
        if (!made) {
            const making = createLayeredCloudPass(device, {
                format: "rgba16float",
                toneMap: false,
                background: false,
                quality: chosen,
                godRays,
                adaptiveStride,
            });
            passes.set(key, making);
            making.then((pass) => {
                passes.set(key, pass);
                lab.request();
            });
        }
        return null;
    };

    /** The sky as the sliders have it: every place of it, or in a designer the one it designs. */
    const sky = (): LayeredSky => {
        const held = skyFrom(lab.value, lab.choice("kind1") === KIND_VALUE.front ? "front" : "towers");
        for (const place of Object.keys(held) as Place[]) if (designed && place !== designed) held[place].coverage = 0;
        return held;
    };
    const model = design ? cloudModel(root, design) : null;
    if (design)
        designerKinds(
            root,
            design,
            lab,
            () => sky()[placeOf(design)],
            (numbers) => presetOf(placeOf(design), numbers),
        );
    else composer(root, lab, (place) => sky()[place]);
    // A designer's numbers as they stand, as a kind of cloud to paste into the library's `CLOUD_TYPES`.
    const copy = root.querySelector<HTMLButtonElement>("button[data-copy-kind]");
    if (designed)
        copy?.addEventListener("click", async () => {
            await navigator.clipboard.writeText(kindSource(sky(), designed));
            copy.textContent = "copied";
            setTimeout(() => (copy.textContent = "copy"), 1200);
        });

    lab.status = () => {
        const ms = (name: string) => (lab.timer.ms[name] === undefined ? "?" : lab.timer.ms[name]?.toFixed(2));
        const rays = over
            ? `${Math.round(over.width * quality().scale)} x ${Math.round(over.height * quality().scale)} rays`
            : "";
        // A frame without a bake times none: the last one's stays.
        bake = lab.timer.ms.bake || bake;
        return `${rays}, march ${ms("march")} ms, sheet ${ms("sheet")} ms, bake ${bake.toFixed(2)} ms on the GPU${exposure}`;
    };

    draw = () => {
        const table = tables();
        const pass = clouds();
        if (!table || !pass) return;
        // A designer's patch: its clouds alone about the point the camera orbits, at the middle of their height.
        const held = sky();
        const patch = design && PATCH[design];
        if (designed && orbit && patch) {
            const bearing = held.deep.frontBearing * DEG;
            orbit.center.east = patch.aheadKm * Math.sin(bearing);
            orbit.center.north = patch.aheadKm * Math.cos(bearing);
            const place = held[designed];
            orbit.heightKm = "altitudeKm" in place ? place.altitudeKm : place.baseKm + place.depthKm / 2;
            model?.update(place, lab.value("wind.from"), lab.value("wind.speed"));
            lookAt?.sync();
        }
        const { width, height, dpr, heightM, headroom, inverseViewProjection, projectionDistance } = lab.size();
        if (over?.width !== width || over.height !== height) {
            over?.destroy();
            over = device.createTexture({ size: [width, height], format: "rgba16float", usage });
        }
        const layer = over;
        const seen = skyAt(time ? time.jd(lab.clock) : state.jd, { ...state, heightM }, table.luts.model);
        // Where the patch lies from the camera, and how far it reaches.
        const centerKm: [number, number] =
            orbit && patch ? [orbit.center.east - lab.flown.east, orbit.center.north - lab.flown.north] : [0, 0];
        const radiusKm = patch?.radiusKm ?? 0;

        // The clouds over the frame: lit by the Sun while it reaches the highest of them, by the Moon after.
        const overFrame = (encoder: GPUCommandEncoder, exposed: GPUTexture, target: GPUTexture, light: FrameLight) => {
            const sunUp = seen.sunDirection[2] > SUN_GONE;
            const moonUp = seen.moonDirection[2] > MOON_GONE;
            const scale = sunUp ? 1 : moonUp ? seen.moonIlluminance / SUNLIGHT : 0;
            const sun = sunUp || !moonUp ? seen.sunDirection : seen.moonDirection;
            const luminance = Math.max(light.skyLuminance, 1e-6);
            const onGround = sunlightAt(0, Math.asin(Math.min(Math.max(sun[2], -1), 1)), scale);
            const fromSky = lit(OVERHEAD, luminance * Math.PI);
            const windTo = (lab.value("wind.from") + 180) * DEG;
            const wind = [
                Math.sin(windTo) * lab.value("wind.speed"),
                Math.cos(windTo) * lab.value("wind.speed"),
            ] as const;
            // Each place's clouds by the sun's light on their tops: by night the meter has the Moon's sky right.
            const elevation = Math.asin(Math.min(Math.max(sun[2] ?? 0, -1), 1));
            const tops = [held.low, held.deep, held.middle].map((layer) => ({
                coverage: layer.coverage,
                illuminance: sunlightAt(layer.baseKm + layer.depthKm, elevation, scale),
            }));
            const highest = {
                coverage: held.high.coverage,
                illuminance: sunlightAt(held.high.altitudeKm, elevation, scale),
            };
            const sunlit = sunUp ? cloudStops([...tops, highest], luminance) : 0;
            darker = Math.max(nightStops(light.skyLuminance), sunlit);
            if (designed) {
                const cloud = brightest([...tops, highest].map((lit) => ({ ...lit, coverage: 1 })));
                const thin = designed === "high" ? PATCH_SHEET_STOPS : 0;
                const stops = Math.log2(Math.max(cloud, 1e-9) / (1.2 * 2 ** light.ev100 * PATCH_WHITE)) - thin;
                const outshines = Math.min(Math.max(Math.log2(Math.max(cloud, 1e-9) / luminance) / 2, 0), 1);
                darker += (Math.min(Math.max(stops, -CLOUD_STOPS), CLOUD_STOPS) - darker) * outshines;
            }
            const stage = designed ? PATCH_GROUND * (designed === "high" ? 2 ** -PATCH_SHEET_STOPS : 1) : 1;
            device.queue.writeBuffer(dimmed, 0, new Float32Array([2 ** -darker, stage]));
            pass.update(
                {
                    weather: held,
                    wind,
                    highWind: wind,
                    shear: lab.value("shear"),
                    evolution: cloudQuality({ motion: level("motion") }).evolves ? lab.value("change") : 0,
                    evolutionEveryS: cloudQuality({ motion: level("motion") }).evolutionEveryS,
                    evolutionOffset: lab.value("phase"),
                    seed: lab.value("seed"),
                    clearingKm: patch ? radiusKm : lab.value("clearing"),
                    clearingFromKm: patch ? PATCH_FROM * radiusKm : lab.value("clearFrom"),
                    clearingCenterKm: centerKm,
                    timeS: lab.clock,
                    contrails: trails(wind, centerKm, radiusKm),
                    observerKm: [lab.flown.east, lab.flown.north],
                    march: {
                        stepKm: lab.value("stepKm"),
                        stepGrowth: lab.value("stepGrowth"),
                        reachKm: patch ? PATCH_REACH * radiusKm : lab.value("reachKm"),
                        fadeKm: patch ? PATCH_AIR * radiusKm : lab.value("fadeKm"),
                        noiseKm: lab.value("noiseKm"),
                        multiScatter: lab.value("multiple"),
                        ambient: lab.value("ambient"),
                        blueNoise: lab.pressed("noise.blue"),
                    },
                    boxFilter: lab.pressed("filter.box"),
                    sunDirection: [sun[0] ?? 0, sun[1] ?? 0, sun[2] ?? 1],
                    sunIlluminance: onGround,
                    sunlightAt: (altitudeKm, elevation) => sunlightAt(altitudeKm, elevation, scale),
                    skyIrradiance: fromSky,
                    horizonLuminance: lit(PALE, luminance),
                    groundIrradiance: onGround.map(
                        (e, i) => GROUND_ALBEDO * (e * Math.max(sun[2] ?? 0, 0) + (fromSky[i] ?? 0)),
                    ) as Rgb,
                    observerHeightM: heightM,
                    inverseViewProjection,
                    projectionDistance,
                    ev100: light.ev100,
                },
                encoder,
                { timestampWrites: stamped({ maps: "maps", highMap: "bake" }) },
            );
            pass.encode(encoder, layer, { timestampWrites: stamped({ march: "march", high: "sheet" }) });
            let output = outputs.get(target);
            if (!output) {
                output = device.createBindGroup({
                    layout: compose.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: target.createView() }],
                });
                outputs.set(target, output);
            }
            const composing = encoder.beginComputePass({ label: "weatherLab:compose" });
            composing.setPipeline(compose);
            composing.setBindGroup(
                0,
                device.createBindGroup({
                    layout: compose.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: { buffer: lab.view } },
                        { binding: 1, resource: exposed.createView() },
                        { binding: 2, resource: layer.createView() },
                        { binding: 3, resource: { buffer: dimmed } },
                    ],
                }),
            );
            composing.setBindGroup(1, output);
            composing.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            composing.end();
            const channels = "Red is the column's value.";
            const maps: Shown[] = [
                {
                    label: "low map",
                    title: `The low layer's map, one tile from above, north up. ${channels}`,
                    texture: pass.layers.maps,
                    kind: "array",
                    at: 0,
                    mode: SHOW.red,
                    ms: () => lab.timer.ms.maps,
                },
                {
                    label: "deep map",
                    title: `The deep layer's map: towers, or a front from its leading edge at the left to its back. ${channels}`,
                    texture: pass.layers.maps,
                    kind: "array",
                    at: 1,
                    mode: SHOW.red,
                    ms: () => lab.timer.ms.maps,
                },
                {
                    label: "middle map",
                    title: `The middle layer's map. ${channels}`,
                    texture: pass.layers.maps,
                    kind: "array",
                    at: 2,
                    mode: SHOW.red,
                    ms: () => lab.timer.ms.maps,
                },
                {
                    label: "high map",
                    title: "The high sheet's baked map, in the wind's frame: its puffs and their trails as a height.",
                    texture: pass.high.map,
                    kind: "2d",
                    mode: SHOW.red,
                    ms: () => lab.timer.ms.bake,
                },
            ];
            // A designer shows what its place is rendered from: its map channel by channel, and the noise read per sample.
            const shown = (from: Omit<Shown, "label" | "title">, assets: Asset[]) =>
                assets.map(([label, mode, at, title, scale = 1]) => ({ ...from, label, mode, at, title, scale }));
            const sheet = {
                texture: pass.high.map,
                kind: "2d" as const,
                group: "the sheet's map",
                ms: () => lab.timer.ms.bake,
            };
            const layerMap = {
                texture: pass.layers.maps,
                kind: "array" as const,
                group: "the layer's map",
                ms: () => lab.timer.ms.maps,
                timed: "all three layers",
            };
            const own: Shown[] =
                !design || !designed
                    ? []
                    : design === "high" || designed === "high"
                      ? shown(sheet, HIGH_ASSETS)
                      : [
                            ...shown(layerMap, LAYER_ASSETS[design]).map((asset) => ({
                                ...asset,
                                at: LAYER_INDEX[designed],
                            })),
                            {
                                label: "a level slice",
                                group: "detail noise",
                                title: "A level slice of the volume of noise that heaps the clouds' surfaces out, read at every step of the march: made once, and tiled. The stack beside it picks another slice.",
                                texture: pass.layers.detail,
                                kind: "3d",
                                mode: SHOW.blue,
                                at: 0.5,
                                slices: 16,
                            },
                        ];
            if (composite && design && designed) {
                composite.encode(
                    encoder,
                    pass,
                    designed === "high" ? null : LAYER_INDEX[designed],
                    centerKm,
                    2 * radiusKm,
                );
                const [label, title] = COMPOSED[design] ?? ["", ""];
                const drawn = designed === "high" ? "per pixel, not stored" : "per step, not stored";
                const together = { label, title, drawn, group: "together", texture: composite.texture };
                own.push({ ...together, kind: "2d", mode: SHOW.red });
            }
            textures.show(designed ? own : maps);
            textures.encode(encoder, Boolean(designed) || lab.pressed("textures.on"));
            lab.timer.resolve(encoder);
        };
        const drawn = renderer.draw(lab.target(), {
            sky: seen,
            luts: table.luts,
            format: HDR,
            headroom,
            toneMap: "neutral",
            width,
            height,
            inverseViewProjection,
            projectionDistance,
            pixelRatio: dpr,
            ev100: null,
            stars: offsetOf(root, "stars").light > 0,
            faintStars: true,
            deepStars: false,
            milkyWay: offsetOf(root, "milkyWay").light > 0,
            starCompensation: offsetOf(root, "stars").stops,
            milkyWayCompensation: offsetOf(root, "milkyWay").stops,
            maps: "auto",
            air: true,
            twinkle: false,
            time: 0,
            glare: true,
            darkAdapted: false,
            moon: true,
            constellations: [],
            ground: lab.pressed("ground.grid") ? lab.flown : null,
            over: overFrame,
        });
        if (!drawn) return;
        lab.present();
        exposure = `, exposed at EV100 ${(drawn.ev100 + darker).toFixed(1)}`;
        lab.timer.read();
        // The exposure follows its meter slowly: frames asked for while it moves, none once it has arrived.
        if (drawn.adapting) requestAnimationFrame(() => lab.request());
    };
    onTables(() => lab.request());
    lab.request();
}
