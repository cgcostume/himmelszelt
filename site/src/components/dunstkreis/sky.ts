import type { AtmosphereLUTs, AtmosphereModel, SkyPass, SkyPassOptions } from "@himmelszelt/dunstkreis";
import {
    apparentDirection,
    clampObserverHeight,
    createSkyPass,
    DEFAULT_AUTO_EXPOSURE_KEYS,
    precomputeAtmosphere,
} from "@himmelszelt/dunstkreis";
import { fromJulianDay, julianEphemerisDay, sun } from "@himmelszelt/sternzeit";
import { find } from "../dom";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { COMPASS } from "../sternzeit/figure";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";
import {
    bindHdr,
    bindModelChoice,
    bindToneCurveChoice,
    configureCanvas,
    display,
    displayOutput,
    gpuDevice,
    onDisplay,
    onTables,
    quality,
    recompute,
    SDR,
    gpu as shared,
    skyViewChanged,
    tables,
} from "./atmosphere";
import { type Basis, cameraBasis, lookAround, project } from "./skycamera";

// The parts of the sky a figure with `data-parts` switches: the air's three ingredients, which take tables of their own
// without them, and the two orders of scattering, which the sky pass adds up or leaves out.
const INGREDIENTS = ["rayleigh", "mie", "ozone"] as const;
const ORDERS = { single: true, multiple: true };
const NONE = [0, 0, 0, 0] as const;

// Which of the page's tables a figure's own were made from, so new ones, of another model or size, make them anew.
const ids = new WeakMap<AtmosphereLUTs, number>();
let lastId = 0;
function tablesId(luts: AtmosphereLUTs) {
    if (!ids.has(luts)) ids.set(luts, ++lastId);
    return ids.get(luts);
}

/** `model` without the ingredients in `off`: their coefficients zero, so they neither scatter nor absorb. */
function without(model: AtmosphereModel, off: readonly string[]): AtmosphereModel {
    return {
        ...model,
        rayleigh: off.includes("rayleigh") ? { ...model.rayleigh, beta: NONE } : model.rayleigh,
        mie: off.includes("mie") ? { ...model.mie, betaScattering: NONE, betaExtinction: NONE } : model.mie,
        ozone: off.includes("ozone") ? { ...model.ozone, betaAbsorption: NONE } : model.ozone,
    };
}

// The two libraries meet in one vector: sternzeit says where the Sun is, dunstkreis what the air does to its light.
const DEG = Math.PI / 180;

/**
 * One sky figure on `root`, a `figure[data-sky]`. With `data-full` it carries every option, tone curve, HDR, model,
 * exposure, dither and refraction, bound to the page's shared display and tables; without, it shows the sky as a
 * reader meets it first, with the grid, metered and refracted, and only the Sun lock to press. With `data-primary` it
 * tells the other figures of its sky, which take their tables, cube map and lighting from it: one figure per page. The
 * frame around it, height, play and full screen, is SkyFrame's.
 */
export function skyFigure(root: HTMLElement) {
    const full = root.hasAttribute("data-full");
    const primary = root.hasAttribute("data-primary");
    const parts = root.hasAttribute("data-parts");
    const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const maybe = <T extends HTMLElement = HTMLElement>(name: string) =>
        root.querySelector<T>(`[data-field="${name}"]`);
    const canvas = field<HTMLCanvasElement>("canvas");
    const compass = field("compass");
    // A switch's state, or what the figure without it is fixed to: everything on, the refraction the page's.
    const PRESET: Record<string, () => boolean> = { refraction: () => quality.refraction };
    const pressed = (name: string) =>
        maybe(name)?.getAttribute("aria-pressed") === "true" || (!maybe(name) && (PRESET[name]?.() ?? true));
    // Whether `settings` holds every value of `wanted`.
    const holds = (settings: object | null, wanted: object) =>
        settings !== null &&
        Object.entries(wanted).every(([key, value]) => (settings as Record<string, unknown>)[key] === value);

    // The tables without the ingredients switched off, computed for this figure alone, and which ones are on the way.
    let own: { key: string; luts: AtmosphereLUTs } | null = null;
    let owning = "";
    // The orders of scattering as one object per combination, so a pass' settings compare equal from frame to frame.
    const orders = new Map<string, { single: boolean; multiple: boolean }>();

    /** The tables this figure draws with: the page's, or its own without some of the air's ingredients. */
    function figureTables() {
        const page = tables();
        const off = INGREDIENTS.filter((name) => !pressed(name));
        if (!page || off.length === 0) return page;
        const key = `${off.join()} ${tablesId(page.luts)}`;
        if (own?.key === key) return own;
        if (owning !== key && gpu) {
            owning = key;
            const { model, config } = page.luts;
            precomputeAtmosphere(gpu.device, { model: without(model, off), config }).then((luts) => {
                if (owning !== key) return luts.destroy();
                own = { key, luts };
                requestRender();
            });
        }
        // Until they are in, the sky as it was.
        return own ?? page;
    }

    /** Which orders of scattering the pass adds up, as the switches say. */
    function scattering() {
        const [single, multiple] = (Object.keys(ORDERS) as (keyof typeof ORDERS)[]).map(pressed);
        const key = `${single} ${multiple}`;
        if (!orders.has(key)) orders.set(key, { single: Boolean(single), multiple: Boolean(multiple) });
        return orders.get(key);
    }

    // Camera in the observer's ENU frame, yaw a compass azimuth; locked to the sun until dragged.
    const camera = { yaw: 0, pitch: 10 * DEG, fov: 70 * DEG };

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
        return { device: gpuDevice(), context, format: SDR, adapterName: shared.adapterName };
    }

    /**
     * The inverse view-projection the pass turns pixels back into rays with, built directly: of a reversed-z projection with
     * an infinite far plane, the near plane at 1, without translation. A clip-space point (x, y) maps to the direction
     * forward + x·tx·right + y·ty·up. Column major, like WGSL.
     */
    function inverseViewProjection({ f, r, u, tx, ty }: Basis) {
        return new Float32Array([...r.map((c) => c * tx), 0, ...u.map((c) => c * ty), 0, 0, 0, 0, 1, ...f, 0]);
    }

    // The eight compass directions as labels standing on the horizon, placed by the same projection the sky uses.
    const labels = COMPASS.map((name) =>
        compass.appendChild(Object.assign(document.createElement("span"), { textContent: name })),
    );

    function placeCompass(basis: Basis, width: number, height: number) {
        compass.hidden = !pressed("grid");
        labels.forEach((label, i) => {
            const at = project([Math.sin(i * 45 * DEG), Math.cos(i * 45 * DEG), 0], basis, width, height);
            label.hidden = at === null;
            if (at === null) return;
            label.style.left = `${at.x}px`;
            label.style.top = `${at.y}px`;
        });
    }

    const gpu = setup();
    let pass: SkyPass | null = null;
    let passFor: Partial<SkyPassOptions> = {};
    // The pass the environment was last told of.
    let notified: SkyPass | null = null;
    let skyViewFor = "";
    // The settings of the pass being compiled, which takes its place once it is in.
    let building: SkyPassOptions | null = null;
    const requestRender = onDemand(render);

    /** Makes the pass for `settings` without blocking; the last one asked for takes over, and the old tables go with it. */
    function buildPass(settings: SkyPassOptions) {
        if (!gpu || holds(building, settings)) return;
        building = settings;
        const { luts, ...features } = settings;
        createSkyPass(gpu.device, { luts, ...features }).then((next) => {
            if (building !== settings) return next.destroy();
            if (settings.format !== gpu.format) {
                configureCanvas(gpu.context, settings.format);
                gpu.format = settings.format;
            }
            pass?.destroy();
            // Tables nothing draws with any more: the page's once replaced, or this figure's own once switched again.
            const old = passFor.luts;
            if (old && old !== luts && old !== tables()?.luts && old !== own?.luts) old.destroy();
            pass = next;
            passFor = settings;
            building = null;
            requestRender();
        });
    }

    // Where the time goes, shown with the grid: the astronomy, the sky pass' own CPU work, and when the GPU was done.
    function showTiming(astronomyMs: number, skyMs: number, submitted: number) {
        if (!gpu) return;
        const text = (doneMs: number) =>
            `${gpu.adapterName} · precompute ${tables()?.precomputeMs.toFixed(1)} ms · astronomy ${astronomyMs.toFixed(2)} ms · ` +
            `sky ${skyMs.toFixed(2)} ms · GPU done after ${doneMs.toFixed(2)} ms`;
        gpu.device.queue.onSubmittedWorkDone().then(() => {
            const timing = maybe("timing");
            if (timing) timing.textContent = pressed("grid") ? text(performance.now() - submitted) : "";
        });
    }

    function render() {
        const table = figureTables();
        if (!gpu || !table) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });

        const started = performance.now();
        const time = fromJulianDay(state.jd);
        const position = sun.horizontalPosition(time, state);
        const sunDirection = sun.direction(time, state);
        const sunAngularDiameter = sun.apparentAngularDiameter(julianEphemerisDay(time));
        const astronomyMs = performance.now() - started;

        const debugGrid = pressed("grid");
        // The figure with every option follows the page's display choices; the other shows SDR, Neutral, as a reader meets it.
        const { format, headroom } = full ? displayOutput() : { format: SDR, headroom: 1 };
        // Half floats need no dither: their steps are far finer than 8 bits'.
        const dither = pressed("dither") && format === SDR;
        const ditherButton = maybe<HTMLButtonElement>("dither");
        if (ditherButton) ditherButton.disabled = format !== SDR;
        const autoExposure = pressed("auto");
        // Where the sun shows, lifted by the same air the sky is traced through.
        const [x, y, z] = apparentDirection(sunDirection, table.luts.model, clampObserverHeight(state.heightM));
        const sunNote = maybe("sun");
        if (sunNote)
            sunNote.textContent =
                `Sun ${position.altitude.toFixed(2)}° high (${(Math.asin(z) / DEG).toFixed(2)}° apparent), ` +
                `azimuth ${position.azimuth.toFixed(2)}°`;
        // On the Sun's true direction, where the grid's symbol marks it, so the view follows it below the horizon too.
        if (pressed("lock")) {
            camera.yaw = Math.atan2(sunDirection[0], sunDirection[1]);
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(sunDirection[2])));
        }
        const skyStarted = performance.now();
        const toneMap = full ? display.toneCurve : "neutral";
        const settings: SkyPassOptions = {
            luts: table.luts,
            debugGrid,
            groundLight: quality.groundLight,
            dither,
            autoExposure,
            toneMap,
            format,
            headroom,
            ...(parts ? { scattering: scattering() } : {}),
        };
        if (!pass || !holds(passFor, settings)) {
            // Shown once it is compiled; until then the canvas keeps the last frame.
            buildPass(settings);
            return;
        }

        const basis = cameraBasis(camera, width / height);
        pass.update({
            sunDirection,
            sunAngularDiameter,
            observerHeightM: state.heightM,
            inverseViewProjection: inverseViewProjection(basis),
            projectionDistance: basis.d,
            pixelRatio: dpr,
            ev100: evOfSlider(),
            autoExposureKeys: pressed("ramp") ? DEFAULT_AUTO_EXPOSURE_KEYS : [],
        });
        const skyViewKey = `${state.jd},${state.latitude},${state.longitude},${state.heightM}`;
        if (primary && (skyViewKey !== skyViewFor || pass !== notified)) {
            skyViewFor = skyViewKey;
            notified = pass;
            const observerHeightM = clampObserverHeight(state.heightM);
            skyViewChanged({ pass, sunDirection, apparentSun: [x, y, z], sunAngularDiameter, observerHeightM });
        }
        // The pass above is kept current whatever shows, since the other figures take their sky from it; the canvas is
        // drawn only while it is on screen or about to be.
        if (!onScreen) return;

        placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
        const encoder = gpu.device.createCommandEncoder();
        pass.encode(encoder, gpu.context.getCurrentTexture());
        gpu.device.queue.submit([encoder.finish()]);
        const submitted = performance.now();
        showTiming(astronomyMs, submitted - skyStarted, submitted);
        showExposure();
    }

    // Whether the canvas is within a screen of the viewport, as onDemand gates a figure; a draw skipped while it was not
    // is made up for when it is again.
    let onScreen = true;
    new IntersectionObserver(
        ([entry]) => {
            const now = entry?.isIntersecting ?? true;
            if (now === onScreen) return;
            onScreen = now;
            if (onScreen) requestRender();
        },
        { rootMargin: "100% 0px" },
    ).observe(canvas);

    // The slider runs brighter to the right, so it holds minus the EV100: a lower EV lets in more light. Without one, the
    // figure is metered.
    const evOfSlider = () => -Number(maybe<HTMLInputElement>("exposure")?.value ?? -14);

    // Metered, the slider follows the light meter and waits; by hand, it sets the exposure.
    function showExposure() {
        const ev = maybe("ev");
        if (!ev) return;
        const slider = maybe<HTMLInputElement>("exposure");
        if (slider) slider.disabled = pressed("auto");
        if (!pressed("auto")) {
            ev.textContent = evOfSlider().toFixed(1);
            return;
        }
        pass?.meteredEV100().then((ev100) => {
            if (slider) {
                slider.value = String(-ev100);
                paintRange(slider);
            }
            ev.textContent = `EV\u202f${ev100.toFixed(1)} metered`;
        });
    }

    if (gpu) {
        if (full) {
            bindToneCurveChoice(root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-tone"]`));
            bindModelChoice(root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-model"]`));
            bindHdr(find('[data-hdr="note"]', root), find('[data-hdr="choice"]', root));
            onDisplay(requestRender);
        }
        onChange(requestRender);
        onTables(() => {
            maybe("refraction")?.setAttribute("aria-pressed", String(quality.refraction));
            requestRender();
        });
        new ResizeObserver(requestRender).observe(canvas);
        maybe("exposure")?.addEventListener("input", requestRender);
        for (const name of [
            "auto",
            "ramp",
            "lock",
            "grid",
            "refraction",
            "dither",
            ...INGREDIENTS,
            ...Object.keys(ORDERS),
        ]) {
            maybe(name)?.addEventListener("click", async () => {
                field(name).setAttribute("aria-pressed", String(!pressed(name)));
                // The environment and the lighting figure take their exposure from this meter: rebuilt with it.
                if (name === "ramp") skyViewFor = "";
                if (name === "refraction") {
                    quality.refraction = pressed("refraction");
                    await recompute();
                }
                requestRender();
            });
        }

        maybe("png")?.addEventListener("click", () => {
            // Drawn anew and copied in the same task, before the frame is handed to the screen and its texture let go.
            render();
            const copy = document.createElement("canvas");
            Object.assign(copy, { width: canvas.width, height: canvas.height });
            const context = copy.getContext("2d");
            if (!context) return;
            context.drawImage(canvas, 0, 0);
            const scale = canvas.width / canvas.clientWidth;
            // The compass directions are HTML over the canvas: written in, standing on the horizon as they do there.
            if (!compass.hidden) {
                const style = getComputedStyle(compass.firstElementChild ?? compass);
                Object.assign(context, {
                    font: `${style.fontWeight} ${parseFloat(style.fontSize) * scale}px ${style.fontFamily}`,
                    fillStyle: style.color,
                    textAlign: "center",
                    textBaseline: "bottom",
                });
                for (const label of compass.children as HTMLCollectionOf<HTMLElement>) {
                    if (!label.hidden)
                        context.fillText(
                            label.textContent ?? "",
                            parseFloat(label.style.left) * scale,
                            parseFloat(label.style.top) * scale,
                        );
                }
            }
            // Signed with the moment and place, bottom left, as a camera dates a photo.
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
