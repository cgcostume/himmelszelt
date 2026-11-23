import { wgsl as dunstkreis, GROUND_GRID_STRENGTH, groundGridOffsets } from "@himmelszelt/dunstkreis";
import { wgsl as gewoelk } from "@himmelszelt/gewoelk";
import { fromJulianDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../../dom";
import {
    bindHdr,
    configureCanvas,
    display,
    displayOutput,
    gpuDevice,
    HDR,
    onDisplay,
    SDR,
    gpu as shared,
} from "../../dunstkreis/atmosphere";
import { flight, flightIn } from "../../dunstkreis/flight";
import { type Basis, cameraBasis, lookAround, project, type SkyCamera } from "../../dunstkreis/skycamera";
import { onDemand } from "../../frame";
import { paintRange } from "../../range";
import { COMPASS } from "../../sternzeit/figure";
import { onChange, state } from "../../sternzeit/state";
import { gpuMissing } from "../../webgpu";
import view from "./view.wgsl";

/**
 * What gewoelk's research figures share: a canvas a compute pass writes, the view and its uniform, sliders, switches,
 * presets, an animation clock and GPU timings. A figure brings its passes and draws when asked.
 */

const DEG = Math.PI / 180;
const VIEW_SIZE = 208;
const CURVES = { neutral: 1, agx: 2, aces: 3, clip: 4 };

/** `LabView` packed, as view.wgsl reads it. */
export function viewData(view: {
    basis: Basis;
    sun: readonly number[];
    heightM: number;
    radiusKm: number;
    ev100: number;
    pixelAngle: number;
    clock?: number;
    frame?: number;
    flown: { east: number; north: number };
    grid: boolean;
    /** What the stand-in sun's light is multiplied by, 1 by default: the Moon's share of it by night. */
    lightScale?: number;
    /** The luminance in cd/m² the stand-in sky's colors are brought to for the clouds' ambient light; 0 as they are. */
    skyLuminance?: number;
    /** How many times SDR white the display may show, 1 by default. */
    headroom?: number;
}) {
    const { f, r, u, tx, ty, d } = view.basis;
    const data = new Float32Array(VIEW_SIZE / 4);
    data.set([...r.map((c) => c * tx), 0, ...u.map((c) => c * ty), 0, 0, 0, 0, 1, ...f, 0], 0);
    data.set([...view.sun, d], 16);
    data.set([Math.max(view.heightM, 1) / 1000, view.radiusKm, 1 / (1.2 * 2 ** view.ev100), view.pixelAngle], 20);
    data.set([view.clock ?? 0, view.frame ?? 0, view.flown.east, view.flown.north], 24);
    data.set(groundGridOffsets(view.flown), 28);
    data.set(
        [view.grid ? GROUND_GRID_STRENGTH : 0, view.lightScale ?? 1, view.skyLuminance ?? 0, view.headroom ?? 1],
        44,
    );
    new Uint32Array(data.buffer)[48] = CURVES[display.toneCurve];
    return data;
}
/** What every research pass starts with: camera rays, tone curves, phase functions, the ground's grid, the view. */
export const PRELUDE = [gewoelk.camera, gewoelk.tonemap, gewoelk.phase, dunstkreis.groundgrid, view].join("\n");
export const NOISE = gewoelk.noise;

export type Presets = Record<string, Record<string, number>>;

/** GPU timings by name: timestamps around the passes of a frame, read back one frame at a time. */
function createTimer(device: GPUDevice, onRead: () => void, slots = 12) {
    const ms: Record<string, number> = {};
    if (!device.features.has("timestamp-query")) return { writes: () => undefined, resolve: () => {}, ms, read() {} };
    const set = device.createQuerySet({ type: "timestamp", count: slots * 2 });
    const usage = GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC;
    const resolved = device.createBuffer({ size: slots * 16, usage });
    const staged = device.createBuffer({ size: slots * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    let names: string[] = [];
    let busy = false;
    return {
        ms,
        /** Timestamps for a pass named `name`, or none while the last frame's are still being read. */
        writes(name: string): GPUComputePassTimestampWrites | undefined {
            if (busy || names.length >= slots) return undefined;
            const i = names.push(name) - 1;
            return { querySet: set, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
        },
        resolve(encoder: GPUCommandEncoder) {
            if (busy || names.length === 0) return;
            encoder.resolveQuerySet(set, 0, names.length * 2, resolved, 0);
            encoder.copyBufferToBuffer(resolved, 0, staged, 0, names.length * 16);
        },
        /** After the frame's submission. */
        async read() {
            if (busy || names.length === 0) return;
            busy = true;
            const taken = names;
            names = [];
            await staged.mapAsync(GPUMapMode.READ, 0, taken.length * 16);
            const stamps = new BigInt64Array(staged.getMappedRange(0, taken.length * 16));
            // Passes of one name add up, as the steps of a build do.
            const sums: Record<string, number> = {};
            taken.forEach((name, i) => {
                const span = Number((stamps[i * 2 + 1] ?? 0n) - (stamps[i * 2] ?? 0n)) / 1e6;
                sums[name] = (sums[name] ?? 0) + span;
            });
            Object.assign(ms, sums);
            staged.unmap();
            busy = false;
            onRead();
        },
    };
}

export type Lab = NonNullable<ReturnType<typeof createLab>>;

/**
 * A camera that orbits a point over the ground: the point's height and where it lies, in km east and north of where the
 * figure's ground starts, the compass bearing from it to the camera, the camera's elevation over it and its distance.
 */
export interface Orbit {
    center: { east: number; north: number };
    heightKm: number;
    /** How far over that height the camera looks instead, in km: panned with shift held, or set by the figure. */
    liftKm: number;
    azimuth: number;
    elevation: number;
    distanceKm: number;
    /** The nearest and the farthest the wheel zooms to. */
    reachKm: readonly [number, number];
}
// Below the point it looks at too, as far as the ground lets it: from under a cloud, up at its base.
const ORBIT_ELEVATION = [-80 * DEG, 89 * DEG] as const;
const ORBIT_LEAST_HEIGHT_KM = 0.02;
/** The heights an orbit's camera looks at, in km. */
export const ORBIT_HEIGHT_KM = [0, 18] as const;
const EARTH_KM = 6360;

/** Where an orbit's camera stands: how far along the ground from its center, how high, and the pitch it looks at it by. */
function orbitCamera({ heightKm: centerKm, liftKm, elevation, distanceKm }: Orbit) {
    const heightKm = centerKm + liftKm;
    const out = distanceKm * Math.cos(elevation);
    const up = EARTH_KM + heightKm + distanceKm * Math.sin(elevation);
    const heightAbove = Math.max(Math.hypot(out, up) - EARTH_KM, ORBIT_LEAST_HEIGHT_KM);
    const arc = Math.atan2(out, up);
    // The center as the camera has it, in its own horizon's frame: so far out, and so far below.
    const [across, below] = [(EARTH_KM + heightKm) * Math.sin(arc), (EARTH_KM + heightKm) * Math.cos(arc)];
    return {
        groundKm: EARTH_KM * arc,
        heightKm: heightAbove,
        pitch: Math.atan2(below - EARTH_KM - heightAbove, across),
    };
}

/** Drag on `canvas` to turn `orbit` about its center, with shift held to look higher or lower, turn the wheel or pinch to move in and out. */
function orbitAround(canvas: HTMLCanvasElement, orbit: Orbit, onChange: () => void) {
    const zoom = (factor: number) => {
        orbit.distanceKm = Math.min(Math.max(orbit.distanceKm * factor, orbit.reachKm[0]), orbit.reachKm[1]);
        onChange();
    };
    const pointers = new Map<number, { x: number; y: number }>();
    const spread = () => {
        const [a, b] = [...pointers.values()];
        return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    // In flight the camera is the flight's: the orbit rests until it has landed.
    const aloft = () => canvas.hasAttribute("data-flying");
    canvas.addEventListener("pointerdown", (event) => {
        if (aloft()) return;
        canvas.setPointerCapture(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    canvas.addEventListener("pointermove", (event) => {
        const last = pointers.get(event.pointerId);
        if (!last || aloft()) return;
        const before = spread();
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (pointers.size > 1) return before > 0 ? zoom(before / Math.max(spread(), 1)) : undefined;
        if (event.shiftKey) {
            // A pixel's worth of the view at the center, about: the picture follows the pointer.
            const lifted = orbit.heightKm + orbit.liftKm + (event.clientY - last.y) * orbit.distanceKm * 0.0015;
            orbit.liftKm = Math.min(Math.max(lifted, ORBIT_HEIGHT_KM[0]), ORBIT_HEIGHT_KM[1]) - orbit.heightKm;
            return onChange();
        }
        orbit.azimuth += (event.clientX - last.x) * 0.006;
        const elevation = orbit.elevation + (event.clientY - last.y) * 0.006;
        orbit.elevation = Math.min(Math.max(elevation, ORBIT_ELEVATION[0]), ORBIT_ELEVATION[1]);
        onChange();
    });
    for (const type of ["pointerup", "pointercancel"] as const)
        canvas.addEventListener(type, (event) => pointers.delete(event.pointerId));
    canvas.addEventListener(
        "wheel",
        (event) => {
            if (aloft()) return;
            event.preventDefault();
            zoom(Math.exp(event.deltaY * 0.001));
        },
        { passive: false },
    );
}

/** The research figure on `root`: `draw` renders one frame with what the returned lab holds. */
export function createLab(
    root: HTMLElement,
    draw: (lab: Lab) => void,
    options: {
        presets?: Presets;
        morePresets?: Record<string, Presets>;
        camera?: SkyCamera;
        /** A camera that orbits a point, where the figure is not one to look around and fly in. */
        orbit?: Orbit;
        /** How many times as fast as a clock the lab's runs, where the figure has no choice named "speed" for it. */
        speed?: () => number;
    } = {},
) {
    const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const maybe = (name: string) => root.querySelector<HTMLElement>(`[data-field="${name}"]`);
    const canvas = field<HTMLCanvasElement>("canvas");
    const context = shared.error || !shared.device ? null : canvas.getContext("webgpu");
    if (!context) {
        gpuMissing(canvas, "sky-error");
        return null;
    }
    // Half floats whatever the display: one canvas format for the passes that write it, and values over 1 only where
    // the page's display choice gives them headroom. A browser without half float canvases (Firefox) gets them
    // offscreen, copied to an rgba8unorm canvas.
    const device = gpuDevice();
    const offscreen = halfFloatsOffscreen(device, context);

    const sliders = [...root.querySelectorAll<HTMLInputElement>("input[data-param]")];
    const byParam = new Map(sliders.map((input) => [input.dataset.param ?? "", input]));
    const camera = options.camera ?? { yaw: 20 * DEG, pitch: 35 * DEG, fov: 90 * DEG };
    const compass = maybe("compassLabels");
    const labels = COMPASS.map((name) =>
        compass?.appendChild(Object.assign(document.createElement("span"), { textContent: name })),
    );

    // The lab's own clock, running only while its animation is switched on, at the chosen speed.
    let clock = 0;
    let last = 0;
    let frame = 0;
    // Flight, and the height and the place over the ground the figure is seen from: its own, no other figure follows.
    // An orbit has neither: the camera stands where the orbit puts it, before every frame.
    const { orbit } = options;
    const flying = orbit ? null : flightIn(root, canvas, camera, () => lab.request());
    const flown = flying?.flown ?? { east: 0, north: 0 };
    let orbitHeightM = 1;
    const seenFrom = flying?.height ?? (() => orbitHeightM);
    function placeOrbit() {
        // In flight the camera stays where it has flown to: landed, it is back on its orbit.
        if (!orbit || canvas.hasAttribute("data-flying")) return;
        const { groundKm, heightKm, pitch } = orbitCamera(orbit);
        flown.east = orbit.center.east + groundKm * Math.sin(orbit.azimuth);
        flown.north = orbit.center.north + groundKm * Math.cos(orbit.azimuth);
        orbitHeightM = heightKm * 1000;
        Object.assign(camera, { yaw: orbit.azimuth + Math.PI, pitch });
    }
    const view = device.createBuffer({ size: VIEW_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    let viewed: Parameters<typeof viewData>[0] | null = null;

    const lab = {
        root,
        canvas,
        device,
        context,
        camera,
        /** The half float texture to write a frame into: the canvas', or one shown on it by `present()`. */
        target: () => offscreen?.target() ?? context.getCurrentTexture(),
        /** Shows the frame written into `target()` on the canvas, where that was not the canvas' own. */
        present: () => offscreen?.present(),
        /** The view's uniform, written by `size()`. */
        view,
        /** How far the figure has flown from where it started, in km east and north. */
        flown,
        value: (param: string) => Number(byParam.get(param)?.value ?? 0),
        pressed: (name: string) => maybe(name)?.getAttribute("aria-pressed") === "true",
        choice: (name: string) =>
            root.querySelector<HTMLInputElement>(`input[name="${root.id}-${name}"]:checked`)?.value ?? "",
        /** Seconds on the lab's clock. */
        get clock() {
            return clock;
        },
        /** The sun's direction at the page's moment and place, as every figure of the page has it. */
        sun: (): readonly [number, number, number] => sun.direction(fromJulianDay(state.jd), state),
        /** Sizes the canvas to its box, writes the view's uniform and returns the size in pixels. */
        size() {
            placeOrbit();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
            const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
            if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
            const basis = cameraBasis(camera, width / height);
            const ev100 = byParam.has("view.ev") ? lab.value("view.ev") : 14.5;
            const pixelAngle = Math.min(camera.fov, Math.PI) / height;
            const grid = lab.pressed("ground.grid");
            const heightM = seenFrom();
            const { headroom } = displayOutput();
            const sun = lab.sun();
            viewed = { basis, sun, heightM, radiusKm: 6360, ev100, pixelAngle, clock, frame, flown, grid, headroom };
            const data = viewData(viewed);
            device.queue.writeBuffer(view, 0, data);
            if (compass) {
                compass.hidden = Number(maybe("marks")?.dataset.level ?? 1) < 1;
                labels.forEach((label, i) => {
                    if (!label) return;
                    const at = project(
                        [Math.sin(i * 45 * DEG), Math.cos(i * 45 * DEG), 0],
                        basis,
                        canvas.clientWidth,
                        canvas.clientHeight,
                    );
                    label.hidden = at === null;
                    if (at) Object.assign(label.style, { left: `${at.x}px`, top: `${at.y}px` });
                });
            }
            return {
                width,
                height,
                dpr,
                heightM,
                headroom,
                inverseViewProjection: data.slice(0, 16),
                projectionDistance: basis.d,
            };
        },
        /** The view's uniform again with another light: for a figure whose light and exposure come from a real sky. */
        relight(light: { sun: readonly number[]; ev100: number; lightScale: number; skyLuminance: number }) {
            if (viewed) device.queue.writeBuffer(view, 0, viewData({ ...viewed, ...light }));
        },
        timer: createTimer(device, () => {
            showStatus();
            lab.timed();
        }),
        /** Called when a frame's timings were read back. */
        timed: (() => {}) as () => void,
        /** The line under the figure: the GPU's name and whatever `status` gives. */
        status: (() => "") as () => string,
        request: () => {},
        /**
         * Eases the sliders named in `values` over to them, as a preset does, or sets them at once, and checks the
         * choices its "@choice" entries name: one easing at a time for each `group`.
         */
        apply(group: string, values: Record<string, number>, eased = true) {
            for (const [key, value] of Object.entries(values)) {
                if (!key.startsWith("@")) continue;
                const name = `${root.id}-${key.slice(1)}`;
                const input = root.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
                if (input) input.checked = true;
            }
            if (eased) return ease(group, values);
            for (const [param, value] of Object.entries(values)) {
                const input = byParam.get(param);
                if (!input) continue;
                input.value = String(value);
                paintRange(input);
            }
            lab.request();
        },
    };

    function showStatus() {
        const note = maybe("timing");
        if (note) note.textContent = [shared.adapterName, lab.status()].filter(Boolean).join(" · ");
    }

    lab.request = onDemand(() => {
        const now = performance.now();
        const animating = lab.pressed("animate");
        const speed = options.speed?.() ?? (Number(lab.choice("speed")) || 1);
        if (animating && last > 0) clock += (Math.min(now - last, 100) / 1000) * speed;
        last = animating ? now : 0;
        frame += 1;
        draw(lab);
        for (const input of sliders) {
            const output = input.parentElement?.querySelector("output");
            if (output) output.textContent = input.value;
        }
        showStatus();
        // The one thing that keeps frames coming: an animation switched on.
        if (animating) lab.request();
    }, root);

    // The presets by the name of the choice that picks one: the figure's own, and more where it has several kinds.
    const presets: Record<string, Presets> = { preset: options.presets ?? {}, ...options.morePresets };
    // A preset's choices, its entries named "@choice": the option of that value checked.
    function checkChoices(group: string, name: string) {
        for (const [key, value] of Object.entries(presets[group]?.[name] ?? {})) {
            if (!key.startsWith("@")) continue;
            const input = root.querySelector<HTMLInputElement>(
                `input[name="${root.id}-${key.slice(1)}"][value="${value}"]`,
            );
            if (input) input.checked = true;
        }
    }
    // A preset: its sliders eased over from where they stand, the frames drawn only while that lasts.
    const easing = new Map<string, number>();
    function applyPreset(group: string, name: string) {
        checkChoices(group, name);
        ease(group, presets[group]?.[name] ?? {});
    }
    function ease(group: string, values: Record<string, number>) {
        const target = Object.entries(values).flatMap(([param, to]) => {
            const input = byParam.get(param);
            return input ? [{ input, from: Number(input.value), to }] : [];
        });
        const start = performance.now();
        cancelAnimationFrame(easing.get(group) ?? 0);
        const step = (now: number) => {
            const t = Math.min(1, (now - start) / 1200);
            const s = t * t * (3 - 2 * t);
            for (const { input, from, to } of target) {
                input.value = String(from + (to - from) * s);
                paintRange(input);
            }
            lab.request();
            if (t < 1) easing.set(group, requestAnimationFrame(step));
        };
        easing.set(group, requestAnimationFrame(step));
    }

    for (const input of sliders) {
        paintRange(input);
        input.addEventListener("input", lab.request);
    }
    for (const input of root.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
        const group = input.name.slice(root.id.length + 1);
        input.addEventListener("change", () => (group in presets ? applyPreset(group, input.value) : lab.request()));
    }
    for (const button of root.querySelectorAll<HTMLButtonElement>("button.view-toggle[data-field]")) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"));
            lab.request();
        });
    }
    // The sliders as a preset, to paste into the figure's list.
    for (const button of root.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
        button.addEventListener("click", async () => {
            const values = sliders.map((input) => `"${input.dataset.param}": ${Number(input.value)}`);
            await navigator.clipboard.writeText(`{ ${values.join(", ")} }`);
            button.textContent = "copied";
            setTimeout(() => (button.textContent = "copy"), 1200);
        });
    }
    maybe("marks")?.addEventListener("click", lab.request);
    onChange(lab.request);
    new ResizeObserver(lab.request).observe(canvas);
    if (orbit) {
        orbitAround(canvas, orbit, lab.request);
        // Flight from where the orbit's camera stands, over the figure's own ground: the page's place stays.
        flight(canvas, camera, {
            button: maybe("fly"),
            height: () => orbitHeightM,
            move(eastKm, northKm, heightM) {
                flown.east += eastKm;
                flown.north += northKm;
                orbitHeightM = heightM;
                lab.request();
            },
            look: lab.request,
            hint: root.querySelector('.fig-hint[data-for="view"]'),
        });
    } else lookAround(canvas, camera, { onChange: lab.request });
    // The checked preset's values over the sliders' own, so the two never disagree at the start.
    for (const group of Object.keys(presets)) {
        const first = lab.choice(group);
        checkChoices(group, first);
        for (const [param, value] of Object.entries(presets[group]?.[first] ?? {})) {
            const input = byParam.get(param);
            if (input) {
                input.value = String(value);
                paintRange(input);
            }
        }
    }
    // The page's display choice: its headroom radios where the figure has them, and a frame when it changes.
    const hdr = ["note", "choice"].map((name) => root.querySelector<HTMLElement>(`[data-hdr="${name}"]`));
    if (hdr[0] && hdr[1]) bindHdr(hdr[0], hdr[1]);
    onDisplay(() => lab.request());
    lab.request();
    return lab;
}

/** A compute pipeline of `code` after the research prelude, its layout derived. */
export function labPipeline(device: GPUDevice, label: string, code: string, entryPoint: string) {
    const module = device.createShaderModule({ label, code: `${PRELUDE}\n${code}` });
    return device.createComputePipelineAsync({ label, layout: "auto", compute: { module, entryPoint } });
}

/** The WGSL struct `name` of f32 fields, and the packing of their values in the same order. */
export function floatStruct(name: string, fields: readonly string[]) {
    // Padded to a multiple of 16 bytes, as a uniform struct of floats is.
    const padded = [...fields, ...Array.from({ length: (4 - (fields.length % 4)) % 4 }, (_, i) => `pad${i}`)];
    return {
        wgsl: `struct ${name} {\n${padded.map((field) => `    ${field}: f32,`).join("\n")}\n}`,
        size: padded.length * 4,
        pack: (values: Record<string, number>) => new Float32Array(padded.map((field) => values[field] ?? 0)),
    };
}

const COPY = /* wgsl */ `
@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var output: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
    if (any(id.xy >= textureDimensions(output))) {
        return;
    }
    textureStore(output, id.xy, vec4f(clamp(textureLoad(source, id.xy, 0).rgb, vec3f(0.0), vec3f(1.0)), 1.0));
}`;

/**
 * Configures `context` for half floats, or where the browser has no such canvas, for rgba8unorm with an rgba16float
 * texture of its size to write into and copy over: null when the canvas takes half floats itself.
 */
function halfFloatsOffscreen(device: GPUDevice, context: GPUCanvasContext) {
    try {
        configureCanvas(context, HDR);
        return null;
    } catch {
        configureCanvas(context, SDR);
    }
    const pipeline = device.createComputePipeline({
        label: "sternwarte:labCopy",
        layout: "auto",
        compute: { module: device.createShaderModule({ code: COPY }), entryPoint: "main" },
    });
    let texture: GPUTexture | null = null;
    return {
        target() {
            const { width, height } = context.canvas;
            if (!texture || texture.width !== width || texture.height !== height) {
                texture?.destroy();
                texture = device.createTexture({
                    label: "sternwarte:labOffscreen",
                    size: [width, height],
                    format: HDR,
                    usage:
                        GPUTextureUsage.STORAGE_BINDING |
                        GPUTextureUsage.TEXTURE_BINDING |
                        GPUTextureUsage.RENDER_ATTACHMENT,
                });
            }
            return texture;
        },
        present() {
            if (!texture) return;
            const canvas = context.getCurrentTexture();
            const encoder = device.createCommandEncoder({ label: "sternwarte:labCopy" });
            const pass = encoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(
                0,
                device.createBindGroup({
                    layout: pipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: texture.createView() },
                        { binding: 1, resource: canvas.createView() },
                    ],
                }),
            );
            pass.dispatchWorkgroups(Math.ceil(canvas.width / 8), Math.ceil(canvas.height / 8));
            pass.end();
            device.queue.submit([encoder.finish()]);
        },
    };
}
