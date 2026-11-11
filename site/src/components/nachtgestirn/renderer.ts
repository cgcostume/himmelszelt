import type { AtmosphereLUTs, AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import { airTransmittance, clampObserverHeight, createSkyPass, refractionAngle } from "@himmelszelt/dunstkreis";
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
    MOON_MAPS,
    mapWidthFor,
    moonEV100,
    moonIlluminance,
    moonOrientation,
    refractedSunlight,
    refractionTable,
    SUN_ILLUMINANCE,
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

/** No lower than this does the meter open for the umbra: EV100 4 exposes the umbra's edge, some 2 cd/m², as mid gray,
 *  and its deep red middle stays dark, as the eye and a camera see a total eclipse. */
export const UMBRA_EV100 = 4;
const luminanceOf = ([r, g, b]: readonly [number, number, number]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);

export type ToneCurveName = "neutral" | "agx" | "aces" | "clip";
/** Which of nachtgestirn's maps: "auto" the smallest that shows the disc at a texel per pixel, never a smaller one
 *  than before. */
export type MapSize = "auto" | keyof typeof MOON_MAPS | FineMaps;
const SIZES = ["small", "medium", "large"] as const;

// The maps the package does not ship, made by its `maps-hq.mjs` and hosted with the site: the whole Moon at 2K, between
// the package's 1K and 4K, and at 8K, and a strip of the southern highlands at 8K over the shipped 4K.
const HQ = `${import.meta.env.BASE_URL.replace(/\/?$/, "/")}moon/`;
const STRIPS = {
    "8k": { x: 1638, y: 2298, width: 4916, height: 934, mapWidth: 8192 },
};
const region = ({ x, y, width, height, mapWidth }: (typeof STRIPS)["8k"]) =>
    [x / mapWidth, (2 * y) / mapWidth, (x + width) / mapWidth, (2 * (y + height)) / mapWidth] as const;
const SHIPPED = { meanReflectance: MOON_MAPS.large.meanReflectance, meanColor: MOON_MAPS.large.meanColor };
export const FINE_MAPS = {
    "2k": { color: `${HQ}moon-color-2k.webp`, heights: `${HQ}moon-height-2k.webp`, width: 2048, ...SHIPPED },
    "8k": { color: `${HQ}moon-color-8k.webp`, heights: `${HQ}moon-height-8k.webp`, width: 8192, ...SHIPPED },
    "8k-strip": {
        ...MOON_MAPS.large,
        detail: {
            color: `${HQ}moon-color-8k-strip.webp`,
            heights: `${HQ}moon-height-8k-strip.webp`,
            region: region(STRIPS["8k"]),
        },
    },
} satisfies Record<string, MoonMapFiles>;
export type FineMaps = keyof typeof FINE_MAPS;
/** The widest texture each set needs, for whether the GPU takes it. */
export const MAPS_TEXELS: Record<keyof typeof MOON_MAPS | FineMaps, number> = {
    small: 512,
    medium: 1024,
    large: 4096,
    "2k": 2048,
    "8k": 8192,
    "8k-strip": STRIPS["8k"].width,
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
        const t = airTransmittance(model, h * 1000, 0) ?? [1, 1, 1];
        found = {
            deflection: 2 * (refractionAngle(model, h * 1000, 0) ?? 0) * (Math.PI / 180),
            transmittance: [t[0] * t[0], t[1] * t[1], t[2] * t[2]],
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
    observer: { latitude: number; longitude: number; heightM: number },
    model: AtmosphereModel,
    libration?: Libration,
) {
    const time = fromJulianDay(jd);
    const jde = julianEphemerisDay(time);
    const heightM = clampObserverHeight(observer.heightM);
    const sunDirection = sun.direction(time, observer);
    const trueDirection = moon.direction(time, observer);
    // The same air the sky is traced through bends every ray to the Moon, and lifts where it shows.
    const bend = (altitude: number) => refractionAngle(model, heightM, altitude);
    // And dims and reddens it, the lower limb more than the upper near the horizon.
    const through = (altitude: number) => airTransmittance(model, heightM, altitude);
    const phaseAngle = moon.phaseAngle(jde);
    const lit = moon.illuminatedFraction(jde);
    const positionAngleOfAxis = moon.positionAngleOfAxis(jde);
    const parallacticAngle = moon.parallacticAngle(time, observer);
    const turned = libration ?? moon.librations(jde);
    const distanceKm = moon.distance(jde);
    // Earth's shadow, with the Moon's center seen from Earth's center: the eclipse is geocentric.
    const shadow = eclipse.lunar(jde);
    let earthShadow: EarthShadow | null = null;
    if (shadow.penumbralMagnitude > 0) {
        const refracted = umbraTable(model, shadow.umbraRadiusKm, shadow.penumbraRadiusKm, distanceKm);
        const geocentric = equatorialToHorizontal(moon.apparentPosition(jde), apparentSiderealTime(time), observer);
        const center = horizontalToDirection(geocentric);
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
        horizontal: moon.horizontalPosition(time, observer),
        trueDirection,
        bend,
        through,
        direction: liftedDirection(trueDirection, bend),
        /** From the observer, and from Earth's center. */
        angularDiameter: moon.topocentricAngularDiameter(time, observer),
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

// The maps once per page, however many figures draw the Moon.
const loadedMaps = new Map<string, Promise<MoonMaps>>();
function sharedMaps(device: GPUDevice, size: Exclude<MapSize, "auto">) {
    let maps = loadedMaps.get(size);
    if (!maps) {
        const files = size in FINE_MAPS ? FINE_MAPS[size as FineMaps] : MOON_MAPS[size as (typeof SIZES)[number]];
        const changed = () => progressEvents.dispatchEvent(new Event("change"));
        mapsProgress.set(size, { loaded: 0, total: 0 });
        changed();
        maps = loadMoonMaps(device, files, {
            onProgress: (loaded, total) => {
                mapsProgress.set(size, { loaded, total });
                changed();
            },
        });
        maps.finally(() => {
            mapsProgress.delete(size);
            changed();
        });
        loadedMaps.set(size, maps);
    }
    return maps;
}

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
    earthshine: boolean;
    eclipse: boolean;
    law: "hapke" | "hapke2012" | "lambert" | "orenNayar";
    /** A law to hold the disc against, its pixels striped where they are a third of a stop off it. */
    compare?: "hapke" | "hapke2012" | "lambert" | "orenNayar" | null;
    /** A point Sun's hard shadows, striped where they are a third of a stop off the Sun's disc's soft ones. */
    compareShadows?: boolean;
    /** The color map tinted to the Moon's color, as published, or as gray; tinted by default. */
    mapColor?: "tinted" | "untinted" | "gray";
    /** As the eye sees it at night, rather than a camera. */
    nightVision: boolean;
    /** Without the air, what lies behind the Moon, in cd/m²: black by default, or a plain daytime sky. */
    background?: readonly [number, number, number];
    /** Rays per pixel, the pass' defaults of 1 and 4 along the terminator and a displaced limb unless given: the pass
     *  is made anew. */
    samples?: number;
    terminatorSamples?: number;
    /** From how many pixels across the disc the relief is displaced, the pass' 1024 unless given: 0 always, Infinity
     *  never. The pass is made anew. */
    displacementFrom?: number;
    /** From how many pixels across the disc the shadows are soft, the pass' 4096 unless given: 0 always, Infinity
     *  never. The pass is made anew. */
    softShadowsFrom?: number;
    /** The target's format and how many times SDR white it shows, `displayOutput`: SDR, 1 by default. */
    format?: GPUTextureFormat;
    headroom?: number;
    /** dunstkreis' grid over the sky: altitude lines every 10°, the compass directions and the Sun's symbol. */
    grid?: boolean;
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
    let sky: { pass: SkyPass; luts: AtmosphereLUTs; grid: boolean } | null = null;
    let skyBuilding: AtmosphereLUTs | null = null;
    let skyBuildingGrid = "";
    // One pass per combination of options, kept, since a row of tiles may ask for several in turn.
    const moonPasses = new Map<string, MoonPass>();
    const moonBuilding = new Set<string>();
    let maps: MoonMaps | null = null;
    // The pair bound, and the one on its way or bound.
    let mapsBound = "";
    let mapsWanted = "";
    let background: GPUTexture | null = null;
    // dunstkreis' meter on the sky, read back whenever the sky view may have been rebuilt: by day the sky sets the exposure.
    let skyEV100 = Number.NEGATIVE_INFINITY;
    let skyMeteredFor = "";

    function buildSky(luts: AtmosphereLUTs, grid: boolean) {
        const wanted = `${grid}`;
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
        }).then((pass) => {
            if (skyBuilding !== luts || skyBuildingGrid !== wanted) return pass.destroy();
            sky?.pass.destroy();
            sky = { pass, luts, grid };
            skyBuilding = null;
            skyMeteredFor = "";
            requestRender();
        });
    }
    function buildMoon(key: string, frame: MoonFrame) {
        if (moonBuilding.has(key)) return;
        moonBuilding.add(key);
        const {
            toneMap,
            nightVision,
            format = SDR,
            headroom = 1,
            samples,
            terminatorSamples,
            displacementFrom,
            softShadowsFrom,
        } = frame;
        const filter = frame.filter ?? "anisotropic";
        createMoonPass(device, {
            format,
            headroom,
            toneMap: toneMap === "linear" ? false : toneMap,
            maps,
            nightVision,
            ...(samples === undefined ? {} : { samples }),
            ...(terminatorSamples === undefined ? {} : { terminatorSamples }),
            ...(displacementFrom === undefined ? {} : { displacementFrom }),
            ...(softShadowsFrom === undefined ? {} : { softShadowsFrom }),
            filter,
            onReady: requestRender,
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
    function loadMaps(size: Exclude<MapSize, "auto">) {
        if (mapsWanted === size) return;
        mapsWanted = size;
        sharedMaps(device, size).then((loaded) => {
            if (mapsWanted !== size) return;
            maps = loaded;
            mapsBound = size;
            // The passes bind the maps when they are made: made anew with them.
            dropMoonPasses();
            requestRender();
        });
    }

    return {
        /** What the drawings depend on besides the frame: the maps bound. */
        bound: () => mapsBound,
        /** Draws `frame` into `target`; null while a pass is still being made, which calls `requestRender` when done. */
        draw(target: GPUTexture, frame: MoonFrame) {
            const { moon: m, luts, width, height } = frame;
            const grid = frame.grid ?? false;
            if (!sky || sky.luts !== luts || sky.grid !== grid) {
                buildSky(luts, grid);
                if (!sky || sky.luts !== luts) return null;
            }
            // The maps asked for, or the smallest that shows the disc sharply, but never smaller than the ones bound.
            const needed =
                SIZES.find((size) => (MOON_MAPS[size].width ?? 0) >= mapWidthFor(frame.discPixels)) ?? "large";
            const kept = Math.max(0, SIZES.indexOf(mapsBound as (typeof SIZES)[number]));
            // Finer maps once bound stay bound for "auto" too.
            const size =
                frame.maps !== "auto"
                    ? frame.maps
                    : mapsBound in FINE_MAPS
                      ? (mapsBound as FineMaps)
                      : (SIZES[Math.max(SIZES.indexOf(needed), kept)] ?? "large");
            loadMaps(size);
            const key = `${frame.toneMap} ${maps ? mapsBound : "plain"} ${frame.nightVision} ${frame.format ?? SDR} ${frame.headroom ?? 1} ${frame.samples} ${frame.terminatorSamples} ${frame.displacementFrom} ${frame.softShadowsFrom} ${frame.filter ?? "anisotropic"}`;
            const moonPass = moonPasses.get(key);
            if (!moonPass) {
                buildMoon(key, frame);
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
            const refraction = airOnDisc
                ? refractionTable(m.trueDirection, m.angularDiameter, m.bend, m.through)
                : null;
            // Traced only where there is air: the tiles have none.
            const center = airOnDisc
                ? m.through((Math.asin(Math.min(Math.max(m.direction[2], -1), 1)) * 180) / Math.PI)
                : null;
            const through = airOnDisc ? (center ? (center[0] + center[1] + center[2]) / 3 : 0) : 1;
            // Metered on the lit part of the disc outside the umbra, opening up as the umbra swallows it but no further
            // than the umbra's own exposure, or on the sky around it where that is brighter, so neither burns out.
            const outsideUmbra = frame.eclipse ? Math.max(1 - Math.max(m.shadow.umbralMagnitude, 0), 1e-4) : 1;
            const metered = Math.max(
                moonEV100(m.phaseAngle, m.lit, Math.max(through, 1e-3) * outsideUmbra),
                frame.eclipse && m.shadow.umbralMagnitude > 0 ? UMBRA_EV100 : Number.NEGATIVE_INFINITY,
                frame.air ? skyEV100 : Number.NEGATIVE_INFINITY,
                // A plain background, a daytime sky behind the tiles, is metered too, so it does not burn out.
                !frame.air && frame.background
                    ? ev100ForLuminance(luminanceOf(frame.background))
                    : Number.NEGATIVE_INFINITY,
            );
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
                // The sky by moonlight, dimmed in Earth's shadow as the disc is.
                moonDirection: m.trueDirection,
                moonIlluminance: moonIlluminance(m.phaseAngle, m.distanceKm) * outsideUmbra,
            });
            moonPass.update({
                ...view,
                direction: m.trueDirection,
                angularDiameter: frame.air ? m.angularDiameter : m.geocentricDiameter,
                sunDirection: m.moonSunDirection,
                sunIlluminance: SUN_ILLUMINANCE,
                earthshine: frame.earthshine ? m.earthshine : 0,
                orientation: m.orientation,
                ev100,
                horizonZ: frame.air ? horizonZ(m.heightM, m.model.planet.groundRadiusKm) : -1,
                albedoMap: frame.albedo,
                relief: frame.relief,
                shadows: frame.shadows,
                law: frame.law,
                mapColor: frame.mapColor ?? "tinted",
                compare: frame.compare ?? null,
                compareShadows: frame.compareShadows ?? false,
                eclipse: frame.eclipse ? m.earthShadow : null,
                sunAngularDiameter: m.sunAngularDiameter,
                refraction,
                // From the observer, an Earth radius nearer when the Moon is overhead.
                distanceKm: m.distanceKm - m.model.planet.groundRadiusKm * m.trueDirection[2],
                // Where a figure carried the viewer away from Earth, Earth where it has gone.
                earthDirection: (m as MoonAt & { earthDirection?: Vec3 }).earthDirection ?? null,
                // Only through the air, measured in its zenith column from sea level.
                shimmer: airOnDisc && frame.shimmer ? shimmerThrough(m, frame.shimmer) : null,
            });
            const encoder = device.createCommandEncoder({ label: "sternwarte:moon" });
            if (frame.air) {
                sky.pass.encode(encoder, background);
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
            moonPass.encode(encoder, target, { background });
            device.queue.submit([encoder.finish()]);
            const passesMs = performance.now() - started;
            const skyKey = `${m.jd},${m.trueDirection.join(",")},${m.heightM}`;
            if (frame.air && skyKey !== skyMeteredFor) {
                skyMeteredFor = skyKey;
                const { pass } = sky;
                pass.meteredEV100().then((value) => {
                    if (sky?.pass !== pass || Math.abs(value - skyEV100) < 0.05) return;
                    skyEV100 = value;
                    if (frame.ev100 === null) requestRender();
                });
            }
            return { ev100, through, passesMs };
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
