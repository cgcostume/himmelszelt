import type { AtmosphereLUTs, AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import { airTransmittance, clampObserverHeight, createSkyPass, refractionAngle } from "@himmelszelt/dunstkreis";
import type { MoonMaps, MoonPass } from "@himmelszelt/nachtgestirn";
import {
    createMoonPass,
    earthshineIlluminance,
    horizonZ,
    loadMoonMaps,
    MOON_MAPS,
    moonIlluminance,
    moonOrientation,
    refractionTable,
    SUN_ILLUMINANCE,
} from "@himmelszelt/nachtgestirn";
import type { AirTable, MilkyWay, StarCatalog, StarsPass } from "@himmelszelt/sternenheer";
import {
    airTable,
    createStarsPass,
    liftedDirection,
    loadCatalog,
    loadMilkyWay,
    MILKY_WAY_MAPS,
    starAt,
} from "@himmelszelt/sternenheer";
import { apparentSiderealTime, fromJulianDay, julianEphemerisDay, moon, stars, sun } from "@himmelszelt/sternzeit";
import { quality, SDR } from "../dunstkreis/atmosphere";

// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
const DEG = Math.PI / 180;

export type ToneCurveName = "neutral" | "agx" | "aces" | "clip";
export type MapSize = "small" | "large";

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
        sunDirection: sun.direction(time, observer),
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
        distanceKm,
    };
}
export type SkyAt = ReturnType<typeof skyAt>;

// The catalog and the maps once per page, however many figures draw the stars; the Moon's small maps, as the disc
// stays small in a view of the whole sky.
let sharedCatalog: Promise<StarCatalog> | null = null;
let sharedMoonMaps: Promise<MoonMaps> | null = null;
const loadedMaps = new Map<MapSize, Promise<MilkyWay>>();
function sharedMilkyWay(device: GPUDevice, size: MapSize) {
    const map = loadedMaps.get(size) ?? loadMilkyWay(device, MILKY_WAY_MAPS[size]);
    loadedMaps.set(size, map);
    return map;
}

/** One frame: the sky, the view and the switches. */
export interface StarsFrame {
    sky: SkyAt;
    luts: AtmosphereLUTs;
    toneMap: ToneCurveName;
    width: number;
    height: number;
    inverseViewProjection: Float32Array;
    projectionDistance: number;
    pixelRatio: number;
    /** Null to meter: the sky where it is brighter than the stars' own light, else the Milky Way. */
    ev100: number | null;
    stars: boolean;
    milkyWay: boolean;
    maps: MapSize;
    /** The air: refraction, extinction and the horizon it shows. */
    air: boolean;
    /** The stars twinkling, at the time given in seconds. */
    twinkle: boolean;
    time: number;
    /** The eye's veil around bright stars. */
    glare: boolean;
    nightVision: boolean;
    magnitudeLimit: number;
    moon: boolean;
}

/**
 * The stars over dunstkreis' sky, under nachtgestirn's Moon, into a canvas' texture: the sky pass in cd/m² into a float
 * texture, the stars pass over it into a second, and the Moon pass composing and tone mapping into the canvas.
 * `requestRender` is called whenever something it waited for arrived.
 */
export function createStarsRenderer(device: GPUDevice, requestRender: () => void) {
    let sky: { pass: SkyPass; luts: AtmosphereLUTs } | null = null;
    let skyBuilding: AtmosphereLUTs | null = null;
    let starsPass: { pass: StarsPass; key: string } | null = null;
    let starsBuilding = "";
    let moonPass: { pass: MoonPass; key: string } | null = null;
    let moonBuilding = "";
    let catalog: StarCatalog | null = null;
    let moonMaps: MoonMaps | null = null;
    let milkyWay: MilkyWay | null = null;
    let mapsBound: MapSize | "" = "";
    let mapsWanted: MapSize | "" = "";
    let background: GPUTexture | null = null;
    let composed: GPUTexture | null = null;
    let skyEV100 = Number.NEGATIVE_INFINITY;
    let skyMeteredFor = "";
    let airFor = "";
    let air: AirTable | null = null;

    sharedMoonMaps ??= loadMoonMaps(device, MOON_MAPS["512"]);
    sharedMoonMaps.then((loaded) => {
        moonMaps = loaded;
        moonPass?.pass.destroy();
        moonPass = null;
        moonBuilding = "";
        requestRender();
    });
    sharedCatalog ??= loadCatalog();
    sharedCatalog.then((loaded) => {
        catalog = loaded;
        starsPass?.pass.destroy();
        starsPass = null;
        starsBuilding = "";
        requestRender();
    });

    function buildSky(luts: AtmosphereLUTs) {
        if (skyBuilding === luts) return;
        skyBuilding = luts;
        createSkyPass(device, {
            luts,
            format: "rgba32float",
            toneMap: false,
            autoExposure: false,
            moonlight: true,
            groundLight: quality.groundLight,
            dither: false,
        }).then((pass) => {
            if (skyBuilding !== luts) return pass.destroy();
            sky?.pass.destroy();
            sky = { pass, luts };
            skyBuilding = null;
            skyMeteredFor = "";
            requestRender();
        });
    }
    function buildStars(key: string) {
        if (starsBuilding === key) return;
        starsBuilding = key;
        createStarsPass(device, { format: "rgba32float", toneMap: false, catalog, milkyWay, dither: false }).then(
            (pass) => {
                if (starsBuilding !== key) return pass.destroy();
                starsPass?.pass.destroy();
                starsPass = { pass, key };
                starsBuilding = "";
                requestRender();
            },
        );
    }
    function buildMoon(key: string, { toneMap, nightVision }: StarsFrame) {
        if (moonBuilding === key) return;
        moonBuilding = key;
        createMoonPass(device, {
            format: SDR,
            toneMap,
            background: true,
            maps: moonMaps,
            nightVision,
            samples: 4,
        }).then((pass) => {
            if (moonBuilding !== key) return pass.destroy();
            moonPass?.pass.destroy();
            moonPass = { pass, key };
            moonBuilding = "";
            requestRender();
        });
    }
    function loadMaps(size: MapSize) {
        if (mapsWanted === size) return;
        mapsWanted = size;
        sharedMilkyWay(device, size).then((loaded) => {
            if (mapsWanted !== size) return;
            milkyWay = loaded;
            mapsBound = size;
            starsPass?.pass.destroy();
            starsPass = null;
            starsBuilding = "";
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
        /** Draws `frame` into `target`; null while a pass is still being made, which calls `requestRender` when done. */
        draw(target: GPUTexture, frame: StarsFrame) {
            const { sky: s, luts, width, height } = frame;
            if (!sky || sky.luts !== luts) {
                buildSky(luts);
                return null;
            }
            loadMaps(frame.maps);
            const starsKey = `${catalog ? "stars" : "none"} ${mapsBound}`;
            if (!starsPass || starsPass.key !== starsKey) {
                buildStars(starsKey);
                return null;
            }
            const moonKey = `${frame.toneMap} ${frame.nightVision} ${moonMaps ? "maps" : "plain"}`;
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
            const airKey = `${s.heightM} ${s.model.refractivity}`;
            if (frame.air && airKey !== airFor) {
                airFor = airKey;
                air = airTable(s.bend, s.through);
            }
            const theAir = frame.air ? air : null;
            const ground = frame.air ? horizonZ(s.heightM, s.model.planet.groundRadiusKm) : -1;
            // Metered on the sky where it is brighter than the stars' light, else for the Milky Way: a texel of its
            // mean, some 24 magnitudes per square arcsecond, as mid gray.
            const milkyWayEV100 = Math.log2(8 * 1.7e-3 * 0.027) + 2;
            // And never brighter than the moonlit sky allows: the day's sky at the Moon's share of the Sun's light, some
            // 0.05 cd/m² per lux at the observer, a stop under mid gray so the stars keep their room.
            const moonlit =
                frame.moon && frame.air && s.moonDirection[2] > 0
                    ? Math.log2(8 * 0.05 * s.moonIlluminance * s.moonDirection[2]) - 1
                    : Number.NEGATIVE_INFINITY;
            const metered = Math.max(frame.air ? skyEV100 : Number.NEGATIVE_INFINITY, milkyWayEV100, moonlit);
            const ev100 = frame.ev100 ?? Math.min(Math.max(Math.round(metered * 10) / 10, -14), 20);

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
                pixelRatio: frame.pixelRatio,
                ev100: UNIT_EV100,
                autoExposureKeys: [],
                autoExposureRange: [-10, 20],
                moonDirection: s.moonDirection,
                moonIlluminance: frame.moon ? s.moonIlluminance : 0,
            });
            // The stars pass writes cd/m² for the Moon pass to expose; its cut-off follows the display's exposure.
            starsPass.pass.update({
                ...view,
                skyRotation: s.skyRotation,
                years: s.years,
                ev100: UNIT_EV100,
                threshold: (1 / 2048) * (1.2 * 2 ** ev100),
                horizonZ: ground,
                air: theAir,
                scintillation: frame.twinkle ? 1 : 0,
                time: frame.time,
                glare: frame.glare ? 1 : 0,
                starLight: frame.stars ? 1 : 0,
                milkyWay: frame.milkyWay ? 1 : 0,
                magnitudeLimit: frame.magnitudeLimit,
                heightM: s.heightM,
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
            if (frame.air) {
                sky.pass.encode(encoder, background);
            } else {
                encoder
                    .beginRenderPass({
                        colorAttachments: [{ view: background.createView(), loadOp: "clear", storeOp: "store" }],
                    })
                    .end();
            }
            starsPass.pass.encode(encoder, composed, { background });
            moonPass.pass.encode(encoder, target, { background: composed });
            device.queue.submit([encoder.finish()]);
            const passesMs = performance.now() - started;
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
            return { ev100, passesMs, air: theAir };
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
