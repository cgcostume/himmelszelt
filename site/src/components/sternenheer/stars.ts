import { find } from "../dom";
import {
    bindToneCurveChoice,
    configureCanvas,
    display,
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
import {
    createStarsRenderer,
    inverseViewProjection,
    type MapSize,
    skyAt,
    starsAbove,
    type ToneCurveName,
} from "./renderer";

const DEG = Math.PI / 180;

/**
 * The stars figure on `root`, a `figure[data-stars]`: dunstkreis' sky in cd/m², sternenheer's stars and Milky Way
 * over it, nachtgestirn's Moon over both, on the page's moment, place and tables. A wide view towards the south.
 */
export function starsFigure(root: HTMLElement) {
    const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
    const maybe = <T extends HTMLElement = HTMLElement>(name: string) =>
        root.querySelector<T>(`[data-field="${name}"]`);
    const canvas = field<HTMLCanvasElement>("canvas");
    const compass = field("compassLabels");
    const pressed = (name: string) => maybe(name)?.getAttribute("aria-pressed") === "true";
    const choice = (name: string) =>
        root.querySelector<HTMLInputElement>(`input[name="${root.id}-${name}"]:checked`)?.value ?? "";

    const camera = { yaw: Math.PI, pitch: 35 * DEG, fov: 120 * DEG };
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
    const renderer = gpu ? createStarsRenderer(gpu.device, requestRender) : null;

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

    // The slider runs brighter to the right, so it holds minus the EV100.
    const evOfSlider = () => -Number(maybe<HTMLInputElement>("exposure")?.value ?? 9);
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
    const magnitudeLimit = () => Number(maybe<HTMLInputElement>("magnitude")?.value ?? 8);

    // The twinkling runs on while its switch is pressed: the one animation of the figure, besides play.
    let twinkling: ReturnType<typeof setInterval> | null = null;
    const startedAt = performance.now();
    function twinkle(on: boolean) {
        if (twinkling !== null) clearInterval(twinkling);
        twinkling = on ? setInterval(requestRender, 1000 / 30) : null;
    }

    function render() {
        const table = tables();
        if (!gpu || !renderer || !table) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });

        const started = performance.now();
        const sky = skyAt(state.jd, state, table.luts.model);
        const astronomyMs = performance.now() - started;
        if (pressed("lock")) {
            const [x, y, z] = sky.moonDirection;
            camera.yaw = Math.atan2(x, y);
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, Math.asin(z)));
        }
        const basis = cameraBasis(camera, width / height);
        const drawn = renderer.draw(gpu.context.getCurrentTexture(), {
            sky,
            luts: table.luts,
            toneMap: choice("tone") as ToneCurveName,
            width,
            height,
            inverseViewProjection: inverseViewProjection(basis.f, basis.r, basis.u, basis.tx, basis.ty),
            projectionDistance: basis.d,
            pixelRatio: dpr,
            ev100: pressed("auto") ? null : evOfSlider(),
            stars: pressed("stars"),
            milkyWay: pressed("milkyway"),
            maps: (choice("maps") || "small") as MapSize,
            air: pressed("air"),
            twinkle: pressed("twinkle"),
            time: (performance.now() - startedAt) / 1000,
            glare: pressed("glare"),
            nightVision: pressed("eye"),
            magnitudeLimit: magnitudeLimit(),
            moon: pressed("moon"),
        });
        if (!drawn) return;
        const submitted = performance.now();
        showExposure(drawn.ev100);

        const note = maybe("status");
        const catalog = renderer.catalog();
        if (note && catalog) {
            const { above, siriusAltitude } = starsAbove(catalog, sky, drawn.air);
            const lst = ((sky.siderealTime % 360) + 360) % 360;
            const moonText =
                sky.moonDirection[2] > 0
                    ? `Moon ${(Math.asin(sky.moonDirection[2]) / DEG).toFixed(0)}° high, ${(sky.moonLit * 100).toFixed(0)}% lit`
                    : "Moon below the horizon";
            note.textContent =
                `${above.toLocaleString()} of ${catalog.count.toLocaleString()} stars above the horizon · ` +
                `Sirius ${siriusAltitude >= 0 ? `${siriusAltitude.toFixed(1)}° high` : "set"} · ` +
                `${moonText} · sidereal time ${(lst / 15).toFixed(2)} h`;
        }
        placeCompass(basis, canvas.clientWidth, canvas.clientHeight);
        showTiming(astronomyMs, drawn.passesMs, submitted);
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
        for (const name of ["exposure", "magnitude"]) {
            const input = maybe<HTMLInputElement>(name);
            input?.addEventListener("input", () => {
                paintRange(input);
                const value = maybe(`${name}Value`);
                if (value) value.textContent = input.value;
                requestRender();
            });
            if (input) paintRange(input);
        }
        for (const name of ["maps"])
            for (const input of root.querySelectorAll<HTMLInputElement>(`input[name="${root.id}-${name}"]`))
                input.addEventListener("change", requestRender);
        for (const name of ["auto", "lock", "stars", "milkyway", "air", "glare", "eye", "moon", "twinkle"]) {
            maybe(name)?.addEventListener("click", () => {
                field(name).setAttribute("aria-pressed", String(!pressed(name)));
                if (name === "twinkle") twinkle(pressed("twinkle"));
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
        if (pressed("twinkle")) twinkle(true);
        requestRender();
    }
}
