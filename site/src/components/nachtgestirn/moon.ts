import type { AtmosphereLUTs, SkyPass } from "@himmelszelt/dunstkreis";
import { apparentDirection, clampObserverHeight, createSkyPass } from "@himmelszelt/dunstkreis";
import type { EarthShadow, MoonMaps, MoonPass } from "@himmelszelt/nachtgestirn";
import {
    createMoonPass,
    earthshineIlluminance,
    ev100ForLuminance,
    horizonZ,
    loadMoonMaps,
    meanLuminance,
    moonOrientation,
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
import { find } from "../dom";
import {
    bindToneCurveChoice,
    configureCanvas,
    display,
    gpuDevice,
    onDisplay,
    onTables,
    quality,
    SDR,
    gpu as shared,
    tables,
} from "../dunstkreis/atmosphere";
import { type Basis, cameraBasis, lookAround, project } from "../dunstkreis/skycamera";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { COMPASS } from "../sternzeit/figure";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";
import { createTransmittance, type Rgb } from "./transmittance";

const DEG = Math.PI / 180;
// The sky pass writes cd/m² when its exposure is 1: EV100 of -log2(1.2).
const UNIT_EV100 = -Math.log2(1.2);
// The Moon's lit surface exposed a stop over mid gray, as a photographer's "looney 11" does: EV100 13.6 at full Moon.
const MOON_COMPENSATION = 1;
// The maps from NASA's CGI Moon Kit, made by nachtgestirn's `pnpm maps`; the near side's mean reflectance it printed.
const MAPS = { color: "moon/moon-color-4k.webp", normals: "moon/moon-normals-2k.webp" };
const MEAN_REFLECTANCE = 0.396;

/**
 * The Moon figure on `root`, a `figure[data-moon]`: dunstkreis' sky in cd/m² into a float texture, nachtgestirn's
 * Moon composed over it into the canvas, both on the page's moment, place and tables. The view keeps to the Moon,
 * zoomed in so the disc fills a good part of it.
 */
export function moonFigure(root: HTMLElement) {
    const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const maybe = <T extends HTMLElement = HTMLElement>(name: string) =>
        root.querySelector<T>(`[data-field="${name}"]`);
    const canvas = field<HTMLCanvasElement>("canvas");
    const compass = field("compassLabels");
    const pressed = (name: string) => maybe(name)?.getAttribute("aria-pressed") === "true";
    const choice = (name: string) =>
        root.querySelector<HTMLInputElement>(`input[name="${root.id}-${name}"]:checked`)?.value ?? "";

    const camera = { yaw: 0, pitch: 0, fov: 1.5 * DEG };
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

    // The sky pass for the page's tables and the Moon pass for the chosen tone curve, each remade when needed.
    let sky: { pass: SkyPass; luts: AtmosphereLUTs } | null = null;
    let skyBuilding: AtmosphereLUTs | null = null;
    let moonPass: { pass: MoonPass; key: string } | null = null;
    let moonBuilding = "";
    let maps: MoonMaps | null = null;
    let background: GPUTexture | null = null;
    // What the air lets through towards the Moon, read back after each change of the sky.
    const air = gpu ? createTransmittance(gpu.device) : null;
    let transmittance: Rgb = [1, 1, 1];
    let transmittanceFor = "";
    // dunstkreis' meter on the sky, read back whenever the sky view may have been rebuilt: by day the sky sets the exposure.
    let skyEV100 = -Infinity;
    let skyMeteredFor = "";
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
    function buildMoon(key: string, toneMap: "neutral" | "agx" | "aces" | "clip") {
        if (!gpu || moonBuilding === key) return;
        moonBuilding = key;
        createMoonPass(gpu.device, { format: SDR, toneMap, maps }).then((pass) => {
            if (moonBuilding !== key) return pass.destroy();
            moonPass?.pass.destroy();
            moonPass = { pass, key };
            moonBuilding = "";
            requestRender();
        });
    }
    if (gpu) {
        const base = import.meta.env.BASE_URL;
        loadMoonMaps(
            gpu.device,
            { color: base + MAPS.color, normals: base + MAPS.normals },
            { meanReflectance: MEAN_REFLECTANCE },
        ).then((loaded) => {
            maps = loaded;
            // The pass binds the maps when it is made: made anew with them.
            moonBuilding = "";
            moonPass?.pass.destroy();
            moonPass = null;
            requestRender();
        });
    }

    // Where the time goes, with the compass shown twice: the astronomy, the passes' own CPU work, and when the GPU was done.
    function showTiming(astronomyMs: number, passesMs: number, submitted: number) {
        if (!gpu) return;
        const timing = maybe("timing");
        if (!timing) return;
        gpu.device.queue.onSubmittedWorkDone().then(() => {
            timing.textContent =
                marks() === 1
                    ? `${gpu.adapterName} · astronomy ${astronomyMs.toFixed(2)} ms · passes ${passesMs.toFixed(2)} ms · GPU done after ${(performance.now() - submitted).toFixed(2)} ms`
                    : "";
        });
    }

    // The slider runs brighter to the right, so it holds minus the EV100: a lower EV lets in more light.
    const evOfSlider = () => -Number(maybe<HTMLInputElement>("exposure")?.value ?? -14);
    function showExposure(ev100: number) {
        const slider = maybe<HTMLInputElement>("exposure");
        const note = maybe("ev");
        if (slider) {
            slider.disabled = pressed("auto");
            if (pressed("auto")) {
                slider.value = String(-ev100);
                paintRange(slider);
            }
        }
        if (note) note.textContent = ev100.toFixed(1);
    }

    function render() {
        const table = tables();
        if (!gpu || !table) return;
        if (!sky || sky.luts !== table.luts) {
            buildSky(table.luts);
            return;
        }
        const toneMap = choice("tone") as "neutral" | "agx" | "aces" | "clip";
        const key = `${toneMap} ${maps ? "maps" : "plain"}`;
        if (!moonPass || moonPass.key !== key) {
            buildMoon(key, toneMap);
            return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        if (!background || background.width !== width || background.height !== height) {
            background?.destroy();
            background = gpu.device.createTexture({
                label: "sternwarte:moonBackground",
                size: [width, height],
                format: "rgba32float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        }

        const started = performance.now();
        const time = fromJulianDay(state.jd);
        const jde = julianEphemerisDay(time);
        const observer = state;
        const heightM = clampObserverHeight(state.heightM);
        const { model } = table.luts;
        const sunDirection = sun.direction(time, observer);
        const sunAngularDiameter = sun.apparentAngularDiameter(jde);
        const horizontal = moon.horizontalPosition(time, observer);
        const trueDirection = moon.direction(time, observer);
        // Where the Moon shows, lifted by the same air the sky is traced through.
        const direction = apparentDirection(trueDirection, model, heightM);
        const angularDiameter = moon.topocentricAngularDiameter(time, observer);
        const phaseAngle = moon.phaseAngle(jde);
        const lit = moon.illuminatedFraction(jde);
        const waxing = moon.illuminatedFraction(jde + 0.5) > lit;
        const libration = moon.librations(jde);
        const orientation = moonOrientation({
            direction,
            libration,
            positionAngleOfAxis: moon.positionAngleOfAxis(jde),
            parallacticAngle: moon.parallacticAngle(time, observer),
        });
        const distanceKm = moon.distance(jde);
        const earthshine = earthshineIlluminance(180 - phaseAngle, distanceKm);
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
        const astronomyMs = performance.now() - started;

        // The air towards the Moon, asked for anew whenever the sky or the Moon moved; the last answer until then.
        const airKey = `${state.jd},${state.latitude},${state.longitude},${heightM},${quality.model},${quality.refraction}`;
        if (air && airKey !== transmittanceFor) {
            air.at(table.luts, heightM / 1000, direction[2]).then((t) => {
                if (!t) return;
                transmittanceFor = airKey;
                transmittance = t;
                requestRender();
            });
        }
        const through = (transmittance[0] + transmittance[1] + transmittance[2]) / 3;
        // Metered on the lit part of the disc outside the umbra, down to a ten thousandth of it, the umbra's own light.
        const outsideUmbra = pressed("eclipse") ? Math.max(1 - Math.max(shadow.umbralMagnitude, 0), 1e-4) : 1;
        const litLuminance = meanLuminance(phaseAngle, SUN_ILLUMINANCE, Math.max(through, 1e-3)) / Math.max(lit, 0.01);
        // Whichever is brighter sets the exposure, the Moon or the sky around it, so neither burns out.
        const metered = Math.max(ev100ForLuminance(litLuminance * outsideUmbra) - MOON_COMPENSATION, skyEV100);
        // Held to the slider's range: below the horizon the air lets nothing through, and the meter would run away.
        const ev100 = pressed("auto") ? Math.min(Math.max(Math.round(metered * 10) / 10, -6), 20) : evOfSlider();
        showExposure(ev100);

        if (pressed("lock")) {
            camera.yaw = Math.atan2(direction[0], direction[1]);
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(direction[2])));
        }
        const basis = cameraBasis(camera, width / height);
        const passesStarted = performance.now();
        sky.pass.update({
            sunDirection,
            sunAngularDiameter,
            observerHeightM: state.heightM,
            inverseViewProjection: inverseViewProjection(basis),
            projectionDistance: basis.d,
            pixelRatio: dpr,
            ev100: UNIT_EV100,
            autoExposureKeys: [],
        });
        moonPass.pass.update({
            direction,
            angularDiameter,
            sunDirection: moon.sunDirection(time, observer),
            sunIlluminance: SUN_ILLUMINANCE,
            earthshine: pressed("earthshine") ? earthshine : 0,
            orientation,
            transmittance,
            inverseViewProjection: inverseViewProjection(basis),
            projectionDistance: basis.d,
            ev100,
            horizonZ: horizonZ(heightM, model.planet.groundRadiusKm),
            albedoMap: pressed("albedo"),
            relief: pressed("relief"),
            law: choice("law") === "lambert" ? "lambert" : "hapke",
            eclipse: pressed("eclipse") ? earthShadow : null,
            sunAngularDiameter,
        });

        const note = maybe("moon");
        if (note) {
            const ew = libration.longitude >= 0 ? "E" : "W";
            const ns = libration.latitude >= 0 ? "N" : "S";
            const umbral = shadow.umbralMagnitude;
            const eclipseText =
                umbral >= 1
                    ? " · total eclipse"
                    : umbral > 0
                      ? ` · partial eclipse, ${(umbral * 100).toFixed(0)}% in the umbra`
                      : shadow.penumbralMagnitude > 0
                        ? " · penumbral eclipse"
                        : "";
            note.textContent =
                `Moon ${horizontal.altitude.toFixed(2)}° high, azimuth ${horizontal.azimuth.toFixed(1)}°, ` +
                `${(angularDiameter * 60).toFixed(1)}′ wide · ${(lit * 100).toFixed(0)}% lit, ${waxing ? "waxing" : "waning"} · ` +
                `libration ${Math.abs(libration.longitude).toFixed(1)}° ${ew}, ${Math.abs(libration.latitude).toFixed(1)}° ${ns} · ` +
                `earthshine ${earthshine.toFixed(1)} lx · air lets ${(through * 100).toFixed(0)}% through${eclipseText}`;
        }
        const encoder = gpu.device.createCommandEncoder({ label: "sternwarte:moon" });
        sky.pass.encode(encoder, background);
        moonPass.pass.encode(encoder, gpu.context.getCurrentTexture(), { background });
        gpu.device.queue.submit([encoder.finish()]);
        const submitted = performance.now();
        const skyKey = `${state.jd},${state.latitude},${state.longitude},${state.heightM}`;
        if (skyKey !== skyMeteredFor) {
            skyMeteredFor = skyKey;
            const { pass } = sky;
            pass.meteredEV100().then((ev) => {
                if (sky?.pass !== pass || Math.abs(ev - skyEV100) < 0.05) return;
                skyEV100 = ev;
                if (pressed("auto")) requestRender();
            });
        }
        placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
        showTiming(astronomyMs, submitted - passesStarted, submitted);
    }

    if (gpu) {
        bindToneCurveChoice(root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-tone"]`));
        onDisplay(() => {
            for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-tone"]`))
                input.checked = input.value === display.toneCurve;
            requestRender();
        });
        onChange(requestRender);
        onTables(requestRender);
        new ResizeObserver(requestRender).observe(canvas);
        maybe("exposure")?.addEventListener("input", requestRender);
        for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-law"]`))
            input.addEventListener("change", requestRender);
        for (const name of ["auto", "lock", "albedo", "relief", "earthshine", "eclipse"]) {
            maybe(name)?.addEventListener("click", () => {
                field(name).setAttribute("aria-pressed", String(!pressed(name)));
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
        lookAround(canvas, camera, {
            onChange: requestRender,
            onDrag: () => field("lock").setAttribute("aria-pressed", "false"),
        });
        requestRender();
    }
}
