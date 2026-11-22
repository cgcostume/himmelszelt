import {
    createLayeredCloudPass,
    type LayeredCloudPass,
    type LayeredQuality,
    type LayeredSky,
} from "@himmelszelt/gewoelk";
import { HDR, onTables, tables } from "../../dunstkreis/atmosphere";
import { createStarsRenderer, type FrameLight, skyAt } from "../../sternenheer/renderer";
import { bindStarGroups, offsetOf } from "../../sternenheer/stargroups";
import { state } from "../../sternzeit/state";
import { SHOW, type Shown, texturePanel } from "../textures";
import { CIRRUS_PRESETS } from "./cirrus";
import { FORMATION_PRESETS } from "./formation";
import { type Design, KIND_VALUE, kindPresets, kindSource, type Place, placeOf, skyFrom } from "./kinds";
import { createLab, type Lab, labPipeline } from "./lab";
import shader from "./weather.comp.wgsl";

const DEG = Math.PI / 180;
type Rgb = [number, number, number];
// The sines of the heights under which the sun no longer lights the highest cloud, and the Moon none.
const SUN_GONE = -0.11;
const MOON_GONE = -0.05;
// The stops a moonlit night is drawn darker than the stars figure's meter exposes it, which does not see the clouds
// the Moon lights: in full for a sky of 0.01 to 0.3 cd/m², and not at all under 0.001, a moonless night, or over 3,
// the end of civil twilight.
const NIGHT_STOPS = 0.5;
function nightStops(skyLuminance: number) {
    const decade = Math.log10(Math.max(skyLuminance, 1e-9));
    const ramp = (from: number, to: number) => Math.min(Math.max((decade - from) / (to - from), 0), 1);
    return NIGHT_STOPS * ramp(-3, -2) * (1 - ramp(-0.5, 0.5));
}

// The clouds' light, still a stand-in for dunstkreis' air: the sun's above the air, in lux, reddened by the air mass
// in its way, a clear sky's colors overhead and at the horizon, and the ground's share of what falls on it.
const SUNLIGHT = 128000;
// The whole sky's light on a cloud: between the zenith's blue and the horizon's pale, and half of it gray.
const OVERHEAD: Rgb = [0.39, 0.45, 0.6];
const PALE: Rgb = [0.42, 0.58, 0.85];
const GROUND_ALBEDO = 0.25;
const smoothstep = (a: number, b: number, x: number) => {
    const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
    return t * t * (3 - 2 * t);
};
function sunlightAt(altitudeKm: number, elevation: number, scale: number): Rgb {
    const sine = Math.sin(elevation);
    const mass = Math.exp(-altitudeKm / 8) / (Math.max(sine, 0) + 0.035);
    const up = smoothstep(-0.07, 0.02, sine + 0.012 * Math.sqrt(Math.max(altitudeKm, 0)));
    return [0.085, 0.15, 0.33].map((k) => SUNLIGHT * Math.exp(-k * mass) * up * scale) as Rgb;
}
const lit = (color: Rgb, luminance: number): Rgb => {
    const own = 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
    return color.map((c) => (c * luminance) / own) as Rgb;
};

// How high a designer looks at the start, in degrees: at what it designs.
const PITCH: Record<Design, number> = { low: 16, towers: 14, front: 14, middle: 30, high: 48 };
// And which way, from north through east: a front's to where its front stands.
const YAW: Record<Design, number> = { low: 230, towers: 230, front: 20, middle: 230, high: 230 };
// The high sheet's map as its designer shows it, a channel each: the share of a tile across, 0 for all, and what it holds.
const HIGH_CHANNELS: [label: string, mode: number, at: number, title: string][] = [
    ["puffs", SHOW.red, 0.125, "Red, an eighth of a tile across: the puffs and their trails, as a height."],
    ["veil", SHOW.green, 0.25, "Green, a quarter of a tile across: the veil with its striations, ribs and trails."],
    ["broad field", SHOW.blue, 0, "Blue, the whole tile: a broad field, read again for the sheet's patches and bands."],
    ["billows", SHOW.alpha, 0.25, "Alpha, a quarter of a tile across: the noise the billows eat into the puffs by."],
];

/**
 * The whole-sky research figure on `root`, a `figure[data-weather-lab]`: gewoelk's layered clouds, three marched
 * layers and a sheet of high cloud, over dunstkreis' sky with sternenheer's stars and nachtgestirn's Moon, exposed by
 * the stars figure's meter. The clouds' light is still a stand-in, the sun's by day and the Moon's share of it by
 * night, with the real sky's luminance for their ambient light. Also the designers' figure, a
 * `figure[data-cloud-designer]` whose `data-design` names what it designs: that place of the sky alone, the library's
 * kinds of cloud for it as presets, its map alone in the panel, and its numbers to copy as a kind.
 */
export async function weatherFigure(root: HTMLElement) {
    let draw: (lab: Lab) => void = () => {};
    const design = root.dataset.design as Design | undefined;
    const designed = design && placeOf(design);
    const lab = createLab(root, (current) => draw(current), {
        presets: designed ? kindPresets(designed) : FORMATION_PRESETS,
        morePresets: designed ? {} : { sky: CIRRUS_PRESETS },
        camera: { yaw: (design ? YAW[design] : 230) * DEG, pitch: (design ? PITCH[design] : 16) * DEG, fov: 95 * DEG },
    });
    if (!lab) return;
    const { device } = lab;
    const compose = await labPipeline(device, "weatherCompose", shader, "weatherCompose");
    if (!compose) return;
    const renderer = createStarsRenderer(device, () => lab.request());
    const textures = texturePanel(root, device);
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

    // The pass of the chosen quality, made when it is first asked for: its maps' sizes and steps are fixed at creation.
    const passes = new Map<string, LayeredCloudPass | Promise<LayeredCloudPass>>();
    const quality = (): LayeredQuality => ({
        scale: Number(lab.choice("scale")) || 0.5,
        maxSteps: Number(lab.choice("steps")) || 128,
        // A designer keeps the maps it does not show small.
        mapSize: designed === "high" ? 64 : 512,
        highMapSize: designed && designed !== "high" ? 256 : Number(lab.choice("size")) || 2048,
    });
    const clouds = () => {
        const chosen = quality();
        const godRays = lab.pressed("rays.on");
        const key = JSON.stringify([chosen, godRays]);
        const made = passes.get(key);
        if (made && !(made instanceof Promise)) return made;
        if (!made) {
            const making = createLayeredCloudPass(device, {
                format: "rgba16float",
                toneMap: false,
                background: false,
                quality: chosen,
                godRays,
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
        const on = { low: "l0.enabled", deep: "l1.enabled", middle: "l2.enabled", high: "sheet.on" } as const;
        for (const place of Object.keys(on) as Place[])
            if (designed ? place !== designed : !lab.pressed(on[place])) held[place].coverage = 0;
        return held;
    };
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
        const { width, height, dpr, heightM, headroom, inverseViewProjection, projectionDistance } = lab.size();
        if (over?.width !== width || over.height !== height) {
            over?.destroy();
            over = device.createTexture({ size: [width, height], format: "rgba16float", usage });
        }
        const layer = over;
        const seen = skyAt(state.jd, { ...state, heightM }, table.luts.model);

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
            darker = nightStops(light.skyLuminance);
            device.queue.writeBuffer(dimmed, 0, new Float32Array([2 ** -darker, 0, 0, 0]));
            pass.update(
                {
                    weather: sky(),
                    wind,
                    highWind: wind,
                    shear: lab.value("shear"),
                    evolution: lab.value("change"),
                    evolutionOffset: lab.value("phase"),
                    seed: lab.value("seed"),
                    clearingKm: lab.value("clearing"),
                    clearingFromKm: lab.value("clearFrom"),
                    timeS: lab.clock,
                    observerKm: [lab.flown.east, lab.flown.north],
                    march: {
                        stepKm: lab.value("stepKm"),
                        stepGrowth: lab.value("stepGrowth"),
                        reachKm: lab.value("reachKm"),
                        fadeKm: lab.value("fadeKm"),
                        noiseKm: lab.value("noiseKm"),
                        multiScatter: lab.value("multiple"),
                        ambient: lab.value("ambient"),
                    },
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
            // A designer shows the map of its place alone, the sheet's channel by channel.
            const baked = {
                texture: pass.high.map,
                kind: "2d" as const,
                ms: () => lab.timer.ms.bake,
                timed: "all four",
            };
            const sheet = HIGH_CHANNELS.map(([label, mode, at, title]) => ({ ...baked, label, title, mode, at }));
            const own = designed === "high" ? sheet : maps.filter((map) => map.label === `${designed} map`);
            textures.show(designed ? own : maps);
            textures.encode(encoder, lab.pressed("textures.on"));
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
