import type { AtmosphereLUTs, AtmosphereModel, GroundGridPass, SkyPass } from "@himmelszelt/dunstkreis";
import {
    airTransmittance,
    clampObserverHeight,
    createGroundGridPass,
    createSkyPass,
    refractionAngle,
} from "@himmelszelt/dunstkreis";
import type {
    EarthShadow,
    MapFilter,
    MoonMapFiles,
    MoonMaps,
    MoonPass,
    Shimmer as PassShimmer,
    Vec3,
} from "@himmelszelt/nachtgestirn";
import {
    createMoonPass,
    earthshineIlluminance,
    ev100ForLuminance,
    horizonZ,
    liftedDirection,
    loadMoonMaps,
    loadMoonRoughness,
    MOON_MAPS,
    MOON_MAPS_WHOLE,
    MOON_ROUGHNESS_WHOLE,
    mapWidthFor,
    moonEV100,
    moonIlluminance,
    moonOrientation,
    refractedSunlight,
    refractionTable,
    SUN_ILLUMINANCE,
    wgsl,
} from "@himmelszelt/nachtgestirn";
import {
    apparentSiderealTime,
    eclipse,
    equatorialToHorizontal,
    fromJulianDay,
    horizontalToDirection,
    julianEphemerisDay,
    moon,
    sun,
} from "@himmelszelt/sternzeit";
import { quality, SDR } from "../dunstkreis/atmosphere";
import { skyWhite, type WhiteChoice } from "../white";
import lambert from "./laws/lambert.wgsl";
import orenNayar from "./laws/oren-nayar.wgsl";
import stripes from "./stripes.comp.wgsl";

/** No lower than this does the meter open for the umbra: EV100 4 exposes the umbra's edge, some 2 cd/m², as mid gray,
 *  and its deep red middle stays dark, as the eye and a camera see a total eclipse. */
export const UMBRA_EV100 = 4;
// The umbral magnitudes from which the meter turns from the sunlit part to the umbra, and at which it has.
const [UMBRA_FROM, UMBRA_AT] = [0.5, 0.8];
const luminanceOf = ([r, g, b]: readonly [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
// What the sky view behind a Moon depends on, to meter each sky once.
const skyKeyOf = (m: MoonAt) => `${m.jd},${m.trueDirection.join(",")},${m.heightM}`;

export type ToneCurveName = "neutral" | "agx" | "aces" | "clip";
/** The white a frame is balanced on, sky and Moon alike: "auto", the site's one white for the moment, `skyWhite`, the
 *  Sun's by day and the Moon's at night; "moon", the Moon above the air, which then is a neutral gray high in the sky,
 *  as photographs and the eye at night show it, reddened only by the air; "sun", the Sun above the air, a camera set to
 *  daylight, which shows the Moon's own color; "none", the light's colors as they are. */
export type White = WhiteChoice;
/** Which of nachtgestirn's maps: "auto" the smallest that shows the disc at a texel per pixel, never a smaller one
 *  than before. */
export type MapSize = "auto" | keyof typeof MOON_MAPS_WHOLE | FineMaps;
const SIZES = ["512", "1k", "2k", "4k"] as const;

// The maps the site hosts itself, made by the package's `maps.mjs --whole --size 8k`: the whole Moon at 8K.
const HQ = `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}moon/`;
const SHIPPED = {
    meanReflectance: MOON_MAPS_WHOLE["4k"].meanReflectance,
    meanColor: MOON_MAPS_WHOLE["4k"].meanColor,
};
export const FINE_MAPS = {
    "8k": { color: `${HQ}moon-color-8k.webp`, heights: `${HQ}moon-height-8k.webp`, width: 8192, ...SHIPPED },
} satisfies Record<string, MoonMapFiles>;
export type FineMaps = keyof typeof FINE_MAPS;
/** The widest texture each set needs, for whether the GPU takes it. */
export const MAPS_TEXELS: Record<keyof typeof MOON_MAPS_WHOLE | FineMaps, number> = {
    "512": 512,
    "1k": 1024,
    "2k": 2048,
    "4k": 4096,
    "8k": 8192,
};

// The air's green optical depth at the zenith from sea level, per model: what the shimmer measures a ray's column in.
const zenithDepths = new WeakMap<AtmosphereModel, number>();
function zenithDepth(model: AtmosphereModel) {
    let depth = zenithDepths.get(model);
    if (depth === undefined) {
        depth = -Math.log(Math.max(airTransmittance(model, 0, 90)?.[1] ?? 1, 1e-6));
        zenithDepths.set(model, depth);
    }
    return depth;
}

/** The air's shimmer as the figures ask for it: nachtgestirn's, the air it crosses taken from the Moon's place. */
export type Shimmer = Omit<PassShimmer, "airColumn" | "bend">;

// The shimmer through the air between the observer and the Moon, from the observer's height: the column from the
// optical depth towards the Moon against the zenith's from sea level, the bend as the air gives it. None above the air.
export function shimmerThrough(m: MoonAt, shimmer: Shimmer) {
    const altitude = (Math.asin(Math.max(-1, Math.min(1, m.direction[2]))) * 180) / Math.PI;
    const through = m.through(altitude)?.[1] ?? 0;
    const airColumn = -Math.log(Math.max(through, 1e-6)) / zenithDepth(m.model);
    const bend = ((m.bend(altitude) ?? 0) * Math.PI) / 180;
    return { ...shimmer, airColumn, bend };
}

/** How far each set of maps has come over the network, in bytes, while it comes; gone once it is on the GPU. */
export const mapsProgress = new Map<string, { loaded: number; total: number }>();
const progressEvents = new EventTarget();
export const onMapsProgress = (listener: () => void) => progressEvents.addEventListener("change", listener);
type Libration = { longitude: number; latitude: number };

// What the air adds to the sunlight in Earth's shadow, integrated over dunstkreis' atmosphere once per model and
// eclipse: the shadow's radii and the Moon's distance change little over one, and the integral costs some 200 ms.
const umbraTables = new WeakMap<AtmosphereModel, Map<string, Float32Array>>();
// A grazing ray through the air at each height, per model: the same for every eclipse, traced once.
const grazing = new WeakMap<
    AtmosphereModel,
    Map<number, { deflection: number; transmittance: [number, number, number] }>
>();
function airAt(model: AtmosphereModel, h: number) {
    const byHeight = grazing.get(model) ?? new Map();
    grazing.set(model, byHeight);
    let found = byHeight.get(h);
    if (!found) {
        found = {
            deflection: 2 * (refractionAngle(model, h * 1000, 0) ?? 0) * (Math.PI / 180),
            // In and out again, the spectrum's depth doubled before it becomes a color.
            transmittance: airTransmittance(model, h * 1000, 0, 2) ?? [1, 1, 1],
        };
        byHeight.set(h, found);
    }
    return found;
}

const umbraEvents = new EventTarget();
/** Hears each umbra table once it is integrated, for the figures that drew without it to draw again. */
export const onUmbraTable = (listener: () => void) => umbraEvents.addEventListener("change", listener);
const umbraPending = new Set<string>();
/**
 * The table of what the air adds in Earth's shadow for this eclipse, or null while it is being integrated: some 200 ms,
 * done after the frame that asked, so a figure draws at once with the typical umbra and again with its own.
 */
export function umbraTable(model: AtmosphereModel, umbraKm: number, penumbraKm: number, distanceKm: number) {
    const key = `${Math.round(umbraKm / 50)} ${Math.round(penumbraKm / 50)} ${Math.round(distanceKm / 2000)}`;
    const tables = umbraTables.get(model) ?? new Map<string, Float32Array>();
    umbraTables.set(model, tables);
    const table = tables.get(key);
    if (table) return table;
    if (!umbraPending.has(key)) {
        umbraPending.add(key);
        // After the frame has been shown.
        requestAnimationFrame(() =>
            setTimeout(() => {
                const DEG = Math.PI / 180;
                tables.set(
                    key,
                    refractedSunlight({
                        deflection: (h) => airAt(model, h).deflection,
                        transmittance: (h) => airAt(model, h).transmittance,
                        umbraKm,
                        penumbraKm,
                        distanceKm,
                        sunAngularRadius: 0.2665 * DEG,
                        topKm: Math.min(80, model.planet.thicknessKm),
                    }),
                );
                umbraPending.delete(key);
                umbraEvents.dispatchEvent(new Event("change"));
            }),
        );
    }
    return null;
}

/**
 * The Moon at a moment and place, all the figures draw it from: where it is, truly and as the air lifts it, how large,
 * how lit, how turned, and Earth's shadow on it. `libration` replaces the total libration, for showing a part of it.
 */
export function moonAt(
    jd: number,
    observer: { latitude: number; longitude: number; heightM: number; geocentric?: boolean },
    model: AtmosphereModel,
    libration?: Libration,
) {
    const time = fromJulianDay(jd);
    const jde = julianEphemerisDay(time);
    const heightM = clampObserverHeight(observer.heightM);
    const sunDirection = sun.direction(time, observer);
    // From Earth's center, for the figures that need no place: no parallax and no diurnal libration, so the face holds
    // still over a day. The place then only orients the sky's frame.
    const geocentric = observer.geocentric === true;
    const centerHorizontal = equatorialToHorizontal(moon.apparentPosition(jde), apparentSiderealTime(time), observer);
    const fromCenter = horizontalToDirection(centerHorizontal);
    const trueDirection = geocentric ? fromCenter : moon.direction(time, observer);
    // The same air the sky is traced through bends every ray to the Moon, and lifts where it shows.
    const bend = (altitude: number) => refractionAngle(model, heightM, altitude);
    // And dims and reddens it, the lower limb more than the upper near the horizon.
    const through = (altitude: number) => airTransmittance(model, heightM, altitude);
    const phaseAngle = moon.phaseAngle(jde);
    const lit = moon.illuminatedFraction(jde);
    // The face as the observer sees it, an Earth radius off the line to Earth's center, the diurnal libration included;
    // from Earth's center, as the ephemeris gives it.
    const positionAngleOfAxis = geocentric
        ? moon.positionAngleOfAxis(jde)
        : moon.topocentricPositionAngleOfAxis(time, observer);
    const parallacticAngle = moon.parallacticAngle(time, observer);
    const turned = libration ?? (geocentric ? moon.librations(jde) : moon.topocentricLibrations(time, observer));
    const distanceKm = moon.distance(jde);
    // Earth's shadow, with the Moon's center seen from Earth's center: the eclipse is geocentric.
    const shadow = eclipse.lunar(jde);
    let earthShadow: EarthShadow | null = null;
    if (shadow.penumbralMagnitude > 0) {
        const refracted = umbraTable(model, shadow.umbraRadiusKm, shadow.penumbraRadiusKm, distanceKm);
        const center = fromCenter;
        earthShadow = {
            axis: [-sunDirection[0], -sunDirection[1], -sunDirection[2]],
            moonCenterKm: [center[0] * distanceKm, center[1] * distanceKm, center[2] * distanceKm],
            umbraKm: shadow.umbraRadiusKm,
            penumbraKm: shadow.penumbraRadiusKm,
            ...(refracted ? { refracted } : {}),
        };
    }
    return {
        jd,
        time,
        jde,
        heightM,
        model,
        sunDirection,
        sunAngularDiameter: sun.apparentAngularDiameter(jde),
        horizontal: geocentric ? centerHorizontal : moon.horizontalPosition(time, observer),
        geocentric,
        trueDirection,
        bend,
        through,
        direction: liftedDirection(trueDirection, bend),
        /** From the observer, and from Earth's center. */
        angularDiameter: geocentric
            ? moon.apparentAngularDiameter(jde)
            : moon.topocentricAngularDiameter(time, observer),
        geocentricDiameter: moon.apparentAngularDiameter(jde),
        phaseAngle,
        lit,
        waxing: moon.illuminatedFraction(jde + 0.5) > lit,
        libration: turned,
        positionAngleOfAxis,
        parallacticAngle,
        orientation: moonOrientation({
            direction: trueDirection,
            libration: turned,
            positionAngleOfAxis,
            parallacticAngle,
        }),
        // The Sun where it shows, lifted by the same air.
        apparentSunDirection: liftedDirection(sunDirection, bend),
        moonSunDirection: moon.sunDirection(time, observer),
        distanceKm,
        earthshine: earthshineIlluminance(180 - phaseAngle, distanceKm),
        shadow,
        earthShadow,
    };
}
export type MoonAt = ReturnType<typeof moonAt>;

// The roughness maps, optional, once per page and only once a figure draws the roughness: as fine as the maps, up to the
// 4K, beyond which Rosenburg's statistics hold no more.
const ROUGHNESS_FOR: Record<string, keyof typeof MOON_ROUGHNESS_WHOLE> = { "512": "1k", "1k": "1k", "2k": "2k" };
const roughnessLoading = new Map<string, Promise<GPUTexture>>();
const roughnessLoaded = new Map<string, GPUTexture>();
function sharedRoughness(device: GPUDevice, maps: string, ready: () => void) {
    const size = ROUGHNESS_FOR[maps] ?? "4k";
    const loaded = roughnessLoaded.get(size);
    if (loaded) return loaded;
    let loading = roughnessLoading.get(size);
    if (!loading) {
        loading = loadMoonRoughness(device, MOON_ROUGHNESS_WHOLE[size]);
        roughnessLoading.set(size, loading);
        loading.then((texture) => roughnessLoaded.set(size, texture));
    }
    loading.then(ready);
    return null;
}

const mapsKey = (size: string, seen: boolean) => (seen && !(size in FINE_MAPS) ? `${size}-seen` : size);
// The maps once per page, however many figures draw the Moon: the whole ones, or `seen`, the package's seen ones, which
// the site does not host at 8K.
const loadedMaps = new Map<string, Promise<MoonMaps>>();
function sharedMaps(device: GPUDevice, size: Exclude<MapSize, "auto">, seen = false) {
    const key = mapsKey(size, seen);
    let maps = loadedMaps.get(key);
    if (!maps) {
        const files =
            size in FINE_MAPS
                ? FINE_MAPS[size as FineMaps]
                : (seen ? MOON_MAPS : MOON_MAPS_WHOLE)[size as (typeof SIZES)[number]];
        const changed = () => progressEvents.dispatchEvent(new Event("change"));
        mapsProgress.set(key, { loaded: 0, total: 0 });
        changed();
        maps = loadMoonMaps(device, files, {
            onProgress: (loaded, total) => {
                mapsProgress.set(key, { loaded, total });
                changed();
            },
        });
        maps.finally(() => {
            mapsProgress.delete(key);
            changed();
        });
        loadedMaps.set(key, maps);
    }
    return maps;
}

export type Law = "hapke" | "hapke2012" | "lambert" | "orenNayar";
/** Each law's WGSL, defining `ngReflectance` for the pass: the package's own for Hapke's two, the site's for the rest. */
const LAW_WGSL: Record<Law, string> = {
    hapke2012: wgsl.reflectance,
    hapke: wgsl.hapke1963,
    lambert,
    orenNayar,
};

/** One frame: the Moon, the view and the switches. */
export interface MoonFrame {
    moon: MoonAt;
    luts: AtmosphereLUTs;
    /** The display's tone curve, or "linear" for the exposed luminance as it is, for measuring. */
    toneMap: ToneCurveName | "linear";
    width: number;
    height: number;
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    pixelRatio: number;
    /** How many pixels across the disc shows, for choosing the maps, and which. */
    discPixels: number;
    maps: MapSize;
    /** The package's seen maps, which fade past what Earth ever sees, in place of the whole ones; not at 8K. */
    seen?: boolean;
    /** The sky behind, the air's dimming and bending and the horizon; without, the Moon from Earth's center, in black. */
    air: boolean;
    /** Whether the air acts on the disc too, true by default: its dimming, its bending and its shimmer. Off, the Moon
     *  shows as above the air, over the same sky. */
    airOnDisc?: boolean;
    /** Null to meter: the Moon's lit part, or the sky around it where that is brighter. */
    ev100: number | null;
    albedo: boolean;
    relief: boolean;
    shadows: boolean;
    /** The slopes below the relief's texels from Rosenburg's LOLA statistics, where a pixel is finer: false by default. */
    roughness?: boolean;
    earthshine: boolean;
    eclipse: boolean;
    /** The reflectance law, each its own snippet of WGSL in the pass: Hapke's of 2012, the package's, or the ones it is
     *  held against. */
    law: Law;
    /** A law to hold the disc against, its pixels striped where they are a third of a stop off it. */
    compare?: Law | null;
    /** The color map tinted to the Moon's color, as published, or as gray; tinted by default. */
    mapColor?: "tinted" | "untinted" | "gray";
    /** As the eye sees it at night, rather than a camera. */
    darkAdapted: boolean;
    /** The white the frame is balanced on, "moon" by default. */
    white?: White;
    /** Without the air, what lies behind the Moon, in cd/m²: black by default, or a plain daytime sky. */
    background?: readonly [number, number, number];
    /** Rays per pixel, the pass' defaults of 1 and 4 along the terminator and a displaced limb unless given: the pass
     *  is made anew. */
    samples?: number;
    terminatorSamples?: number;
    /** From how many pixels across the disc the relief is displaced, the pass' 1024 unless given: 0 always, Infinity
     *  never. The pass is made anew. */
    displacementFrom?: number;
    /** From how many pixels across the disc the shadows are soft, the pass' 0 unless given: 0 always, Infinity
     *  never. The pass is made anew. */
    softShadowsFrom?: number;
    /** From how many pixels across the disc the relief casts shadows, the pass' 128 unless given. The pass is made anew. */
    shadowsFrom?: number;
    /** Timestamps around the Moon's pass, for timing it on the GPU. */
    timestamps?: GPUComputePassTimestampWrites;
    /** The target's format and how many times SDR white it shows, `displayOutput`: SDR, 1 by default. */
    format?: GPUTextureFormat;
    headroom?: number;
    /** dunstkreis' grid over the sky: altitude lines every 10°, the compass directions and the Sun's symbol. */
    grid?: boolean;
    /** A lens's veil around the Sun and the Moon, dunstkreis' default, on by default. */
    veil?: boolean;
    /** A grid on the ground under the air: how far the view has flown, in km east and north. */
    ground?: { east: number; north: number } | null;
    /** How the maps are filtered, "anisotropic" by default, as the package does. */
    filter?: MapFilter;
    /** The air's shimmer over the disc, as the pass takes it, or none. */
    shimmer?: Shimmer | null;
}

/**
 * The Moon over dunstkreis' sky, into a canvas' texture: the sky pass in cd/m² into a float texture, nachtgestirn's
 * pass composed over it, the maps (the smallest that shows the disc sharply, or the ones asked for), the air towards the
 * Moon and the sky's meter, each remade or read back when needed. `requestRender` is called whenever something it
 * waited for arrived.
 */
export function createMoonRenderer(device: GPUDevice, requestRender: () => void) {
    let sky: { pass: SkyPass; luts: AtmosphereLUTs; lens: string } | null = null;
    let skyBuilding: AtmosphereLUTs | null = null;
    let skyBuildingGrid = "";
    // One pass per combination of options, kept, since a row of tiles may ask for several in turn.
    const moonPasses = new Map<string, MoonPass>();
    const moonBuilding = new Set<string>();
    let maps: MoonMaps | null = null;
    // The pair bound, and the one on its way or bound.
    let mapsBound = "";
    // How often a pass finished what it makes only once asked, the roughness' noise or the shimmer: a tile drawn before
    // is stale then, though its frame is the same.
    let readied = 0;
    let mapsWanted = "";
    let mapsSet = "";
    let background: GPUTexture | null = null;
    let groundPass: GroundGridPass | null = null;
    // dunstkreis' meter on the sky, read back once per sky the tiles show, as several tiles may show different ones: by
    // day the sky sets the exposure.
    const skyMeters = new Map<string, number>();
    const skyMetering = new Set<string>();
    // The last sky metered, held while the next is read back: a moment that moves on would meter the Moon alone in
    // between, and with the Moon down, its light gone, the exposure would flash open for a frame.
    let lastSky = Number.NEGATIVE_INFINITY;

    function buildSky(luts: AtmosphereLUTs, grid: boolean, veil: boolean) {
        const wanted = `${grid} ${veil}`;
        if (skyBuilding === luts && skyBuildingGrid === wanted) return;
        skyBuilding = luts;
        skyBuildingGrid = wanted;
        createSkyPass(device, {
            debugGrid: grid,
            luts,
            format: "rgba32float",
            toneMap: false,
            autoExposure: false,
            moonlight: true,
            groundLight: quality.groundLight,
            dither: false,
            ...(veil ? {} : { veil: 0 }),
        }).then((pass) => {
            if (skyBuilding !== luts || skyBuildingGrid !== wanted) return pass.destroy();
            sky?.pass.destroy();
            sky = { pass, luts, lens: wanted };
            skyBuilding = null;
            skyMeters.clear();
            requestRender();
        });
    }
    // A pass for a frame, or for its Moon alone, linear, to compare.
    function buildMoon(key: string, frame: MoonFrame, alone: boolean) {
        if (moonBuilding.has(key)) return;
        moonBuilding.add(key);
        const {
            toneMap,
            darkAdapted,
            format = SDR,
            headroom = 1,
            samples,
            terminatorSamples,
            displacementFrom,
            softShadowsFrom,
            shadowsFrom,
        } = frame;
        const filter = frame.filter ?? "anisotropic";
        createMoonPass(device, {
            ...(alone
                ? { format: "rgba16float" }
                : {
                      format,
                      headroom,
                      toneMap: toneMap === "linear" ? false : toneMap,
                      background: true,
                      darkAdapted,
                      // The sky behind the disc, through the air, bands in 8 bits: dithered there.
                      dither: format === SDR,
                  }),
            maps,
            reflectance: LAW_WGSL[frame.law],
            ...(samples === undefined ? {} : { samples }),
            ...(terminatorSamples === undefined ? {} : { terminatorSamples }),
            ...(displacementFrom === undefined ? {} : { displacementFrom }),
            ...(softShadowsFrom === undefined ? {} : { softShadowsFrom }),
            ...(shadowsFrom === undefined ? {} : { shadowsFrom }),
            filter,
            onReady: () => {
                readied++;
                requestRender();
            },
        }).then((pass) => {
            if (!moonBuilding.delete(key)) return pass.destroy();
            moonPasses.set(key, pass);
            requestRender();
        });
    }
    function dropMoonPasses() {
        moonBuilding.clear();
        for (const pass of moonPasses.values()) pass.destroy();
        moonPasses.clear();
    }
    function loadMaps(size: Exclude<MapSize, "auto">, seen: boolean) {
        const wanted = mapsKey(size, seen);
        if (mapsWanted === wanted) return;
        mapsWanted = wanted;
        sharedMaps(device, size, seen).then((loaded) => {
            if (mapsWanted !== wanted) return;
            maps = loaded;
            mapsBound = size;
            mapsSet = wanted;
            // The passes bind the maps when they are made: made anew with them.
            dropMoonPasses();
            requestRender();
        });
    }

    // The intermediate textures of a comparison: the finished frame, and the lights it is striped by.
    let comparing: { finished: GPUTexture; shown: GPUTexture; reference: GPUTexture } | null = null;
    const stripePasses = new Map<string, GPUComputePipeline>();
    const stripeBuilding = new Set<string>();
    function buildStripes(format: GPUTextureFormat) {
        if (stripeBuilding.has(format)) return;
        stripeBuilding.add(format);
        const code = [wgsl.moonOutput(format), stripes].join("\n");
        device
            .createComputePipelineAsync({
                label: "sternwarte:stripes",
                layout: "auto",
                compute: {
                    module: device.createShaderModule({ label: "sternwarte:stripes", code }),
                    entryPoint: "stripe",
                },
            })
            .then((pipeline) => {
                stripePasses.set(format, pipeline);
                requestRender();
            });
    }

    /** `frame` striped where its light is a third of a stop off the law it is held against. */
    function compared(target: GPUTexture, frame: MoonFrame) {
        const format = frame.format ?? SDR;
        const pipeline = stripePasses.get(format);
        if (!pipeline) {
            buildStripes(format);
            return null;
        }
        const { width, height } = target;
        if (!comparing || comparing.finished.width !== width || comparing.finished.height !== height) {
            for (const texture of Object.values(comparing ?? {})) texture.destroy();
            const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
            const make = (label: string, textureFormat: GPUTextureFormat) =>
                device.createTexture({ label, size: [width, height], format: textureFormat, usage });
            comparing = {
                finished: make("sternwarte:compareFinished", format),
                shown: make("sternwarte:compareShown", "rgba16float"),
                reference: make("sternwarte:compareReference", "rgba16float"),
            };
        }
        const shown: MoonFrame = { ...frame, compare: null };
        const reference: MoonFrame = { ...frame, law: frame.compare ?? frame.law };
        const drawn = render(comparing.finished, shown, false);
        if (!drawn || !render(comparing.shown, shown, true) || !render(comparing.reference, reference, true))
            return null;
        const encoder = device.createCommandEncoder({ label: "sternwarte:stripes" });
        const pass = encoder.beginComputePass({ label: "sternwarte:stripes" });
        pass.setPipeline(pipeline);
        pass.setBindGroup(
            0,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(0),
                entries: [comparing.finished, comparing.shown, comparing.reference].map((texture, binding) => ({
                    binding,
                    resource: texture.createView(),
                })),
            }),
        );
        pass.setBindGroup(
            1,
            device.createBindGroup({
                layout: pipeline.getBindGroupLayout(1),
                entries: [{ binding: 0, resource: target.createView() }],
            }),
        );
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        device.queue.submit([encoder.finish()]);
        return drawn;
    }

    /** Draws `frame` into `target`, or its Moon `alone`, linear, without the sky; null while a pass is being made. */
    function render(target: GPUTexture, frame: MoonFrame, alone: boolean) {
        const { moon: m, luts, width, height } = frame;
        const grid = frame.grid ?? false;
        const veil = frame.veil ?? true;
        if (!sky || sky.luts !== luts || sky.lens !== `${grid} ${veil}`) {
            buildSky(luts, grid, veil);
            if (!sky || sky.luts !== luts) return null;
        }
        // The maps asked for, or the smallest that shows the disc sharply, but never smaller than the ones bound.
        const needed =
            SIZES.find((size) => (MOON_MAPS_WHOLE[size].width ?? 0) >= mapWidthFor(frame.discPixels)) ?? "4k";
        const kept = Math.max(0, SIZES.indexOf(mapsBound as (typeof SIZES)[number]));
        // Finer maps once bound stay bound for "auto" too.
        const size =
            frame.maps !== "auto"
                ? frame.maps
                : mapsBound in FINE_MAPS
                  ? (mapsBound as FineMaps)
                  : (SIZES[Math.max(SIZES.indexOf(needed), kept)] ?? "4k");
        loadMaps(size, frame.seen ?? false);
        const key = `${alone} ${frame.law} ${frame.toneMap} ${maps ? mapsSet : "plain"} ${frame.darkAdapted} ${frame.format ?? SDR} ${frame.headroom ?? 1} ${frame.samples} ${frame.terminatorSamples} ${frame.displacementFrom} ${frame.softShadowsFrom} ${frame.shadowsFrom} ${frame.filter ?? "anisotropic"}`;
        const moonPass = moonPasses.get(key);
        if (!moonPass) {
            buildMoon(key, frame, alone);
            return null;
        }
        if (!background || background.width !== width || background.height !== height) {
            background?.destroy();
            background = device.createTexture({
                label: "sternwarte:moonBackground",
                size: [width, height],
                format: "rgba32float",
                usage:
                    GPUTextureUsage.STORAGE_BINDING |
                    GPUTextureUsage.TEXTURE_BINDING |
                    GPUTextureUsage.RENDER_ATTACHMENT,
            });
        }

        // The air towards the Moon, per ray of its disc in the table, and at its center for the meter.
        const airOnDisc = frame.air && frame.airOnDisc !== false;
        const refraction = airOnDisc ? refractionTable(m.trueDirection, m.angularDiameter, m.bend, m.through) : null;
        // Traced only where there is air: the tiles have none.
        const center = airOnDisc
            ? m.through((Math.asin(Math.min(Math.max(m.direction[2], -1), 1)) * 180) / Math.PI)
            : null;
        const through = airOnDisc ? (center ? (center[0] + center[1] + center[2]) / 3 : 0) : 1;
        // Metered on the lit part of the disc outside the umbra, opening up as the umbra swallows it but no further
        // than the umbra's own exposure, or on the sky around it where that is brighter, so neither burns out. From
        // half the disc in the umbra on, the meter turns to the umbra, and with 80% in it exposes for the umbra alone,
        // the sunlit sliver left to burn out, as photographs of an eclipse do.
        const umbral = frame.eclipse ? Math.max(m.shadow.umbralMagnitude, 0) : 0;
        const sunlit = moonEV100(m.phaseAngle, m.lit, Math.max(through, 1e-3) * Math.max(1 - umbral, 1e-4));
        const toUmbra = Math.min(Math.max((umbral - UMBRA_FROM) / (UMBRA_AT - UMBRA_FROM), 0), 1);
        const disc =
            umbral > 0
                ? Math.max(sunlit + (UMBRA_EV100 - sunlit) * toUmbra * toUmbra * (3 - 2 * toUmbra), UMBRA_EV100)
                : sunlit;
        // The sky lies in front of the disc, so the two add up: a plain background, a daytime sky behind the tiles, too.
        const behind = frame.air
            ? (skyMeters.get(skyKeyOf(m)) ?? lastSky)
            : frame.background
              ? ev100ForLuminance(luminanceOf(frame.background))
              : Number.NEGATIVE_INFINITY;
        const metered = Math.log2(2 ** disc + 2 ** behind);
        // Held to the slider's range: below the horizon the air lets nothing through, and the meter would run away.
        const ev100 = frame.ev100 ?? Math.min(Math.max(Math.round(metered * 10) / 10, -6), 20);

        const started = performance.now();
        const view = {
            inverseViewProjection: frame.inverseViewProjection,
            projectionDistance: frame.projectionDistance,
        };
        sky.pass.update({
            ...view,
            sunDirection: m.sunDirection,
            sunAngularDiameter: m.sunAngularDiameter,
            observerHeightM: m.heightM,
            pixelRatio: frame.pixelRatio,
            ev100: UNIT_EV100,
            // The grid in an eighth of what the Moon's pass exposes as white: mixed into the linear light, before the
            // tone curve and the encoding, it shows about as faint as dunstkreis' sky mixes it into the encoded image.
            gridInk: (1.2 * 2 ** ev100) / 8,
            autoExposureKeys: [],
            // Metered for the figure's own exposure, down into the night, where the Moon sets it.
            autoExposureRange: [-6, 20],
            // The sky by moonlight, dimmed in Earth's shadow as the disc is, and the Moon's width, which hides the Sun's
            // disc behind it in a solar eclipse.
            moonDirection: m.trueDirection,
            moonAngularDiameter: frame.air ? m.angularDiameter : m.geocentricDiameter,
            moonIlluminance: moonIlluminance(m.phaseAngle, m.distanceKm) * Math.max(1 - umbral, 1e-4),
        });
        moonPass.setRoughness(frame.roughness && maps ? sharedRoughness(device, mapsBound, requestRender) : null);
        moonPass.update({
            ...view,
            direction: m.trueDirection,
            angularDiameter: frame.air ? m.angularDiameter : m.geocentricDiameter,
            sunDirection: m.moonSunDirection,
            sunIlluminance: SUN_ILLUMINANCE,
            // One balance for the sky and the Moon: the sky lies in the background, in cd/m², which the pass balances.
            whiteBalance: skyWhite(m.sunDirection, frame.white ?? "moon"),
            earthshine: frame.earthshine ? m.earthshine : 0,
            orientation: m.orientation,
            ev100,
            horizonZ: frame.air ? horizonZ(m.heightM, m.model.planet.groundRadiusKm) : -1,
            albedoMap: frame.albedo,
            relief: frame.relief,
            shadows: frame.shadows,
            roughness: frame.roughness ?? false,
            mapColor: frame.mapColor ?? "tinted",
            eclipse: frame.eclipse ? m.earthShadow : null,
            sunAngularDiameter: m.sunAngularDiameter,
            refraction,
            // From the observer, an Earth radius nearer when the Moon is overhead.
            distanceKm: m.geocentric ? m.distanceKm : m.distanceKm - m.model.planet.groundRadiusKm * m.trueDirection[2],
            // Where a figure carried the viewer away from Earth, Earth where it has gone.
            earthDirection: (m as MoonAt & { earthDirection?: Vec3 }).earthDirection ?? null,
            // Only through the air, measured in its zenith column from sea level.
            shimmer: airOnDisc && frame.shimmer ? shimmerThrough(m, frame.shimmer) : null,
        });
        const encoder = device.createCommandEncoder({ label: "sternwarte:moon" });
        if (alone) {
            moonPass.encode(encoder, target, frame.timestamps ? { timestampWrites: frame.timestamps } : {});
            device.queue.submit([encoder.finish()]);
            return { ev100, through, passesMs: performance.now() - started };
        }
        let underneath = background;
        if (frame.air) {
            sky.pass.encode(encoder, background);
            if (frame.ground) {
                groundPass ??= createGroundGridPass(device);
                const radiusKm = m.model.planet.groundRadiusKm;
                underneath = groundPass.encode(encoder, background, {
                    inverseViewProjection: frame.inverseViewProjection,
                    projectionDistance: frame.projectionDistance,
                    heightM: m.heightM,
                    radiusKm,
                    flown: frame.ground,
                });
            }
        } else {
            const [r, g, b] = frame.background ?? [0, 0, 0];
            encoder
                .beginRenderPass({
                    colorAttachments: [
                        {
                            view: background.createView(),
                            loadOp: "clear",
                            storeOp: "store",
                            clearValue: { r, g, b, a: 1 },
                        },
                    ],
                })
                .end();
        }
        moonPass.encode(encoder, target, {
            background: underneath,
            ...(frame.timestamps ? { timestampWrites: frame.timestamps } : {}),
        });
        device.queue.submit([encoder.finish()]);
        const passesMs = performance.now() - started;
        const skyKey = skyKeyOf(m);
        if (frame.air && !skyMeters.has(skyKey) && !skyMetering.has(skyKey)) {
            skyMetering.add(skyKey);
            const { pass } = sky;
            pass.meteredEV100().then((value) => {
                skyMetering.delete(skyKey);
                if (sky?.pass !== pass) return;
                if (skyMeters.size > 64) skyMeters.clear();
                skyMeters.set(skyKey, value);
                lastSky = value;
                if (frame.ev100 === null) requestRender();
            });
        }
        return { ev100, through, passesMs };
    }

    return {
        /** What the drawings depend on besides the frame: the maps bound, seen or whole, the roughness maps loaded, and what
         *  the passes made since. */
        bound: () => `${mapsBound} ${mapsSet} ${roughnessLoaded.size} ${readied}`,
        /** Draws `frame` into `target`; null while a pass is still being made, which calls `requestRender` when done. */
        draw(target: GPUTexture, frame: MoonFrame) {
            if (!frame.compare) return render(target, frame, false);
            return compared(target, frame);
        },
    };
}

/** The inverse view-projection of a camera looking along `forward` with `up` up, `tx` and `ty` the tangents of half
 *  its fields of view, as dunstkreis' sky pass and nachtgestirn's take it. */
export function inverseViewProjection(
    forward: readonly number[],
    right: readonly number[],
    up: readonly number[],
    tx: number,
    ty: number,
) {
    return new Float32Array([...right.map((c) => c * tx), 0, ...up.map((c) => c * ty), 0, 0, 0, 0, 1, ...forward, 0]);
}
