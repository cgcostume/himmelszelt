import type { AtmosphereModel, SkyPass } from "@himmelszelt/dunstkreis";
import { clampObserverHeight, createSkyPass, wgsl } from "@himmelszelt/dunstkreis";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { drawSvg, LABEL_GAP as GAP, svgText } from "../sternzeit/figure";
import { onChange, state } from "../sternzeit/state";
import { configureCanvas, gpu, gpuDevice, onTables, quality, SDR, tables } from "./atmosphere";

// Distance in the air: ridges one behind another over the page's sky, faded by dunstkreis' aerial perspective volume.
// The sky pass writes the sky linear into a float texture and builds the volume for the same camera; a second pass,
// the figure's own, follows each pixel's ray, bent by the same air, to the ridge or the ground it ends on, and applies
// the volume at that length, as a renderer would to its terrain.

const DEG = Math.PI / 180;
// Each ridge twice as far as the one in front and 2.5 times as high, so the farther ones rise over the nearer ones
// until the curvature of the Earth takes them down.
const HEIGHTS_KM = [0.2, 0.5, 1.2, 3];
// A ridge's crest along it: its height times a few waves, as wide as the ridge is high times this.
const WAVE_WIDTH = 0.8;
const WAVES = [0.3, 0.15, 0.08];
// Steps of the bent ray from one ridge to the next, in the shader and here.
const STEPS = 8;
// The camera: 70 degrees round from the Sun, so its disc and glow stay out of view, and fixed, so a ridge moved out
// shrinks and sinks as it would: 8 degrees high, the horizon a fifth of the way up.
const AZIMUTH_FROM_SUN = 70 * DEG;
const FOV = 8 * DEG;
const HORIZON_AT = 0.2;
// The slider's 0 to 4 are powers of two: the nearest ridge from 1 to 16 km, the farthest from 8 to 128.
const nearestKm = (value: number) => 2 ** value;
// The volume reaches past the farthest ridge at the slider's end, and from high up past the ground below.
const volumeReach = (heightKm: number) => (heightKm < 20 ? 128 : 640);

const crestWgsl = `fn crest(i: u32, along: f32) -> f32 {
    let heights = array<f32, 4>(${HEIGHTS_KM.map((h) => h.toFixed(3)).join(", ")});
    let x = along / (${WAVE_WIDTH} * heights[i]);
    let s = f32(i) * 2.3 + 1.0;
    let waves = ${WAVES[0]} * sin(x + s) + ${WAVES[1]} * sin(2.3 * x + 2.0 * s) + ${WAVES[2]} * sin(5.1 * x + 3.0 * s);
    return heights[i] * (1.0 + waves);
}`;

/** A ridge's crest in km above the ground, `along` km along it from straight ahead: the same as the shader's. */
function crest(i: number, along: number) {
    const height = HEIGHTS_KM[i] ?? 0;
    const x = along / (WAVE_WIDTH * height);
    const s = i * 2.3 + 1;
    const [a, b, c] = WAVES as [number, number, number];
    return height * (1 + a * Math.sin(x + s) + b * Math.sin(2.3 * x + 2 * s) + c * Math.sin(5.1 * x + 3 * s));
}

const composite = `
${wgsl.atmosphere}
${wgsl.common}
${wgsl.aerial}
${wgsl.tonemap}

struct Params {
    forward: vec3f,
    tx: f32,
    right: vec3f,
    ty: f32,
    up: vec3f,
    exposure: f32,
    sun: vec3f,
    h: f32,
    sunIlluminance: vec3f,
    scale: f32,
    nearest: f32,
    maxDistance: f32,
}
@group(0) @binding(0) var<uniform> atmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var sky: texture_2d<f32>;
@group(0) @binding(3) var luminanceVolume: texture_3d<f32>;
@group(0) @binding(4) var transmittanceVolume: texture_3d<f32>;
@group(0) @binding(5) var volumeSampler: sampler;
@group(0) @binding(6) var output: texture_storage_2d<rgba8unorm, write>;

${crestWgsl}

// dkPathAltitude without its floor at the ground, so a step that ends below it says by how much.
fn altitudeAt(h0: f32, p: vec2f) -> f32 {
    let r0 = atmosphere.Rg + h0;
    let r = length(vec2f(p.x, r0 + p.y));
    return (p.x * p.x + p.y * (2.0 * r0 + p.y) + dkRhoSquared(atmosphere, h0)) / (r + atmosphere.Rg);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(output);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let direction = normalize(params.forward + params.right * params.tx * ndc.x + params.up * params.ty * ndc.y);
    // Exposed already, by the same exposure.
    var color = textureLoad(sky, id.xy, 0).rgb;

    // The ray in its vertical plane, bent by the air as the volume's are, out to each ridge in turn: it ends on the
    // ground short of one, on the ridge if it reaches it under the crest, or passes over all four into the sky.
    let h0 = params.h;
    let r0 = atmosphere.Rg + h0;
    let azimuth = atan2(dot(direction, params.right), dot(direction, vec3f(-params.right.y, params.right.x, 0.0)));
    var path = dkPathStart(direction.z);
    var traveled = 0.0;
    var altitude = h0;
    var distance = -1.0;
    for (var i = 0u; i < 4u && distance < 0.0; i++) {
        let along = params.nearest * exp2(f32(i));
        let wall = vec2f(sin(along / atmosphere.Rg), cos(along / atmosphere.Rg));
        var reached = true;
        for (var k = 0u; k < ${STEPS}u; k++) {
            let p = path.position;
            let toward = path.direction.x * wall.y - path.direction.y * wall.x;
            if (toward <= 0.0) {
                reached = false;
                break;
            }
            let ds = ((r0 + p.y) * wall.x - p.x * wall.y) / toward / f32(${STEPS}u - k);
            let next = dkPathAdvance(atmosphere, h0, path, ds).next;
            let below = altitudeAt(h0, next.position);
            if (below < 0.0) {
                distance = traveled + ds * altitude / (altitude - below);
                break;
            }
            path = next;
            traveled += ds;
            altitude = below;
        }
        if (!reached) {
            break;
        }
        if (distance < 0.0 && altitude < crest(i, azimuth * along)) {
            distance = traveled;
        }
    }
    if (distance >= 0.0) {
        // Dark rock and grass, lit by the sun and, a fifth as much, by the sky, without any air in between.
        let albedo = vec3f(0.08, 0.1, 0.07);
        let light = params.sunIlluminance * (max(params.sun.z, 0.0) * 0.8 + 0.2);
        let air = dkSampleAerialPerspective(
            luminanceVolume, transmittanceVolume, volumeSampler, uv, distance, params.maxDistance, params.scale,
        );
        color = dkApplyAerialPerspective(atmosphere, albedo / 3.14159265 * light, air) * params.exposure;
    }
    textureStore(output, id.xy, vec4f(dkToneMapNeutral(color), 1.0));
}
`;

// The same ray on the CPU, for where the crests show: the labels, the camera's framing and the profile.
type Vec2 = [number, number];
type Air = { rg: number; hr: number; n0: number };
const airOf = (model: AtmosphereModel): Air => ({
    rg: model.planet.groundRadiusKm,
    hr: model.rayleigh.scaleHeightKm,
    n0: model.refractivity,
});

function altitudeAt(air: Air, h0: number, [x, y]: Vec2) {
    const r0 = air.rg + h0;
    return (x * x + y * (2 * r0 + y) + h0 * (2 * air.rg + h0)) / (Math.hypot(x, r0 + y) + air.rg);
}

// dkPathTurn and dkPathAdvance's midpoint step.
function turn(air: Air, h0: number, p: Vec2, d: Vec2): Vec2 {
    const n = air.n0 * Math.exp(-Math.max(altitudeAt(air, h0, p), 0) / air.hr);
    const r = Math.hypot(p[0], air.rg + h0 + p[1]);
    const k = -n / (air.hr * (1 + n) * r);
    const g: Vec2 = [k * p[0], k * (air.rg + h0 + p[1])];
    const along = g[0] * d[0] + g[1] * d[1];
    return [g[0] - along * d[0], g[1] - along * d[1]];
}
const normalize = ([x, y]: Vec2): Vec2 => [x / Math.hypot(x, y), y / Math.hypot(x, y)];
function advance(air: Air, h0: number, p: Vec2, d: Vec2, ds: number): [Vec2, Vec2] {
    const t = turn(air, h0, p, d);
    const half = normalize([d[0] + t[0] * 0.5 * ds, d[1] + t[1] * 0.5 * ds]);
    const middle: Vec2 = [p[0] + half[0] * 0.5 * ds, p[1] + half[1] * 0.5 * ds];
    const tm = turn(air, h0, middle, half);
    return [[p[0] + half[0] * ds, p[1] + half[1] * ds], normalize([d[0] + tm[0] * ds, d[1] + tm[1] * ds])];
}

/**
 * Follows a ray at elevation `e` from `h0` km up out to the ridge `last` at `distances` km: per ridge, the altitude it
 * crosses it at, or null if it never reaches it, and whether it went through the ground first; and its points.
 */
function trace(air: Air, h0: number, e: number, distances: number[], last: number) {
    let p: Vec2 = [0, 0];
    let d: Vec2 = [Math.cos(e), Math.sin(e)];
    let buried = false;
    const points: Vec2[] = [p];
    const crossings: { altitude: number | null; buried: boolean }[] = [];
    for (let i = 0; i <= last; i++) {
        const theta = (distances[i] ?? 0) / air.rg;
        const wall: Vec2 = [Math.sin(theta), Math.cos(theta)];
        let reached = true;
        for (let k = 0; k < STEPS; k++) {
            const toward = d[0] * wall[1] - d[1] * wall[0];
            if (toward <= 0) {
                reached = false;
                break;
            }
            const ds = ((air.rg + h0 + p[1]) * wall[0] - p[0] * wall[1]) / toward / (STEPS - k);
            [p, d] = advance(air, h0, p, d, ds);
            points.push(p);
            if (altitudeAt(air, h0, p) < 0 && (k < STEPS - 1 || i < last)) buried = true;
        }
        crossings.push({ altitude: reached ? altitudeAt(air, h0, p) : null, buried });
        if (!reached) break;
    }
    return { crossings, points };
}

/** The elevation a point `height` km up on ridge `i` shows at, by bisection, and whether the ground hides it. */
function elevationOf(air: Air, h0: number, distances: number[], i: number, height: number) {
    let [lo, hi] = [-89.9 * DEG, 89.9 * DEG];
    for (let n = 0; n < 24; n++) {
        const e = (lo + hi) / 2;
        const altitude = trace(air, h0, e, distances, i).crossings[i]?.altitude ?? null;
        if (altitude === null || altitude > height) hi = e;
        else lo = e;
    }
    const e = (lo + hi) / 2;
    return { e, ...trace(air, h0, e, distances, i) };
}

const root = find<HTMLElement>("#distance");
const canvas = find<HTMLCanvasElement>('[data-field="canvas"]', root);
const labels = [...find('[data-field="labels"]', root).children] as HTMLElement[];
const profile = find<SVGSVGElement>(".distance-profile > svg", root);
const slider = find<HTMLInputElement>('[data-field="distance"]', root);
const readout = find<HTMLOutputElement>('[data-field="distanceValue"]', root);
const PARAMS_SIZE = 96;

/** A distance as the labels give it: two figures, a narrow space before the unit. */
const km = (value: number) => `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)} km`;
const meters = (value: number) => `${Math.round(value * 1000)} m`;

// The figure's camera and the crests' apparent elevations, for the moment, the place and the slider.
function scene(air: Air) {
    const h0 = clampObserverHeight(state.heightM) / 1000;
    const nearest = nearestKm(Number(slider.value));
    const distances = HEIGHTS_KM.map((_, i) => nearest * 2 ** i);
    const dip = Math.acos(air.rg / (air.rg + h0));
    return { h0, nearest, distances, fov: FOV, pitch: (0.5 - HORIZON_AT) * FOV - dip };
}

if (gpu.device) {
    const device = gpuDevice();
    const context = canvas.getContext("webgpu");
    if (context) configureCanvas(context, SDR);
    const pipeline = device.createComputePipeline({
        label: "sternwarte:distance",
        layout: "auto",
        compute: {
            module: device.createShaderModule({ label: "sternwarte:distance", code: composite }),
            entryPoint: "main",
        },
    });
    const paramsBuffer = device.createBuffer({
        size: PARAMS_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    let pass: SkyPass | null = null;
    let passFor: unknown = null;
    let passReach = 0;
    let skyTexture: GPUTexture | null = null;
    // Read back from the pass after a frame, and drawn with on the next: the meter's EV100 and the sunlight's lux.
    let ev = 12;
    let sunlight: [number, number, number] = [50_000, 50_000, 50_000];

    const draw = onDemand(() => {
        const table = tables();
        if (!context || !table) return;
        const air = airOf(table.luts.model);
        const { h0, nearest, distances, fov, pitch } = scene(air);
        const reach = volumeReach(h0);
        if (passFor !== table.luts || passReach !== reach) {
            passFor = table.luts;
            passReach = reach;
            const luts = table.luts;
            createSkyPass(device, {
                luts,
                format: "rgba16float",
                toneMap: false,
                sunDisc: false,
                groundLight: quality.groundLight,
                aerialPerspective: { maxDistanceKm: reach },
            }).then((next) => {
                if (passFor !== luts || passReach !== reach) return next.destroy();
                pass?.destroy();
                pass = next;
                draw();
            });
        }
        drawProfile(air, h0, distances);
        if (!pass?.aerialPerspective) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
        if (!skyTexture || skyTexture.width !== width || skyTexture.height !== height) {
            skyTexture?.destroy();
            skyTexture = device.createTexture({
                size: [width, height],
                format: "rgba16float",
                usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
            });
        }

        const time = fromJulianDay(state.jd);
        const sunDirection = sun.direction(time, state);
        const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
        const yaw = Math.atan2(sunDirection[0], sunDirection[1]) + AZIMUTH_FROM_SUN;
        const forward = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)] as const;
        const right = [Math.cos(yaw), -Math.sin(yaw), 0] as const;
        const up = [-Math.sin(pitch) * Math.sin(yaw), -Math.sin(pitch) * Math.cos(yaw), Math.cos(pitch)] as const;
        const ty = Math.tan(fov / 2);
        const tx = (ty * width) / height;
        const encoder = device.createCommandEncoder();
        pass.update(
            {
                sunDirection,
                sunAngularDiameter,
                observerHeightM: h0 * 1000,
                ev100: ev,
                inverseViewProjection: new Float32Array([
                    ...right.map((c) => c * tx),
                    0,
                    ...up.map((c) => c * ty),
                    0,
                    0,
                    0,
                    0,
                    1,
                    ...forward,
                    0,
                ]),
            },
            encoder,
        );
        pass.encode(encoder, skyTexture);

        const data = new ArrayBuffer(PARAMS_SIZE);
        const f = new Float32Array(data);
        f.set([...forward, tx, ...right, ty, ...up, 1 / (1.2 * 2 ** ev), ...sunDirection, h0], 0);
        f.set([...sunlight, pass.skyViewScale, nearest, reach], 16);
        device.queue.writeBuffer(paramsBuffer, 0, data);

        const volume = pass.aerialPerspective;
        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: table.luts.atmosphereBuffer } },
                { binding: 1, resource: { buffer: paramsBuffer } },
                { binding: 2, resource: skyTexture.createView() },
                { binding: 3, resource: volume.luminance.createView() },
                { binding: 4, resource: volume.transmittance.createView() },
                { binding: 5, resource: table.luts.sampler },
                { binding: 6, resource: context.getCurrentTexture().createView() },
            ],
        });
        const compute = encoder.beginComputePass();
        compute.setPipeline(pipeline);
        compute.setBindGroup(0, bindGroup);
        compute.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        compute.end();
        device.queue.submit([encoder.finish()]);

        placeLabels(air, h0, distances, { forward, right, up, tx, ty });

        // The exposure and the sunlight for the next frame, drawn again only if they moved.
        const drawn = pass;
        Promise.all([drawn.meteredEV100(), drawn.sunIlluminance()]).then(([metered, lux]) => {
            const moved =
                Math.abs(metered - ev) > 0.05 || lux.some((v, i) => Math.abs(v - (sunlight[i] ?? 0)) > 0.01 * v + 1);
            ev = metered;
            sunlight = lux;
            if (moved) draw();
        });
    }, canvas);

    const show = () => {
        readout.textContent = km(nearestKm(Number(slider.value)));
        draw();
    };
    slider.addEventListener("input", show);
    onChange(draw);
    onTables(draw);
    new ResizeObserver(draw).observe(canvas);
    show();
}

type Camera = {
    forward: readonly number[];
    right: readonly number[];
    up: readonly number[];
    tx: number;
    ty: number;
};
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * (b[i] ?? 0), 0);

/**
 * Each ridge's distance over its crest, where it shows most over the ridges in front: the nearest's in the left
 * quarter, the farthest's in the right, so they never meet. One hidden there goes where else it shows, clear of the
 * others.
 */
function placeLabels(air: Air, h0: number, distances: number[], camera: Camera) {
    const { forward, right, up, tx, ty } = camera;
    const [w, h] = [canvas.clientWidth, canvas.clientHeight];
    const yaw = Math.atan2(-(right[1] ?? 0), right[0] ?? 0);
    // Directions round from straight ahead, a little past the frame's edges at its middle row.
    const span = Math.atan(tx * 1.1);
    const SAMPLES = 32;
    const columns = Array.from({ length: SAMPLES }, (_, n) => -span + (2 * span * (n + 0.5)) / SAMPLES).map((az) =>
        distances.map((along, i) => {
            const point = elevationOf(air, h0, distances, i, crest(i, az * along));
            return { az, e: point.crossings[i]?.buried ? -Infinity : point.e };
        }),
    );
    // Every crest point that shows, on screen, with how far it rises over the ridges in front and its own foot.
    const feet = distances.map((_, i) => elevationOf(air, h0, distances, i, 0).e);
    const shown = distances.map((_, i) =>
        columns.flatMap((column) => {
            const { az, e } = column[i] ?? { az: 0, e: -Infinity };
            const exposure = e - Math.max(feet[i] ?? 0, ...column.slice(0, i).map((c) => c.e));
            const direction = [Math.cos(e) * Math.sin(yaw + az), Math.cos(e) * Math.cos(yaw + az), Math.sin(e)];
            const depth = dot(direction, forward);
            // At least a few pixels of it, so a label never names a crest too thin to see, as from orbit.
            if (!(exposure * (h / (2 * ty)) > 3) || depth <= 0) return [];
            const x = ((dot(direction, right) / depth / tx + 1) / 2) * w;
            const y = ((1 - dot(direction, up) / depth / ty) / 2) * h;
            return x > 24 && x < w - 24 && y > 24 && y < h ? [{ x, y, exposure }] : [];
        }),
    );
    type Spot = { x: number; y: number; exposure: number };
    const best = (spots: Spot[]) => spots.reduce<Spot | null>((a, b) => (a && a.exposure >= b.exposure ? a : b), null);
    const placed = shown.map((spots, i) =>
        best(spots.filter(({ x }) => x > ((i + 0.15) / 4) * w && x < ((i + 0.85) / 4) * w)),
    );
    placed.forEach((spot, i) => {
        if (spot) return;
        const clear = (s: Spot) => placed.every((o) => !o || Math.abs(o.x - s.x) > 64 || Math.abs(o.y - s.y) > 24);
        placed[i] = best((shown[i] ?? []).filter(clear));
    });
    placed.forEach((spot, i) => {
        const label = labels[i];
        if (!label) return;
        label.hidden = !spot;
        if (!spot) return;
        label.textContent = km(distances[i] ?? 0);
        Object.assign(label.style, { left: `${spot.x.toFixed(1)}px`, top: `${spot.y.toFixed(1)}px` });
    });
}

/**
 * The profile: the ground curving away below the level through the observer's feet, the four ridges standing on it at
 * their nominal heights, and the bent sight lines to their tops, dashed where a ridge in front or the ground hides one.
 */
function drawProfile(air: Air, h0: number, distances: number[]) {
    const [width, height] = [profile.clientWidth || 600, profile.clientHeight || 160];
    profile.setAttribute("viewBox", `0 0 ${width} ${height}`);
    const far = distances[distances.length - 1] ?? 1;
    const xMax = far * 1.06;
    const ground = (x: number) => Math.sqrt(air.rg * air.rg - x * x) - air.rg;
    const yMax = Math.max(h0, ...HEIGHTS_KM) * 1.12;
    const yMin = Math.min(ground(xMax), -0.02 * yMax);
    const margin = { top: 10, bottom: 40, left: 6, right: 6 };
    const X = (x: number) => margin.left + (x / xMax) * (width - margin.left - margin.right);
    const Y = (y: number) => margin.top + ((yMax - y) / (yMax - yMin)) * (height - margin.top - margin.bottom);
    const f = (n: number) => n.toFixed(1);
    const at = ([x, y]: Vec2) => `${f(X(x))},${f(Y(y))}`;

    let svg = "";
    // The ground, filled below its curve, and the level the drop is measured from.
    const curve = Array.from({ length: 49 }, (_, n) => [(xMax * n) / 48, ground((xMax * n) / 48)] as Vec2);
    const below = `${f(X(xMax))},${height} ${f(X(0))},${height}`;
    svg += `<polygon points="${curve.map(at).join(" ")} ${below}" class="distance-ground"/>`;
    svg += `<polyline points="${curve.map(at).join(" ")}" class="distance-surface"/>`;
    svg += `<line x1="${f(X(0))}" y1="${f(Y(0))}" x2="${f(X(xMax))}" y2="${f(Y(0))}" class="distance-level"/>`;

    // Each ridge as a peak on the ground, a fixed width on screen, its top at its nominal height straight above.
    const half = Math.min(14, (X(distances[0] ?? 0) - X(0)) * 0.6);
    const tops: { x: number; e: number; buried: boolean; points: Vec2[] }[] = [];
    distances.forEach((along, i) => {
        const theta = along / air.rg;
        const H = HEIGHTS_KM[i] ?? 0;
        const [bx, by] = [X(air.rg * Math.sin(theta)), Y(ground(air.rg * Math.sin(theta)))];
        const [tx, ty] = [X((air.rg + H) * Math.sin(theta)), Y((air.rg + H) * Math.cos(theta) - air.rg)];
        const [left, right] = [`${f(bx - half)},${f(by + 2)}`, `${f(bx + half)},${f(by + 2)}`];
        const peak = `Q${f(bx - half * 0.3)},${f(ty)} ${f(tx)},${f(ty)} Q${f(bx + half * 0.3)},${f(ty)}`;
        svg += `<path d="M${left} ${peak} ${right} Z" class="distance-ridge"/>`;
        const sight = elevationOf(air, h0, distances, i, H);
        tops.push({ x: tx, e: sight.e, buried: sight.crossings[i]?.buried ?? false, points: sight.points });
        svg += svgText(bx, height - margin.bottom + 8, km(along), "figure-note");
        svg += svgText(bx, height - margin.bottom + 24, meters(H), "figure-label");
    });
    // The sight lines from the eye, at its height over the feet, as traced: dashed where something stands in the way.
    tops.forEach(({ e, buried, points }, i) => {
        const hidden = buried || tops.slice(0, i).some((front) => front.e > e);
        const line = points.map(([x, y]) => at([x, y + h0])).join(" ");
        svg += `<polyline points="${line}" class="distance-sight${hidden ? " distance-hidden" : ""}"/>`;
    });
    svg += `<circle cx="${f(X(0))}" cy="${f(Y(h0))}" r="3" class="distance-eye"/>`;
    // How far the ground has dropped below the level at the farthest ridge.
    const drop = -ground(air.rg * Math.sin(far / air.rg));
    const dropX = X(air.rg * Math.sin(far / air.rg)) - half - GAP;
    if (Y(-drop) - Y(0) > 12) {
        svg += `<line x1="${f(dropX)}" y1="${f(Y(0))}" x2="${f(dropX)}" y2="${f(Y(-drop))}" class="distance-drop"/>`;
        svg += svgText(dropX - GAP, (Y(0) + Y(-drop)) / 2, meters(drop), "figure-note figure-anchor-end");
    }
    drawSvg(profile, svg, 1);
}
