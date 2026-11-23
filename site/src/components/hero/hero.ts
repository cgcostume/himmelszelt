import {
    type CloudPass,
    createCloudPass,
    createLayeredCloudPass,
    DEFAULT_CLOUD_PARAMS,
    DEFAULT_CLOUDSCAPE,
    type LayeredCloudPass,
    layeredSky,
    type ResolvedQuality,
    WEATHER,
    type WeatherName,
} from "@himmelszelt/gewoelk";
import { find } from "../dom";
import { HDR, onTables, tables } from "../dunstkreis/atmosphere";
import { cameraBasis, project } from "../dunstkreis/skycamera";
import { frameHeight } from "../dunstkreis/skyframe";
import { createLab, type Lab, labPipeline } from "../gewoelk/lab/lab";
import { routeTrails } from "../gewoelk/lab/routes";
import voxelShader from "../gewoelk/lab/voxel.comp.wgsl";
import {
    brightest,
    CLOUD_STOPS,
    GROUND_ALBEDO,
    lit,
    MOON_GONE,
    nightStops,
    OVERHEAD,
    PALE,
    SUN_GONE,
    SUNLIGHT,
    sunlightAt,
} from "../gewoelk/lab/weather";
import weatherShader from "../gewoelk/lab/weather.comp.wgsl";
import { createStarsRenderer, type FrameLight, skyAt } from "../sternenheer/renderer";
import { lookupElevation } from "../sternzeit/elevation";
import { state, update } from "../sternzeit/state";
import planePhoto from "./plane.webp?url";
import planesShader from "./planes.comp.wgsl";

const DEG = Math.PI / 180;
type Rgb = [number, number, number];
// The voxel pass composes over a background that is exposed already: its own exposure is 1, at this EV100.
const UNIT_EV100 = -Math.log2(1.2);
// How many times as bright as the sky the clouds may be before the frame is drawn darker for them.
const CLOUDS_OVER_SKY = 6;
// The wind the clouds drift with, where it blows from in degrees and how fast in m/s, and how far they lean with it.
const WIND = { from: 250, speed: 12 };
const SHEAR = 0.3;
// How fast the clouds change shape where the quality lets them, in changes per hour.
const EVOLUTION = 1;
// The air the contrails are laid into: trails that last 12 minutes and widen fast.
const TRAILS = { persistenceS: 720, spreadMps: 3, opticalDepth: 0.3 };
// The fields of view under which the fainter catalogs are drawn: Hipparcos, and Tycho-2, fetched once zoomed that far.
const FAINT_UNDER = 100 * DEG;
const DEEP_UNDER = 30 * DEG;

// An aircraft at cruise is some 65 m across and lies flat up there. It is drawn at its true size once the view has
// zoomed that far in, and no fewer pixels across before, far larger than it would show.
const PLANE_KM = 0.065;
const PLANE_LEAST_PX = 9;
// What its underside sends back of the light on it, being in its own shade, and the distance in km at which the air
// has hidden it to 1/e.
const PLANE_ALBEDO = 0.4;
const PLANE_AIR_KM = 50;
const PLANES = 16;
const START_HEIGHT_M = 20;

/** The aircraft's photograph on the GPU, with levels down to a texel, each the mean of four of the one before. */
async function planeTexture(device: GPUDevice) {
    const bitmap = await createImageBitmap(await (await fetch(planePhoto)).blob(), { premultiplyAlpha: "none" });
    const levels = Math.floor(Math.log2(bitmap.width)) + 1;
    const texture = device.createTexture({
        label: "sternwarte:heroPlane",
        size: [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        mipLevelCount: levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    for (let level = 0, size = bitmap.width; level < levels; level++, size = Math.max(size >> 1, 1)) {
        const scaled = await createImageBitmap(bitmap, {
            resizeWidth: size,
            resizeHeight: size,
            resizeQuality: "high",
            premultiplyAlpha: "none",
        });
        device.queue.copyExternalImageToTexture({ source: scaled }, { texture, mipLevel: level }, [size, size]);
    }
    return texture;
}

type Clouds = { key: string; voxel: CloudPass | null; layered: LayeredCloudPass | null };

/**
 * The landing page's figure on `root`, a `figure[data-hero]`: everything the libraries draw at once, at the page's moment
 * and place. dunstkreis' sky, sternenheer's stars, nachtgestirn's Moon, and over them gewoelk's clouds, by its voxel
 * model or its layered one, with the sheet of high cloud, contrails and the rain's bows. gewoelk's quality is set dial by
 * dial, and the catalogs and the Moon's maps follow the zoom.
 */
export async function heroFigure(root: HTMLElement) {
    let draw: (lab: Lab) => void = () => {};
    // Seen from a rooftop at first, the figure's own height: the page's stays.
    frameHeight(root).set(START_HEIGHT_M);
    const speeds = [...root.querySelectorAll<HTMLElement>("[data-speed]")];
    const lab = createLab(root, (current) => draw(current), {
        camera: { yaw: 205 * DEG, pitch: 20 * DEG, fov: 85 * DEG },
        speed: () =>
            Number(speeds.find((button) => button.getAttribute("aria-pressed") === "true")?.dataset.speed) || 1,
    });
    if (!lab) return;
    const { device, canvas, camera } = lab;
    const [compose, tone] = await Promise.all([
        labPipeline(device, "heroCompose", weatherShader, "weatherCompose"),
        labPipeline(device, "heroTone", voxelShader, "voxelTone"),
    ]);
    const renderer = createStarsRenderer(device, () => lab.request());
    const frame = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    let layer: GPUTexture | null = null;
    const outputs = new WeakMap<GPUTexture, GPUBindGroup>();
    let exposure = "";
    let darker = 0;

    // At the reading column's width the options would cover the view: folded away until asked for.
    const panel = root.querySelector<HTMLElement>('[data-field="optionsPanel"]');
    if (panel && !panel.hidden) find('[data-field="options"]', root).click();

    // Play, by the figure's own clock at the chosen speed: the page's moment runs on with it unless it is held.
    const [play, timeLock] = ["animate", "timeLock"].map((name) => find(`[data-field="${name}"]`, root));
    for (const button of [play, timeLock])
        button?.addEventListener("click", () => {
            const on = button.getAttribute("aria-pressed") !== "true";
            button.setAttribute("aria-pressed", String(on));
            if (button === play) button.setAttribute("aria-label", on ? "Pause" : "Play");
            lab.request();
        });
    for (const button of speeds)
        button.addEventListener("click", () => {
            for (const other of speeds) other.setAttribute("aria-pressed", String(other === button));
            lab.request();
        });
    // The clock as last drawn, and the seconds it ran while the moment was held: the clouds' time besides the moment's.
    let clockSeen = 0;
    let heldS = 0;

    // The view kept on the Moon or on the Sun, one at a time: a drag lets go.
    const locks = ["lock", "sunLock"].map((name) => find(`[data-field="${name}"]`, root));
    for (const lock of locks)
        lock.addEventListener("click", () => {
            const on = lock.getAttribute("aria-pressed") !== "true";
            for (const each of locks) each.setAttribute("aria-pressed", String(each === lock && on));
            lab.request();
        });
    canvas.addEventListener("pointerdown", () => {
        for (const lock of locks) lock.setAttribute("aria-pressed", "false");
    });

    // The reader's own place, by the browser, and its height over the sea, looked up.
    const place = find('[data-field="place"]', root);
    find('[data-field="geolocate"]', root).addEventListener("click", () => {
        if (!navigator.geolocation) {
            place.textContent = "geolocation not supported by this browser";
            return;
        }
        place.textContent = "requesting location...";
        navigator.geolocation.getCurrentPosition(
            async ({ coords }) => {
                place.textContent = "";
                const [latitude, longitude] = [coords.latitude, coords.longitude].map((c) => Number(c.toFixed(4)));
                update({ latitude, longitude });
                const elevation = await lookupElevation(latitude as number, longitude as number);
                if (elevation !== null) update({ heightM: Math.max(1, elevation) });
            },
            (error) => {
                place.textContent = `geolocation failed: ${error.message}`;
            },
            { timeout: 5000 },
        );
    });

    // The Sun's and the Moon's names under them, shown with the compass.
    const bodies = find('[data-field="bodyLabels"]', root);
    const names = ["Sun", "Moon"].map((textContent) =>
        bodies.appendChild(Object.assign(document.createElement("span"), { textContent })),
    );

    // An aircraft at the young end of every trail, drawn into the frame behind the clouds: its photograph with its levels,
    // and the frame with the aircraft in it.
    const planesOver = await device.createComputePipelineAsync({
        label: "sternwarte:heroPlanes",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: planesShader }), entryPoint: "planesOver" },
    });
    const planesData = device.createBuffer({
        size: 16 + 32 * PLANES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const planeSampler = device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear" });
    const photo = await planeTexture(device);
    let staged: GPUTexture | null = null;
    let planesShown = new Float32Array(4 + 8 * PLANES);

    // The pass of the chosen model and quality: the one before keeps drawing until it is made, and is destroyed then.
    let made: Clouds | null = null;
    let making = "";
    // gewoelk's quality dial by dial, as `cloudQuality` gives it for a level: each number from a control of its own.
    const dial = (name: string, preset: number) => (lab.choice(name) === "" ? preset : Number(lab.choice(name)));
    const dials = (): ResolvedQuality & { godRays: boolean } => {
        const [grid, map, clearingKm] = [dial("grid", 256), dial("map", 512), dial("clearAt", 150)];
        const [changes, everyS] = [lab.choice("change") !== "off", Number(lab.choice("change")) || 0];
        const scale = dial("scale", 0.5) < 0.4 ? 1 / 3 : dial("scale", 0.5);
        return {
            voxel: {
                ...{
                    scale,
                    maxSteps: dial("steps", 256),
                    nearLightSamples: dial("light", 2),
                    nearDetailKm: dial("near", 0),
                },
                ...{
                    grid: { size: grid, layers: grid / 4 },
                    detailSize: dial("noise", 128),
                    mapSize: Math.min(map, 1024),
                },
                keyframes: false,
            },
            layered: { scale, maxSteps: dial("steps", 256), mapSize: map, highMapSize: dial("highMap", 1024) },
            march: { reachKm: dial("reach", 160) },
            clearing: { clearingKm, clearingFromKm: clearingKm > 0 ? Math.min(dial("clearFrom", 40), clearingKm) : 0 },
            ...{ evolves: changes, stepsPerFrame: 0, evolutionEveryS: everyS, godRays: lab.pressed("godRays.on") },
        };
    };
    const clouds = () => {
        const model = lab.choice("model") || "voxel";
        const quality = dials();
        // What a pass is made with: any of it changed, and a new one is made.
        const key = JSON.stringify([
            model,
            model === "voxel" ? quality.voxel : quality.layered,
            quality.layered.highMapSize,
            quality.godRays,
        ]);
        if (made?.key === key || making === key) return made;
        making = key;
        // The voxels are rebuilt in the frame that changes them, not by keyframes.
        const creating: Promise<Clouds> =
            model === "voxel"
                ? createCloudPass(device, {
                      format: HDR,
                      toneMap: false,
                      ...quality.voxel,
                      keyframes: false,
                      high: { mapSize: quality.layered.highMapSize },
                      deep: true,
                  }).then((voxel) => ({ key, voxel, layered: null }))
                : createLayeredCloudPass(device, {
                      format: HDR,
                      toneMap: false,
                      background: false,
                      quality: quality.layered,
                      godRays: quality.godRays,
                  }).then((layered) => ({ key, voxel: null, layered }));
        creating.then((next) => {
            const superseded = making !== key;
            const old = superseded ? next : made;
            old?.voxel?.destroy();
            old?.layered?.destroy();
            if (superseded) return;
            made = next;
            making = "";
            lab.request();
        });
        return made;
    };

    // The clouds' clock: the page's moment, in seconds from the day the figure was first drawn on.
    let epoch: number | null = null;
    // A front stands where its weather places it when chosen, and comes on from there.
    let frontOf = "";
    let frontSince = 0;

    lab.status = () => {
        const march = lab.timer.ms.march;
        return `clouds ${march === undefined ? "?" : march.toFixed(2)} ms on the GPU${exposure}`;
    };

    draw = () => {
        const table = tables();
        const pass = clouds();
        if (!table || !pass) return;
        const ran = lab.clock - clockSeen;
        clockSeen = lab.clock;
        if (timeLock?.getAttribute("aria-pressed") === "true") heldS += ran;
        else if (ran > 0) update({ jd: state.jd + ran / 86_400, live: false });
        const { model } = table.luts;
        let size = lab.size();
        const seen = skyAt(state.jd, { ...state, heightM: size.heightM }, model);
        const kept = [seen.moonDirection, seen.sunDirection].find(
            (_, i) => locks[i]?.getAttribute("aria-pressed") === "true",
        );
        if (kept) {
            camera.yaw = Math.atan2(kept[0], kept[1]);
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(kept[2])));
            size = lab.size();
        }
        const { width, height, dpr, heightM, headroom, inverseViewProjection, projectionDistance } = size;
        if (layer?.width !== width || layer.height !== height) {
            layer?.destroy();
            layer = device.createTexture({ size: [width, height], format: HDR, usage });
        }
        const marched = layer;
        const marks = Number(find('[data-field="marks"]', root).dataset.level);
        bodies.hidden = marks < 1;
        const basis = cameraBasis(camera, width / height);
        [seen.sunDirection, seen.moonDirection].forEach((direction, i) => {
            const at = project([...direction], basis, canvas.clientWidth, canvas.clientHeight);
            const name = names[i] as HTMLElement;
            name.hidden = at === null;
            if (at) Object.assign(name.style, { left: `${at.x}px`, top: `${at.y + 16}px` });
        });

        epoch ??= Math.floor(state.jd);
        const timeS = (state.jd - epoch) * 86_400 + heldS;
        const name = (lab.choice("weather") || "frontAhead") as WeatherName;
        const weather = WEATHER[name];
        const sky = layeredSky(weather.layers ?? {});
        if (frontOf !== name) {
            frontOf = name;
            frontSince = timeS;
        }
        const quality = dials();
        const windTo = (WIND.from + 180) * DEG;
        const wind = [Math.sin(windTo) * WIND.speed, Math.cos(windTo) * WIND.speed] as const;
        const contrails = lab.pressed("contrails.on") ? routeTrails(timeS, { ...TRAILS, wind }) : [];
        const observerKm = [lab.flown.east, lab.flown.north] as const;
        // Where each aircraft shows: up at the sheet's altitude, lower by the planet's curve, and heading as its trail runs.
        const radiusKm = model.planet.groundRadiusKm;
        const seenAt = (east: number, north: number) => {
            const [x, y] = [east - observerKm[0], north - observerKm[1]];
            const z = sky.high.altitudeKm - heightM / 1000 - (x * x + y * y) / (2 * radiusKm);
            const far = Math.hypot(x, y, z);
            const at = project([x / far, y / far, z / far], basis, width, height);
            return z > 0 && at ? { ...at, far } : null;
        };
        planesShown = new Float32Array(4 + 8 * PLANES);
        let planeCount = 0;
        for (const { fromKm, toKm, opticalDepth } of contrails.slice(0, PLANES)) {
            const long = Math.hypot(fromKm[0] - toKm[0], fromKm[1] - toKm[1]) || 1;
            const ahead = [(fromKm[0] - toKm[0]) / long, (fromKm[1] - toKm[1]) / long] as const;
            const [at, next] = [seenAt(fromKm[0], fromKm[1]), seenAt(fromKm[0] + ahead[0], fromKm[1] + ahead[1])];
            const wing = seenAt(fromKm[0] + ahead[1], fromKm[1] - ahead[0]);
            if (!at || !next || !wing) continue;
            // A km ahead and a km to the right, in pixels: scaled to the aircraft's half, or to the least it is drawn at.
            const [nose, right] = [next, wing].map((to) => [to.x - at.x, to.y - at.y] as const);
            const longer = Math.max(
                Math.hypot(...(nose as [number, number])),
                Math.hypot(...(right as [number, number])),
            );
            const half = Math.max(PLANE_KM / 2, (PLANE_LEAST_PX * dpr) / 2 / Math.max(longer, 1e-6));
            const shown = Math.min(opticalDepth / TRAILS.opticalDepth, 1) * Math.exp(-at.far / PLANE_AIR_KM);
            const vectors = [...(nose as [number, number]), ...(right as [number, number])].map((c) => c * half);
            planesShown.set([at.x, at.y, ...vectors, shown], 4 + 8 * planeCount++);
        }
        new Uint32Array(planesShown.buffer)[3] = planeCount;

        // The clouds over the frame: lit by the Sun while it reaches the highest of them, by the Moon after.
        const overFrame = (encoder: GPUCommandEncoder, exposed: GPUTexture, target: GPUTexture, light: FrameLight) => {
            const sunUp = seen.sunDirection[2] > SUN_GONE;
            const moonUp = seen.moonDirection[2] > MOON_GONE;
            const scale = sunUp ? 1 : moonUp ? seen.moonIlluminance / SUNLIGHT : 0;
            const from = sunUp || !moonUp ? seen.sunDirection : seen.moonDirection;
            const sunDirection: Rgb = [from[0], from[1], from[2]];
            const elevation = Math.asin(Math.min(Math.max(sunDirection[2], -1), 1));
            const luminance = Math.max(light.skyLuminance, 1e-6);
            // The Sun's own light at the eye by dunstkreis' air: the stand-in reddens a Sun that still stands high, and
            // the corona takes its color from this. The stand-in where the air gives none, and for the Moon.
            const lifted = elevation / DEG + (seen.bend(elevation / DEG) ?? 0);
            const through = sunUp ? seen.through(lifted) : null;
            const onGround = through
                ? (through.map((share) => SUNLIGHT * share) as Rgb)
                : sunlightAt(0, elevation, scale);
            const fromSky = lit(OVERHEAD, luminance * Math.PI);
            const horizon = lit(PALE, luminance);
            const fromGround = onGround.map(
                (e, i) => GROUND_ALBEDO * (e * Math.max(sunDirection[2], 0) + (fromSky[i] ?? 0)),
            ) as Rgb;
            // The meter exposes for the sky and does not see the clouds: darker where the Sun on their tops outshines it.
            const cloudscape = { ...DEFAULT_CLOUDSCAPE, ...weather.cloudscape };
            const tops = pass.voxel
                ? [{ coverage: cloudscape.coverage, topKm: cloudscape.baseKm + cloudscape.heightKm }]
                : [sky.low, sky.deep, sky.middle].map((l) => ({ coverage: l.coverage, topKm: l.baseKm + l.depthKm }));
            const lights = [...tops, { coverage: sky.high.coverage, topKm: sky.high.altitudeKm }].map(
                ({ coverage, topKm }) => ({ coverage, illuminance: sunlightAt(topKm, elevation, scale) }),
            );
            const sunlit = Math.log2(brightest(lights) / (CLOUDS_OVER_SKY * luminance));
            darker = Math.max(nightStops(light.skyLuminance), sunUp ? Math.min(Math.max(sunlit, 0), CLOUD_STOPS) : 0);
            device.queue.writeBuffer(frame, 0, new Float32Array([2 ** -darker, 1]));
            // The aircraft into the frame before the clouds, lit by the Sun and the sky up there, as exposed.
            if (staged?.width !== width || staged.height !== height) {
                staged?.destroy();
                staged = device.createTexture({ size: [width, height], format: HDR, usage });
            }
            const behind = staged;
            const aloft = sunlightAt(sky.high.altitudeKm, elevation, scale);
            const sent = 1 / (Math.PI * 1.2 * 2 ** light.ev100);
            planesShown.set(aloft.map((e, i) => PLANE_ALBEDO * (e + (fromSky[i] ?? 0)) * sent));
            device.queue.writeBuffer(planesData, 0, planesShown);
            const flying = encoder.beginComputePass({ label: "sternwarte:heroPlanes" });
            flying.setPipeline(planesOver);
            flying.setBindGroup(
                0,
                device.createBindGroup({
                    layout: planesOver.getBindGroupLayout(0),
                    entries: [
                        { buffer: planesData },
                        exposed.createView(),
                        photo.createView(),
                        planeSampler,
                        behind.createView(),
                    ].map((resource, binding) => ({ binding, resource })),
                }),
            );
            flying.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            flying.end();
            // By night the Moon is the clouds' light, and their corona would be the Moon's. Its disc is drawn as the eye
            // sees it, adapted to it and many stops darker than the night is exposed: a corona exposed as the night
            // outshines the disc it lies around, and one exposed as the disc is a fiftieth of it, too faint to show. None.
            const corona = sunUp;
            const view = {
                observerHeightM: heightM,
                inverseViewProjection,
                projectionDistance,
                ...(!corona && { corona: false as const }),
            };
            const march = lab.timer.writes("march");
            if (pass.voxel) {
                const exposedBy = 1 / (1.2 * 2 ** light.ev100);
                const dim = (color: readonly number[]) => color.map((c) => c * exposedBy) as Rgb;
                const front = sky.deep.kind === "front" && sky.deep.coverage > 0 ? sky.deep : null;
                pass.voxel.update(
                    {
                        ...DEFAULT_CLOUD_PARAMS,
                        ...view,
                        sunDirection,
                        sunIlluminance: dim(onGround),
                        skyIrradiance: dim(fromSky),
                        horizonLuminance: dim(horizon),
                        groundIrradiance: dim(fromGround),
                        ev100: UNIT_EV100,
                        timeS,
                        planetRadiusKm: model.planet.groundRadiusKm,
                        sheets: [],
                        cloudscape: {
                            ...cloudscape,
                            wind: [wind[0], wind[1]],
                            evolution: quality.evolves && quality.evolutionEveryS === 0 ? EVOLUTION : 0,
                            driftOffsetKm: [-lab.flown.east, -lab.flown.north],
                            ...quality.clearing,
                        },
                        high: sky.high,
                        highWind: wind,
                        deep: front,
                        deepSinceS: frontSince,
                        contrails,
                        observerKm,
                    },
                    encoder,
                );
                pass.voxel.encode(encoder, marched, { background: behind, ...(march && { timestampWrites: march }) });
            } else if (pass.layered) {
                pass.layered.update(
                    {
                        ...view,
                        weather: sky,
                        wind,
                        highWind: wind,
                        shear: SHEAR,
                        evolution: quality.evolves ? EVOLUTION : 0,
                        evolutionEveryS: quality.evolutionEveryS,
                        ...quality.clearing,
                        timeS,
                        contrails,
                        observerKm,
                        march: quality.march,
                        boxFilter: lab.pressed("smooth.on"),
                        sunDirection,
                        sunIlluminance: onGround,
                        sunlightAt: (altitudeKm, at) => sunlightAt(altitudeKm, at, scale),
                        skyIrradiance: fromSky,
                        horizonLuminance: horizon,
                        groundIrradiance: fromGround,
                        ev100: light.ev100,
                    },
                    encoder,
                );
                pass.layered.encode(encoder, marched, { ...(march && { timestampWrites: { march } }) });
            }
            // The voxel pass composed its clouds over the frame itself, the layered one's are composed here: then the tone curve.
            const pipeline = pass.voxel ? tone : compose;
            let output = outputs.get(target);
            if (!output) {
                output = device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(1),
                    entries: [{ binding: 0, resource: target.createView() }],
                });
                outputs.set(target, output);
            }
            const entries = pass.voxel
                ? [marched.createView(), { buffer: frame }]
                : [behind.createView(), marched.createView(), { buffer: frame }];
            const finishing = encoder.beginComputePass({ label: "sternwarte:heroCompose" });
            finishing.setPipeline(pipeline);
            finishing.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [{ buffer: lab.view }, ...entries].map((resource, binding) => ({ binding, resource })),
                }),
            );
            finishing.setBindGroup(1, output);
            finishing.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
            finishing.end();
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
            stars: true,
            faintStars: camera.fov < FAINT_UNDER,
            deepStars: camera.fov < DEEP_UNDER,
            milkyWay: true,
            maps: "auto",
            air: true,
            twinkle: false,
            time: 0,
            glare: true,
            darkAdapted: true,
            moon: true,
            moonMaps: "auto",
            moonSamples: lab.pressed("smooth.on") ? 4 : 1,
            constellations: [],
            grid: marks === 2,
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
