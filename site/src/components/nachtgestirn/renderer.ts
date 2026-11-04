import type { AtmosphereLUTs, AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import { clampObserverHeight, createSkyPass, refractionAngle } from "@himmelszelt/dunstkreis";
import type { EarthShadow, MoonMapFiles, MoonMaps, MoonPass } from "@himmelszelt/nachtgestirn";
import {
    createMoonPass,
    earthshineIlluminance,
    horizonZ,
    liftedDirection,
    loadMoonMaps,
    MOON_MAPS,
    mapWidthFor,
    moonEV100,
    moonIlluminance,
    moonOrientation,
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
import { createTransmittance, type Rgb } from "./transmittance";

// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);

export type ToneCurveName = "neutral" | "agx" | "aces" | "clip";
/** Which of nachtgestirn's maps: "auto" the smallest that shows the disc at a texel per pixel, never a smaller one
 *  than before. */
export type MapSize = "auto" | keyof typeof MOON_MAPS;
const SIZES = ["small", "medium", "large"] as const;
type Libration = { longitude: number; latitude: number };

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
        const geocentric = equatorialToHorizontal(moon.apparentPosition(jde), apparentSiderealTime(time), observer);
        const center = horizontalToDirection(geocentric);
        earthShadow = {
            axis: [-sunDirection[0], -sunDirection[1], -sunDirection[2]],
            moonCenterKm: [center[0] * distanceKm, center[1] * distanceKm, center[2] * distanceKm],
            umbraKm: shadow.umbraRadiusKm,
            penumbraKm: shadow.penumbraRadiusKm,
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
        moonSunDirection: moon.sunDirection(time, observer),
        distanceKm,
        earthshine: earthshineIlluminance(180 - phaseAngle, distanceKm),
        shadow,
        earthShadow,
    };
}
export type MoonAt = ReturnType<typeof moonAt>;

// The maps once per page, however many figures draw the Moon.
const loadedMaps = new Map<MoonMapFiles, Promise<MoonMaps>>();
function sharedMaps(device: GPUDevice, files: MoonMapFiles) {
    const maps = loadedMaps.get(files) ?? loadMoonMaps(device, files);
    loadedMaps.set(files, maps);
    return maps;
}

/** One frame: the Moon, the view and the switches. */
export interface MoonFrame {
    moon: MoonAt;
    luts: AtmosphereLUTs;
    toneMap: ToneCurveName;
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
    /** Null to meter: the Moon's lit part, or the sky around it where that is brighter. */
    ev100: number | null;
    albedo: boolean;
    relief: boolean;
    shadows: boolean;
    earthshine: boolean;
    eclipse: boolean;
    law: "hapke" | "lambert";
}

/**
 * The Moon over dunstkreis' sky, into a canvas' texture: the sky pass in cd/m² into a float texture, nachtgestirn's
 * pass composed over it, the maps (the smallest that shows the disc sharply, or the ones asked for), the air towards the
 * Moon and the sky's meter, each remade or read back when needed. `requestRender` is called whenever something it
 * waited for arrived.
 */
export function createMoonRenderer(device: GPUDevice, requestRender: () => void) {
    let sky: { pass: SkyPass; luts: AtmosphereLUTs } | null = null;
    let skyBuilding: AtmosphereLUTs | null = null;
    let moonPass: { pass: MoonPass; key: string } | null = null;
    let moonBuilding = "";
    let maps: MoonMaps | null = null;
    // The pair bound, and the one on its way or bound.
    let mapsBound = "";
    let mapsWanted = "";
    let background: GPUTexture | null = null;
    // What the air lets through towards the Moon, read back after each change of the sky.
    const air = createTransmittance(device);
    let transmittance: Rgb = [1, 1, 1];
    let transmittanceFor = "";
    // dunstkreis' meter on the sky, read back whenever the sky view may have been rebuilt: by day the sky sets the exposure.
    let skyEV100 = Number.NEGATIVE_INFINITY;
    let skyMeteredFor = "";

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
            transmittanceFor = "";
            skyMeteredFor = "";
            requestRender();
        });
    }
    function buildMoon(key: string, toneMap: ToneCurveName) {
        if (moonBuilding === key) return;
        moonBuilding = key;
        createMoonPass(device, { format: SDR, toneMap, maps }).then((pass) => {
            if (moonBuilding !== key) return pass.destroy();
            moonPass?.pass.destroy();
            moonPass = { pass, key };
            moonBuilding = "";
            requestRender();
        });
    }
    function loadMaps(size: (typeof SIZES)[number]) {
        if (mapsWanted === size) return;
        mapsWanted = size;
        sharedMaps(device, MOON_MAPS[size]).then((loaded) => {
            if (mapsWanted !== size) return;
            maps = loaded;
            mapsBound = size;
            // The pass binds the maps when it is made: made anew with them.
            moonBuilding = "";
            moonPass?.pass.destroy();
            moonPass = null;
            requestRender();
        });
    }

    return {
        /** Draws `frame` into `target`; null while a pass is still being made, which calls `requestRender` when done. */
        draw(target: GPUTexture, frame: MoonFrame) {
            const { moon: m, luts, width, height } = frame;
            if (!sky || sky.luts !== luts) {
                buildSky(luts);
                return null;
            }
            // The maps asked for, or the smallest that shows the disc sharply, but never smaller than the ones bound.
            const needed =
                SIZES.find((size) => (MOON_MAPS[size].width ?? 0) >= mapWidthFor(frame.discPixels)) ?? "large";
            const kept = mapsBound === "" ? 0 : SIZES.indexOf(mapsBound as (typeof SIZES)[number]);
            loadMaps(frame.maps === "auto" ? (SIZES[Math.max(SIZES.indexOf(needed), kept)] ?? "large") : frame.maps);
            const key = `${frame.toneMap} ${maps ? mapsBound : "plain"}`;
            if (!moonPass || moonPass.key !== key) {
                buildMoon(key, frame.toneMap);
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

            // The air towards the Moon, asked for anew whenever the sky or the Moon moved; the last answer until then.
            const airKey = `${m.jd},${m.trueDirection.join(",")},${m.heightM},${quality.model},${quality.refraction}`;
            if (frame.air && airKey !== transmittanceFor) {
                air.at(luts, m.heightM / 1000, m.direction[2]).then((t) => {
                    if (!t) return;
                    transmittanceFor = airKey;
                    transmittance = t;
                    requestRender();
                });
            }
            const through = frame.air ? (transmittance[0] + transmittance[1] + transmittance[2]) / 3 : 1;
            // Metered on the lit part of the disc outside the umbra, down to a ten thousandth of it, the umbra's own
            // light, or on the sky around it where that is brighter, so neither burns out.
            const outsideUmbra = frame.eclipse ? Math.max(1 - Math.max(m.shadow.umbralMagnitude, 0), 1e-4) : 1;
            const metered = Math.max(
                moonEV100(m.phaseAngle, m.lit, Math.max(through, 1e-3) * outsideUmbra),
                frame.air ? skyEV100 : Number.NEGATIVE_INFINITY,
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
                autoExposureKeys: [],
                // Metered for the figure's own exposure, down into the night, where the Moon sets it.
                autoExposureRange: [-6, 20],
                // The sky by moonlight, dimmed in Earth's shadow as the disc is.
                moonDirection: m.trueDirection,
                moonIlluminance: moonIlluminance(m.phaseAngle, m.distanceKm) * outsideUmbra,
            });
            moonPass.pass.update({
                ...view,
                direction: m.trueDirection,
                angularDiameter: frame.air ? m.angularDiameter : m.geocentricDiameter,
                sunDirection: m.moonSunDirection,
                sunIlluminance: SUN_ILLUMINANCE,
                earthshine: frame.earthshine ? m.earthshine : 0,
                orientation: m.orientation,
                transmittance: frame.air ? transmittance : [1, 1, 1],
                ev100,
                horizonZ: frame.air ? horizonZ(m.heightM, m.model.planet.groundRadiusKm) : -1,
                albedoMap: frame.albedo,
                relief: frame.relief,
                shadows: frame.shadows,
                law: frame.law,
                eclipse: frame.eclipse ? m.earthShadow : null,
                sunAngularDiameter: m.sunAngularDiameter,
                refraction: frame.air ? refractionTable(m.trueDirection, m.angularDiameter, m.bend) : null,
                // From the observer, an Earth radius nearer when the Moon is overhead.
                distanceKm: m.distanceKm - m.model.planet.groundRadiusKm * m.trueDirection[2],
            });
            const encoder = device.createCommandEncoder({ label: "sternwarte:moon" });
            if (frame.air) {
                sky.pass.encode(encoder, background);
            } else {
                encoder
                    .beginRenderPass({
                        colorAttachments: [{ view: background.createView(), loadOp: "clear", storeOp: "store" }],
                    })
                    .end();
            }
            moonPass.pass.encode(encoder, target, { background });
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
