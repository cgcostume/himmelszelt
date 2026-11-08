import { find } from "../dom";
import {
    bindHdr,
    bindToneCurveChoice,
    configureCanvas,
    display,
    displayOutput,
    gpuDevice,
    onDisplay,
    onTables,
    SDR,
    gpu as shared,
    tables,
} from "../dunstkreis/atmosphere";
import { type Basis, cameraBasis, lookAround, project } from "../dunstkreis/skycamera";
import { onDemand } from "../frame";
import { paintRange } from "../range";
import { COMPASS } from "../sternzeit/figure";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";
import { raysOf } from "./rays";
import {
    createMoonRenderer,
    inverseViewProjection,
    type MapSize,
    moonAt,
    onUmbraTable,
    type ToneCurveName,
} from "./renderer";

const DEG = Math.PI / 180;
// The image's rms wander through one zenith's column of air, in arcseconds: a camera lens on a fair night, the tilt
// 0.42 lambda/D (D/r0)^(5/6) for D 5 cm and r0 10 cm at 500 nm.

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
        return { device: gpuDevice(), context, adapterName: shared.adapterName, format: SDR as GPUTextureFormat };
    }
    const gpu = setup();

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

    const requestRender = onDemand(render, root);
    const rays = raysOf(root, requestRender);
    const renderer = gpu ? createMoonRenderer(gpu.device, requestRender) : null;

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
        if (!gpu || !renderer || !table) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });

        const started = performance.now();
        const m = moonAt(state.jd, state, table.luts.model);
        const astronomyMs = performance.now() - started;
        const { direction, angularDiameter, horizontal, lit, waxing, libration, earthshine, shadow } = m;
        // Kept on the Moon, or on the Sun.
        const kept = pressed("lock")
            ? direction
            : maybe("sunLock") && pressed("sunLock")
              ? m.apparentSunDirection
              : null;
        if (kept) {
            camera.yaw = Math.atan2(kept[0], kept[1]);
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(kept[2])));
        }
        const basis = cameraBasis(camera, width / height);
        // HDR where the display and the canvas can, into the chosen headroom.
        const { format, headroom } = displayOutput();
        if (format !== gpu.format) {
            configureCanvas(gpu.context, format);
            gpu.format = format;
        }
        const drawn = renderer.draw(gpu.context.getCurrentTexture(), {
            moon: m,
            format,
            headroom,
            luts: table.luts,
            toneMap: choice("tone") as ToneCurveName,
            width,
            height,
            inverseViewProjection: inverseViewProjection(basis.f, basis.r, basis.u, basis.tx, basis.ty),
            projectionDistance: basis.d,
            pixelRatio: dpr,
            discPixels: ((angularDiameter * DEG) / camera.fov) * height,
            maps: (choice("maps") || "auto") as MapSize,
            air: true,
            ev100: pressed("auto") ? null : evOfSlider(),
            albedo: pressed("albedo"),
            relief: pressed("relief"),
            shadows: pressed("shadows"),
            earthshine: pressed("earthshine"),
            eclipse: pressed("eclipse"),
            law: "hapke",
            nightVision: pressed("eye"),
            shimmer: pressed("shimmer") ? { time: performance.now() / 1000, dispersion: 1 } : null,
            ...rays(),
        });
        if (!drawn) return;
        const submitted = performance.now();
        showExposure(drawn.ev100);
        const through = drawn.through;

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
        placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
        showTiming(astronomyMs, drawn.passesMs, submitted);
        // The shimmer moves on its own: the next frame asked for while it is on, drawn only while the figure shows.
        if (pressed("shimmer")) requestAnimationFrame(requestRender);
    }

    if (gpu) {
        bindToneCurveChoice(root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-tone"]`));
        bindHdr(find('[data-hdr="note"]', root), find('[data-hdr="choice"]', root));
        onDisplay(() => {
            for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-tone"]`))
                input.checked = input.value === display.toneCurve;
            requestRender();
        });
        onChange(requestRender);
        onTables(requestRender);
        onUmbraTable(requestRender);
        new ResizeObserver(requestRender).observe(canvas);
        maybe("exposure")?.addEventListener("input", requestRender);
        for (const name of ["maps"])
            for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-${name}"]`))
                input.addEventListener("change", requestRender);
        for (const name of [
            "shimmer",
            "auto",
            "lock",
            "sunLock",
            "albedo",
            "relief",
            "shadows",
            "earthshine",
            "eclipse",
            "eye",
        ]) {
            maybe(name)?.addEventListener("click", () => {
                const on = !pressed(name);
                field(name).setAttribute("aria-pressed", String(on));
                // One lock at a time.
                const other = name === "lock" ? "sunLock" : name === "sunLock" ? "lock" : null;
                if (on && other) maybe(other)?.setAttribute("aria-pressed", "false");
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
            onDrag: () => {
                field("lock").setAttribute("aria-pressed", "false");
                maybe("sunLock")?.setAttribute("aria-pressed", "false");
            },
        });
        requestRender();
    }
}
