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
import { SHOW, texturePanel } from "../textures";
import { CIRRUS_PRESETS } from "./cirrus";
import { FORMATION_PRESETS } from "./formation";
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
const ZENITH: Rgb = [0.06, 0.17, 0.48];
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

/**
 * The whole-sky research figure on `root`, a `figure[data-weather-lab]`: gewoelk's layered clouds, three marched
 * layers and a sheet of high cloud, over dunstkreis' sky with sternenheer's stars and nachtgestirn's Moon, exposed by
 * the stars figure's meter. The clouds' light is still a stand-in, the sun's by day and the Moon's share of it by
 * night, with the real sky's luminance for their ambient light.
 */
export async function weatherFigure(root: HTMLElement) {
    let draw: (lab: Lab) => void = () => {};
    const lab = createLab(root, (current) => draw(current), {
        presets: FORMATION_PRESETS,
        morePresets: { sky: CIRRUS_PRESETS },
        camera: { yaw: 230 * DEG, pitch: 16 * DEG, fov: 95 * DEG },
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
        mapSize: 512,
        highMapSize: Number(lab.choice("size")) || 2048,
    });
    const clouds = () => {
        const chosen = quality();
        const key = JSON.stringify(chosen);
        const made = passes.get(key);
        if (made && !(made instanceof Promise)) return made;
        if (!made) {
            const making = createLayeredCloudPass(device, {
                format: "rgba16float",
                toneMap: false,
                background: false,
                quality: chosen,
            });
            passes.set(key, making);
            making.then((pass) => {
                passes.set(key, pass);
                lab.request();
            });
        }
        return null;
    };

    /** The sky as the held sliders have it. */
    const sky = (): LayeredSky => {
        const layer = (i: number) => {
            const value = (name: string) => lab.value(`l${i}.${name}`);
            return {
                coverage: lab.pressed(`l${i}.enabled`) ? value("coverage") : 0,
                baseKm: value("base"),
                depthKm: value("depth"),
                sizeKm: value("feature"),
                tileKm: value("tile"),
                extinction: value("extinction"),
                detail: value("detail"),
                sharpness: value("sharp"),
                lumps: value("lumps"),
                bulge: value("warp"),
            };
        };
        const c = (name: string) => lab.value(`c.${name}`);
        return {
            low: layer(0),
            deep: {
                ...layer(1),
                kind: lab.choice("kind1") === "3" ? "front" : "towers",
                anvil: lab.value("anvil"),
                frontKm: lab.value("front.distance"),
                frontDepthKm: lab.value("front.depth"),
                frontBearing: lab.value("front.bearing"),
            },
            middle: layer(2),
            high: {
                coverage: lab.pressed("sheet.on") ? c("coverage") : 0,
                altitudeKm: c("altitude"),
                opticalDepth: c("opticalDepth"),
                tileKm: c("tile"),
                patchKm: c("patchKm"),
                bandStretch: c("bandStretch"),
                bandAngle: c("bandAngle"),
                edge: c("edge"),
                puffs: c("cells"),
                puffKm: c("cellKm"),
                elongation: c("elongation"),
                rows: c("rows"),
                grain: c("grain"),
                softness: c("soft"),
                billows: c("billows"),
                billowKm: c("billowKm"),
                ripples: c("ripples"),
                rippleKm: c("rippleKm"),
                curve: c("curve"),
                ribs: c("ribs"),
                ribKm: c("ribKm"),
                veil: c("veil"),
                striation: c("striation"),
                stretch: c("stretch"),
                combing: lab.value("comb"),
                trails: c("streaks"),
                trailBend: c("bend"),
                relief: c("relief"),
                forwardG: c("forwardG"),
            },
        };
    };

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
            const fromSky = lit(ZENITH, luminance * Math.PI);
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
            textures.show([
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
            ]);
            textures.encode(encoder, lab.pressed("textures.on"));
            lab.timer.resolve(encoder);
        };
        const drawn = renderer.draw(lab.context.getCurrentTexture(), {
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
        exposure = `, exposed at EV100 ${(drawn.ev100 + darker).toFixed(1)}`;
        lab.timer.read();
        // The exposure follows its meter slowly: frames asked for while it moves, none once it has arrived.
        if (drawn.adapting) requestAnimationFrame(() => lab.request());
    };
    onTables(() => lab.request());
    lab.request();
}
