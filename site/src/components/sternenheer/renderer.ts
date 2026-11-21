import type { AirTable, AtmosphereLUTs, AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import {
    airTable,
    airTransmittance,
    clampObserverHeight,
    createAirTexture,
    createSkyPass,
    liftedDirection,
    refractionAngle,
    seeingUniformData,
} from "@himmelszelt/dunstkreis";
import type { MeterPass } from "@himmelszelt/helldunkel";
import {
    adaptEV100,
    createMeterPass,
    ev100FromLuminance,
    localAdaptation,
    lowLightCompensation,
    meteredLuminance,
    veilingGlare,
} from "@himmelszelt/helldunkel";
import type { MoonMaps, MoonPass } from "@himmelszelt/nachtgestirn";
import {
    createMoonPass,
    earthshineIlluminance,
    horizonZ,
    loadMoonMaps,
    MOON_MAPS_WHOLE,
    moonEV100,
    moonIlluminance,
    liftedDirection as moonLifted,
    moonOrientation,
    refractionTable,
    SUN_ILLUMINANCE,
} from "@himmelszelt/nachtgestirn";
import type {
    ConstellationLines,
    DeepStars,
    MilkyWay,
    PackedStars,
    StarCatalog,
    StarsPass,
} from "@himmelszelt/sternenheer";
import {
    createStarsPass,
    loadCatalog,
    loadConstellations,
    loadDeepStars,
    loadFaintStars,
    loadMilkyWay,
    MILKY_WAY_MAPS,
    starAt,
} from "@himmelszelt/sternenheer";
import { apparentSiderealTime, fromJulianDay, julianEphemerisDay, moon, stars, sun } from "@himmelszelt/sternzeit";
import { quality } from "../dunstkreis/atmosphere";
import { groundGrid } from "../dunstkreis/groundgrid";
import { createGridPass } from "./grid";

// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
const DEG = Math.PI / 180;

export type ToneCurveName = "neutral" | "agx" | "aces" | "clip";
export type MapSize = "small" | "large" | "8k";

/**
 * The sky at a moment and place, as the figure draws it: the rotation that turns the catalog into it, the Sun and the
 * Moon, and the air towards everything.
 */
export function skyAt(
    jd: number,
    observer: { latitude: number; longitude: number; heightM: number },
    model: AtmosphereModel,
) {
    const time = fromJulianDay(jd);
    const jde = julianEphemerisDay(time);
    const heightM = clampObserverHeight(observer.heightM);
    const bend = (altitude: number) => refractionAngle(model, heightM, altitude);
    const through = (altitude: number) => airTransmittance(model, heightM, altitude);
    const moonDirection = moon.direction(time, observer);
    const phaseAngle = moon.phaseAngle(jde);
    // What of a body's light reaches the observer: none once the ground hides its center.
    const lit = (direction: readonly [number, number, number]) => {
        const [r, g, b] = through((Math.asin(moonLifted(direction, bend)[2]) * 180) / Math.PI) ?? [0, 0, 0];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const sunDirection = sun.direction(time, observer);
    // Along the line to the Moon's center as it shows, or the lowest above it that still reaches space.
    let moonAltitude = (Math.asin(moonLifted(moonDirection, bend)[2]) * 180) / Math.PI;
    while (through(moonAltitude) === null && moonAltitude < 2) moonAltitude += 0.02;
    const [r, g, b] = through(moonAltitude) ?? [1, 1, 1];
    const moonThrough = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const distanceKm = moon.distance(jde);
    return {
        jd,
        time,
        jde,
        heightM,
        model,
        bend,
        through,
        skyRotation: stars.horizontalMatrix(time, observer),
        years: (jde - 2451545) / 365.25,
        siderealTime: apparentSiderealTime(time) + observer.longitude,
        sunDirection,
        // The Sun's and the Moon's light at the eye, in lux.
        sunAtEye: SUN_ILLUMINANCE * lit(sunDirection),
        moonAtEye: moonIlluminance(phaseAngle, distanceKm) * lit(moonDirection),
        sunAngularDiameter: sun.apparentAngularDiameter(jde),
        moonDirection,
        moonAngularDiameter: moon.topocentricAngularDiameter(time, observer),
        moonSunDirection: moon.sunDirection(time, observer),
        moonOrientation: moonOrientation({
            direction: moonDirection,
            libration: moon.librations(jde),
            positionAngleOfAxis: moon.positionAngleOfAxis(jde),
            parallacticAngle: moon.parallacticAngle(time, observer),
        }),
        moonIlluminance: moonIlluminance(phaseAngle, distanceKm),
        earthshine: earthshineIlluminance(180 - phaseAngle, distanceKm),
        moonLit: moon.illuminatedFraction(jde),
        moonEV100: moonEV100(phaseAngle, moon.illuminatedFraction(jde), 1, 2),
        // The stops the air takes from the Moon's light on its way down.
        moonAirStops: Math.log2(Math.max(moonThrough, 1e-4)),
        distanceKm,
    };
}
export type SkyAt = ReturnType<typeof skyAt>;

// The catalog and the maps once per page, however many figures draw the stars; the Moon's small maps, as the disc
// stays small in a view of the whole sky.
// The faint stars null where `pnpm assets` has not made them: the package does not ship ESA's catalogues.
let sharedCatalog: Promise<[StarCatalog, ConstellationLines, PackedStars | null]> | null = null;
let sharedMoonMaps: Promise<MoonMaps> | null = null;
// The deep stars, 14 MB, fetched when a figure first asks for them: null where `pnpm assets` has not made them.
let sharedDeepStars: Promise<DeepStars | null> | null = null;
/** The deep stars, fetched once a page for every figure that asks; null where `pnpm assets` has not made them. */
export function deepStarsOnce() {
    sharedDeepStars ??= loadDeepStars().catch(() => null);
    return sharedDeepStars;
}
const loadedMaps = new Map<MapSize, Promise<MilkyWay | null>>();
/** A map of the Milky Way, fetched once a page for every figure that asks; null where it is missing, as the 8K map is
 *  until `pnpm assets` makes it. */
export function milkyWayOnce(device: GPUDevice, size: MapSize) {
    const map = loadedMaps.get(size) ?? loadMilkyWay(device, MILKY_WAY_MAPS[size]).catch(() => null);
    loadedMaps.set(size, map);
    return map;
}

/** The angle in radians a texel of a map `width` texels around spans: a finer map shows more once a pixel spans less. */
export const texelAngle = (width: number) => (2 * Math.PI) / width;

/** The map a view needs whose pixel at its center spans `pixel` radians: the 8K map, 18.5 MB, only once a pixel spans
 *  less than a texel of the 4K map, 5.3 arcminutes; the 4K map below the 2K map's 10.5. */
export function mapForPixel(pixel: number): MapSize {
    return pixel < texelAngle(MILKY_WAY_MAPS.large.width)
        ? "8k"
        : pixel < texelAngle(MILKY_WAY_MAPS.small.width)
          ? "large"
          : "small";
}

/** One frame: the sky, the view and the switches. */
export interface StarsFrame {
    sky: SkyAt;
    luts: AtmosphereLUTs;
    /** The canvas' format, SDR or HDR, and how many times SDR white the display may show. */
    format: GPUTextureFormat;
    headroom: number;
    toneMap: ToneCurveName;
    width: number;
    height: number;
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    pixelRatio: number;
    /** Null to meter: the sky where it is brighter than the stars' own light, else the Milky Way. */
    ev100: number | null;
    stars: boolean;
    /** The Hipparcos stars besides the bright star catalog's. */
    faintStars: boolean;
    /** The deep stars, Tycho-2's, fetched once asked for. */
    deepStars: boolean;
    milkyWay: boolean;
    /** The map of the Milky Way, or "auto" for the one the view's pixels need, the next finer drawn once it is there. */
    maps: MapSize | "auto";
    /** The air: refraction, extinction and the horizon it shows. */
    air: boolean;
    /** The stars twinkling, at the time given in seconds. */
    twinkle: boolean;
    time: number;
    /** The halos around bright stars, and their strength, the share of the light past the knee they show, 1 by default. */
    glare: boolean;
    halo?: number;
    /** Artistic offsets in stops on the stars' and the Milky Way's light, 0 by default, physical. */
    starCompensation?: number;
    milkyWayCompensation?: number;
    darkAdapted: boolean;
    moon: boolean;
    /** The constellations to draw the lines of, by abbreviation; null for all, empty for none. */
    constellations: readonly string[] | null;
    /** dunstkreis' grid over the sky: altitude lines every 10°, the compass directions and the Sun's symbol. */
    grid?: boolean;
    /** A grid on the ground under the air, for a view in flight: how far it has flown, in km east and north. */
    ground?: { east: number; north: number } | null;
}

/**
 * The stars over dunstkreis' sky, under nachtgestirn's Moon, into a canvas' texture: the sky pass in cd/m² into a float
 * texture, the stars pass over it into a second, and the Moon pass composing and tone mapping into the canvas.
 * `requestRender` is called whenever something it waited for arrived.
 */
// How fast the metered exposure follows the sky, in seconds: a camera's meter, a little slower towards the dark.
const ADAPTATION = { toBrighter: 0.5, toDarker: 1 };
// The metered exposure lets in no more light than EV100 -2.5 at night: a night stays dark, not a long exposure's.
const DARKEST_EV100 = -2.5;

// Earth's gravitational parameter in m³/s²: how fast a circular orbit runs at a height.
const EARTH_GM = 3.986004418e14;

/** How fast the observer crosses the turbulence's line of sight, in m/s: a circular orbit's speed above the air, none
 *  below its top, where the observer stands or flies slowly next to the wind. */
export function observerSpeed(heightM: number, model: AtmosphereModel): number {
    const { groundRadiusKm, thicknessKm } = model.planet;
    return heightM / 1000 > thicknessKm ? Math.sqrt(EARTH_GM / (groundRadiusKm * 1000 + heightM)) : 0;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

/** The angle in radians the pixel at a view's center spans, `height` pixels high: as wide for a bent projection, whose
 *  scale at the center is the pinhole's. */
export function pixelAngle(inverseViewProjection: Float32Array, height: number): number {
    const m = inverseViewProjection;
    return 2 * Math.atan(Math.hypot(m[4] ?? 0, m[5] ?? 0, m[6] ?? 0) / height);
}

export function createStarsRenderer(device: GPUDevice, requestRender: () => void) {
    let adapted: { ev100: number; at: number } | null = null;
    let sky: { pass: SkyPass; luts: AtmosphereLUTs; grid: boolean } | null = null;
    let skyBuilding: { luts: AtmosphereLUTs; grid: boolean } | null = null;
    let gridPass: ReturnType<typeof createGridPass> | null = null;
    let starsPass: { pass: StarsPass; key: string } | null = null;
    let starsBuilding = "";
    let moonPass: { pass: MoonPass; key: string } | null = null;
    let moonBuilding = "";
    let catalog: StarCatalog | null = null;
    let constellations: ConstellationLines | null = null;
    let faintStars: PackedStars | null = null;
    let deepStars: DeepStars | null = null;
    let deepState: "none" | "loading" | "loaded" | "missing" = "none";
    let moonMaps: MoonMaps | null = null;
    let milkyWay: MilkyWay | null = null;
    let mapsBound: MapSize | "" = "";
    let mapsWanted: MapSize | "" = "";
    let background: GPUTexture | null = null;
    let groundPass: ReturnType<typeof groundGrid> | null = null;
    let composed: GPUTexture | null = null;
    let skyEV100 = Number.NEGATIVE_INFINITY;
    let skyMeteredFor = "";
    // What the camera sees, metered: the frame's sky and stars in cd/m², the ground and the Moon's disc left out.
    let meter: MeterPass | null = null;
    let metering = false;
    let frameLuminance: number | null = null;
    createMeterPass(device, { source: "2d" }).then((created) => {
        meter = created;
        requestRender();
    });
    // The air table of the observer's height, on the CPU and as the stars pass reads it, and the seeing there.
    let air: { key: string; table: AirTable; texture: GPUTexture; seeing: Float32Array } | null = null;
    function airFor(heightM: number, model: AtmosphereModel) {
        const key = `${heightM} ${model.refractivity} ${model.planet.groundRadiusKm} ${model.planet.thicknessKm}`;
        if (air?.key === key) return air;
        air?.texture.destroy();
        const table = airTable(model, heightM);
        const seeing = seeingUniformData({ speed: observerSpeed(heightM, model) });
        air = { key, table, texture: createAirTexture(device, table), seeing };
        return air;
    }

    sharedMoonMaps ??= loadMoonMaps(device, MOON_MAPS_WHOLE["512"]);
    sharedMoonMaps.then((loaded) => {
        moonMaps = loaded;
        moonPass?.pass.destroy();
        moonPass = null;
        moonBuilding = "";
        requestRender();
    });
    sharedCatalog ??= Promise.all([loadCatalog(), loadConstellations(), loadFaintStars().catch(() => null)]);
    sharedCatalog.then(([loaded, lines, faint]) => {
        catalog = loaded;
        constellations = lines;
        faintStars = faint;
        starsPass?.pass.destroy();
        starsPass = null;
        starsBuilding = "";
        requestRender();
    });

    function buildSky(luts: AtmosphereLUTs, grid: boolean) {
        if (skyBuilding?.luts === luts && skyBuilding.grid === grid) return;
        const building = { luts, grid };
        skyBuilding = building;
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
            if (skyBuilding !== building) return pass.destroy();
            sky?.pass.destroy();
            sky = { pass, luts, grid };
            skyBuilding = null;
            skyMeteredFor = "";
            requestRender();
        });
    }
    function buildStars(key: string) {
        if (starsBuilding === key) return;
        starsBuilding = key;
        createStarsPass(device, {
            format: "rgba32float",
            toneMap: false,
            catalog,
            constellations,
            faintStars,
            deepStars,
            // The faint stars crowd the Milky Way's tiles in a wide view.
            capacity: 256,
            milkyWay,
            dither: false,
        }).then((pass) => {
            if (starsBuilding !== key) return pass.destroy();
            starsPass?.pass.destroy();
            starsPass = { pass, key };
            starsBuilding = "";
            requestRender();
        });
    }
    function buildMoon(key: string, { format, headroom, toneMap, darkAdapted }: StarsFrame) {
        if (moonBuilding === key) return;
        moonBuilding = key;
        createMoonPass(device, {
            format,
            headroom,
            toneMap,
            // Over the night sky's gradients: dithered for an 8-bit target.
            dither: format === "rgba8unorm",
            background: true,
            maps: moonMaps,
            darkAdapted,
            samples: 4,
        }).then((pass) => {
            if (moonBuilding !== key) return pass.destroy();
            moonPass?.pass.destroy();
            moonPass = { pass, key };
            moonBuilding = "";
            requestRender();
        });
    }
    function loadDeep() {
        if (deepState !== "none") return;
        deepState = "loading";
        deepStarsOnce().then((loaded) => {
            deepStars = loaded;
            deepState = loaded ? "loaded" : "missing";
            requestRender();
        });
    }
    // The pass drawing the map before keeps drawing until the stars pass with the one wanted is made.
    function loadMaps(size: MapSize) {
        if (mapsWanted === size) return;
        mapsWanted = size;
        milkyWayOnce(device, size).then((loaded) => {
            if (mapsWanted !== size || !loaded) return;
            milkyWay = loaded;
            mapsBound = size;
            requestRender();
        });
    }
    function texture(label: string, width: number, height: number) {
        return device.createTexture({
            label,
            size: [width, height],
            format: "rgba32float",
            usage:
                GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
        });
    }

    return {
        /** The catalog, once loaded. */
        catalog: () => catalog,
        /** Whether the faint stars are missing, once the catalog is there. */
        faintMissing: () => catalog !== null && faintStars === null,
        /** The deep stars once asked for: being fetched, there with their count, or missing. */
        deepStars: () => ({ state: deepState, count: deepStars?.count ?? 0 }),
        /** Draws `frame` into `target`; null while a pass is still being made, which calls `requestRender` when done. */
        draw(target: GPUTexture, frame: StarsFrame) {
            const { sky: s, luts, width, height } = frame;
            const grid = frame.grid ?? false;
            if (!sky || sky.luts !== luts || sky.grid !== grid) {
                buildSky(luts, grid);
                if (!sky || sky.luts !== luts) return null;
            }
            loadMaps(frame.maps === "auto" ? mapForPixel(pixelAngle(frame.inverseViewProjection, height)) : frame.maps);
            if (frame.deepStars) loadDeep();
            const starsKey = `${catalog ? "stars" : "none"} ${mapsBound} ${deepStars ? "deep" : ""}`;
            if (!starsPass || starsPass.key !== starsKey) {
                buildStars(starsKey);
                if (!starsPass) return null;
            }
            const moonKey = `${frame.format} ${frame.headroom} ${frame.toneMap} ${frame.darkAdapted} ${moonMaps ? "maps" : "plain"}`;
            if (!moonPass || moonPass.key !== moonKey) {
                buildMoon(moonKey, frame);
                return null;
            }
            if (!background || background.width !== width || background.height !== height) {
                background?.destroy();
                composed?.destroy();
                background = texture("sternwarte:starsBackground", width, height);
                composed = texture("sternwarte:starsComposed", width, height);
            }
            if (!composed) return null;

            // The air over the sky, rebuilt when the air or the observer changed.
            const theAir = frame.air ? airFor(s.heightM, s.model) : null;
            const moonShown = theAir ? liftedDirection(theAir.table, s.moonDirection) : s.moonDirection;
            const ground = frame.air ? horizonZ(s.heightM, s.model.planet.groundRadiusKm) : -1;
            // Metered on the sky where it is brighter than the stars' light, else on the Milky Way, a texel of its mean,
            // some 24 magnitudes per square arcsecond, and on the moonlit sky, some 0.05 cd/m² per lux of the Moon at the
            // observer; then lowered as the eye finds a dim scene, so night stays dark instead of a pale day.
            const milkyWay = 1.7e-3 * 0.027;
            const moonlit =
                frame.moon && frame.air && s.moonDirection[2] > 0 ? 0.05 * s.moonIlluminance * s.moonDirection[2] : 0;
            // Until the frame is metered, on the whole sky's light and on what the Moon lends it.
            const guess = Math.max(frame.air ? 2 ** (skyEV100 - 3) : 0, moonlit);
            // A bright body in the frame veils the eye, by CIE's glare equation at its angle from where the eye looks: the
            // Sun exposes as day wherever it stands, also over a black sky, and the Moon dims the stars around it.
            const m = frame.inverseViewProjection;
            const along = (x: number, y: number) => {
                const w = m[3] * x + m[7] * y + m[11] + m[15];
                const d = [0, 1, 2].map((i) => (m[i] * x + m[4 + i] * y + m[8 + i] + m[12 + i]) / w);
                const length = Math.hypot(...d);
                return d.map((c) => c / length);
            };
            const forward = along(0, 0);
            const reach = Math.acos(Math.min(dot(forward, along(1, 1)), 1));
            const veil = (direction: ArrayLike<number>, lux: number) => {
                const angle = Math.acos(Math.max(Math.min(dot(forward, direction), 1), -1));
                return angle < reach ? lux * veilingGlare((angle * 180) / Math.PI) : 0;
            };
            const veiled = veil(s.sunDirection, s.sunAtEye) + (frame.moon ? veil(s.moonDirection, s.moonAtEye) : 0);
            const metered = Math.max(frameLuminance ?? guess, milkyWay) + veiled;
            const automatic = ev100FromLuminance(metered) - lowLightCompensation(metered);
            const goal = Math.min(Math.max(automatic, DARKEST_EV100), 20);
            // Followed over time, each step at most a 30th of a second, so a jump after a pause eases in too.
            const now = performance.now();
            const seconds = adapted ? Math.min((now - adapted.at) / 1000, 1 / 30) : 0;
            const following = adapted ? adaptEV100(adapted.ev100, goal, seconds, ADAPTATION) : goal;
            adapted = { ev100: following, at: now };
            const adapting = frame.ev100 === null && Math.abs(following - goal) > 0.01;
            const ev100 = frame.ev100 ?? following;

            const started = performance.now();
            const view = {
                inverseViewProjection: frame.inverseViewProjection,
                projectionDistance: frame.projectionDistance,
            };
            sky.pass.update({
                ...view,
                sunDirection: s.sunDirection,
                sunAngularDiameter: s.sunAngularDiameter,
                observerHeightM: s.heightM,
                // The disc's edge stays smooth through the Moon pass' tone curve: twice what it shows as white.
                sunDiscCeiling: 2 * frame.headroom * 1.2 * 2 ** ev100,
                pixelRatio: frame.pixelRatio,
                ev100: UNIT_EV100,
                // The grid in an eighth of what the Moon pass exposes as white, as nachtgestirn's Moon figure draws it.
                gridInk: (1.2 * 2 ** ev100) / 8,
                autoExposureKeys: [],
                autoExposureRange: [-20, 20],
                moonDirection: s.moonDirection,
                moonIlluminance: frame.moon ? s.moonIlluminance : 0,
                moonAngularDiameter: frame.moon ? s.moonAngularDiameter : 0,
            });
            // The stars pass writes cd/m² for the Moon pass to expose; its cut-off, knee and halo follow the display's.
            starsPass.pass.update({
                ...view,
                skyRotation: s.skyRotation,
                years: s.years,
                ev100: UNIT_EV100,
                displayEV100: ev100,
                // A star's core as bright as the display shows, so on an HDR display the points outshine SDR white.
                knee: frame.headroom,
                horizonZ: ground,
                occluder: frame.moon ? { direction: moonShown, angularDiameter: s.moonAngularDiameter } : null,
                air: theAir && { texture: theAir.texture, horizon: theAir.table.horizon },
                seeing: frame.twinkle && theAir ? theAir.seeing : null,
                time: frame.time,
                halo: frame.glare ? (frame.halo ?? 1) : 0,
                constellations: frame.constellations,
                faintStars: frame.faintStars ? Number.POSITIVE_INFINITY : 0,
                deepStars: frame.deepStars ? Number.POSITIVE_INFINITY : 0,
                constellationWidth: 1.25 * frame.pixelRatio,
                constellationGap: 4 * frame.pixelRatio,
                starLight: frame.stars ? 1 : 0,
                milkyWay: frame.milkyWay ? 1 : 0,
                starCompensation: frame.starCompensation ?? 0,
                milkyWayCompensation: frame.milkyWayCompensation ?? 0,
            });
            const refraction = frame.air
                ? refractionTable(s.moonDirection, s.moonAngularDiameter, s.bend, s.through)
                : null;
            moonPass.pass.update({
                ...view,
                direction: s.moonDirection,
                angularDiameter: s.moonAngularDiameter,
                sunDirection: s.moonSunDirection,
                sunIlluminance: frame.moon ? SUN_ILLUMINANCE : 0,
                earthshine: frame.moon ? s.earthshine : 0,
                // As the eye sees the Moon, adapted to it, however long the night around it is exposed.
                exposureCompensation: localAdaptation(ev100, s.moonEV100 + (frame.air ? s.moonAirStops : 0)),
                orientation: s.moonOrientation,
                ev100,
                horizonZ: ground,
                albedoMap: true,
                relief: true,
                shadows: true,
                eclipse: null,
                sunAngularDiameter: s.sunAngularDiameter,
                refraction,
                distanceKm: s.distanceKm - s.model.planet.groundRadiusKm * s.moonDirection[2],
            });
            const encoder = device.createCommandEncoder({ label: "sternwarte:stars" });
            let behind = background;
            if (frame.air) {
                sky.pass.encode(encoder, background);
                if (frame.ground) {
                    groundPass ??= groundGrid(device);
                    const radiusKm = s.model.planet.groundRadiusKm;
                    behind = groundPass.encode(encoder, background, {
                        inverseViewProjection: frame.inverseViewProjection,
                        projectionDistance: frame.projectionDistance,
                        heightM: s.heightM,
                        radiusKm,
                        flown: frame.ground,
                    });
                }
            } else if (grid) {
                gridPass ??= createGridPass(device);
                gridPass.encode(encoder, background, {
                    ...view,
                    pixelRatio: frame.pixelRatio,
                    sunDirection: s.sunDirection,
                    sunAngularDiameter: s.sunAngularDiameter,
                    ink: (1.2 * 2 ** ev100) / 8,
                });
            } else {
                encoder
                    .beginRenderPass({
                        colorAttachments: [{ view: background.createView(), loadOp: "clear", storeOp: "store" }],
                    })
                    .end();
            }
            starsPass.pass.encode(encoder, composed, { background: behind });
            moonPass.pass.encode(encoder, target, { background: composed });
            device.queue.submit([encoder.finish()]);
            const passesMs = performance.now() - started;
            if (meter && !metering && frame.ev100 === null) {
                metering = true;
                const reading = device.createCommandEncoder({ label: "sternwarte:starsMeter" });
                meter.encode(reading, composed, { maxSize: 256 });
                device.queue.submit([reading.finish()]);
                meter.readHistogram().then((histogram) => {
                    metering = false;
                    // The ground and empty space are black, not dark: they say nothing about the light.
                    histogram.luminance[0] = 0;
                    const luminance = meteredLuminance(histogram);
                    const stops = Math.log2((luminance + 1e-9) / ((frameLuminance ?? 0) + 1e-9));
                    if (frameLuminance !== null && Math.abs(stops) < 0.05) return;
                    frameLuminance = luminance;
                    requestRender();
                });
            }
            const skyKey = `${s.jd},${s.heightM},${frame.moon}`;
            if (frame.air && skyKey !== skyMeteredFor) {
                skyMeteredFor = skyKey;
                const { pass } = sky;
                pass.meteredEV100().then((value) => {
                    if (sky?.pass !== pass || Math.abs(value - skyEV100) < 0.05) return;
                    skyEV100 = value;
                    if (frame.ev100 === null) requestRender();
                });
            }
            return { ev100, adapting, passesMs, air: theAir?.table ?? null };
        },
    };
}

/** How many of the catalog's stars stand above the horizon at the moment, and Sirius' altitude, both on the CPU. */
export function starsAbove(catalog: StarCatalog, sky: SkyAt, air: AirTable | null) {
    let above = 0;
    let brightest = 0;
    let siriusAltitude = -90;
    for (let i = 0; i < catalog.count; i++) {
        const star = starAt(catalog, i);
        const v = stars.applyMatrix3(sky.skyRotation, stars.equatorialToVector(star));
        const direction = air ? liftedDirection(air, v) : v;
        const altitude = Math.asin(Math.min(Math.max(direction[2], -1), 1)) / DEG;
        if (altitude > (air ? air.horizon : 0)) above++;
        if (star.magnitude < starAt(catalog, brightest).magnitude) {
            brightest = i;
            siriusAltitude = altitude;
        }
    }
    return { above, siriusAltitude };
}

/** The inverse view-projection of a camera looking along `forward` with `up` up, `tx` and `ty` the tangents of half
 *  its fields of view, as dunstkreis' sky pass takes it. */
export function inverseViewProjection(
    forward: readonly number[],
    right: readonly number[],
    up: readonly number[],
    tx: number,
    ty: number,
) {
    return new Float32Array([...right.map((c) => c * tx), 0, ...up.map((c) => c * ty), 0, 0, 0, 0, 1, ...forward, 0]);
}
