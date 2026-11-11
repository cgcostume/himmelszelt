import { moonEV100 } from "@himmelszelt/nachtgestirn";
import { find } from "../dom";
import { display, onDisplay, onTables, tables } from "../dunstkreis/atmosphere";
import { save } from "../dunstkreis/download";
import { onDemand } from "../frame";
import { momentAndPlace, momentStamp, onChange, state } from "../sternzeit/state";
import { noGpu, orbited } from "./laws";
import { moonAt, type ToneCurveName } from "./renderer";
import { mapResolutions, RESOLUTION_NAMES } from "./resolutions";
import { createTiles } from "./tiles";

const DEG = Math.PI / 180;
// How far the view zooms in, from the whole disc with a margin round it.
// How far the view zooms out; in, no further than a texel of the map to a pixel at the disc's middle.
const ZOOM_MIN = 0.2;
// The zoom the figure opens at and a double click returns to: the disc taller than the view, its limb in close.
const ZOOM_START = 1.6;
// The view's width over its height, a wide screen's, outside full screen.
const ASPECT = 16 / 10;
// How long the lock takes to turn the Moon back to the face Earth sees, in milliseconds.
const TURN_MS = 450;

/**
 * The globe figure on `root`: the Moon at the chosen moment, large and square, from Earth's center at first; dragging
 * carries the viewer around it, the Sun and Earth staying where they are, so the far side and the phases come round,
 * and earthshine stays on the half turned to Earth. Scrolling zooms in where the cursor is.
 */
export function globeFigure(root: HTMLElement) {
    const canvas = find<HTMLCanvasElement>("canvas", root);
    const note = find("[data-field=note]", root);
    const requestRender = onDemand(render, root);
    // The zoom, and where the middle of the view is off the disc's center, right and up, in disc radii.
    const view = { yaw: 0, pitch: 0, zoom: ZOOM_START, x: 0, y: 0 };
    const panel = find(".tiles-panel", root);
    const fullscreen = find("[data-field=fullscreen]", root);
    // What goes full screen: the panel and the lunation slider under it, which then lies over the panel's foot.
    const stage = find("[data-field=stage]", root);
    const lunation = find<HTMLInputElement>("[data-field=lunation]", root);
    const slider = find("[data-lunation]", root);
    const placeValue = () =>
        slider.style.setProperty(
            "--at",
            String(
                (Number(lunation.value) - Number(lunation.min)) / (Number(lunation.max) - Number(lunation.min) || 1),
            ),
        );
    // The view's width and height in disc radii: the disc fits the shorter side with a margin.
    const across = () => {
        const [w, h] = [panel.clientWidth || 1, panel.clientHeight || 1];
        const x = ((1.15 * 2) / view.zoom) * Math.max(1, w / h);
        return [x, (x * h) / w] as const;
    };
    const moved = requestRender;
    // The most zoom: a texel of the 8K maps to four pixels at the disc's middle, whichever maps are loaded, magnified
    // smoothly by the B-spline; the map shows π times its width across.
    const zoomMax = () => {
        const texels = 8192 / Math.PI;
        const px =
            Math.min(panel.clientWidth, panel.clientHeight || panel.clientWidth) *
            Math.min(window.devicePixelRatio || 1, 2);
        return Math.max(1, (4 * texels * 1.15) / Math.max(px, 1));
    };
    const tiles = createTiles(canvas, requestRender);
    if (!tiles) noGpu(canvas);
    const resolution = mapResolutions(root, "4k", requestRender);
    const relief = find("[data-field=relief]", root);
    const shadows = find("[data-field=shadows]", root);
    const displace = find("[data-field=displace]", root);
    const pressed = (button: HTMLElement) => button.getAttribute("aria-pressed") === "true";
    for (const button of [relief, shadows, displace]) {
        button.addEventListener("click", () => {
            button.setAttribute("aria-pressed", String(!pressed(button)));
            // Without the relief there is nothing to cast shadows or to displace.
            shadows.toggleAttribute("disabled", !pressed(relief));
            displace.toggleAttribute("disabled", !pressed(relief));
            requestRender();
        });
    }
    // Where the view's middle may lie off the disc's center, in disc radii: so far that some of the disc stays in view.
    const keepInView = () => {
        const [w, h] = across();
        view.x = Math.max(-(w * 0.35 + 1), Math.min(w * 0.35 + 1, view.x));
        view.y = Math.max(-(h * 0.35 + 1), Math.min(h * 0.35 + 1, view.y));
    };

    function render() {
        const table = tables();
        if (!table) return;
        const real = moonAt(state.jd, state, table.luts.model);
        view.zoom = Math.min(view.zoom, zoomMax());
        const m = view.yaw === 0 && view.pitch === 0 ? real : orbited(real, view.yaw, view.pitch);
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const full = document.fullscreenElement === stage;
        const width = Math.round((full ? panel.clientWidth : root.clientWidth || 600) * ratio);
        const height = full ? Math.round(panel.clientHeight * ratio) : Math.round(width / ASPECT);
        const radius = m.geocentricDiameter / 2;
        tiles?.draw({ count: 1, width, height, degreesAcross: across()[0] * radius }, () => ({
            offset: [view.x * radius, view.y * radius] as const,
            moon: m,
            luts: table.luts,
            toneMap: display.toneCurve as ToneCurveName,
            maps: resolution(),
            // Set by the phase as the eye sees it lit, not metered from the image: no meter to lag a frame behind.
            ev100: moonEV100(m.phaseAngle, m.lit),
            albedo: true,
            relief: pressed(relief),
            shadows: pressed(relief) && pressed(shadows),
            // Displaced at every size, or never: the pass' own threshold left aside, so the two can be compared.
            displacementFrom: pressed(displace) ? 0 : Number.POSITIVE_INFINITY,
            earthshine: true,
            eclipse: false,
            law: "hapke2012",
            nightVision: false,
        }));
        const onFar = root.querySelector("[data-field=far]")?.getAttribute("aria-pressed") === "true";
        const where = onFar
            ? "from the far side, half round from Earth"
            : view.yaw === 0 && view.pitch === 0
              ? "from Earth"
              : `${(Math.abs(view.yaw) / DEG).toFixed(0)}° ${view.yaw > 0 ? "east" : "west"} and ${(Math.abs(view.pitch) / DEG).toFixed(0)}° ${view.pitch > 0 ? "over" : "under"} Earth's line of sight`;
        note.textContent = `seen ${where}, ${view.zoom.toFixed(1)}× zoom: phase angle ${m.phaseAngle.toFixed(1)}°, ${(m.lit * 100).toFixed(0)}% lit, the ${RESOLUTION_NAMES[resolution()]}, exposed for the lit part`;
    }

    // The lock, pressed while the Moon shows the face Earth sees, and the far side, half round from it: a press turns
    // the Moon there, the shorter way round, a turn by hand lets go of both.
    const lock = find("[data-field=lock]", root);
    const far = find("[data-field=far]", root);
    let turning = 0;
    const locked = (at: HTMLElement | null) => {
        for (const button of [lock, far]) button.setAttribute("aria-pressed", String(button === at));
    };
    const turnTo = (button: HTMLElement, yaw: number) => {
        locked(button);
        cancelAnimationFrame(turning);
        const from = { yaw: view.yaw, pitch: view.pitch };
        // The difference the shorter way round.
        const turn = yaw - from.yaw - Math.round((yaw - from.yaw) / (2 * Math.PI)) * 2 * Math.PI;
        const start = performance.now();
        const step = (now: number) => {
            const t = Math.min((now - start) / TURN_MS, 1);
            const ease = 1 - (1 - t) ** 3;
            view.yaw = from.yaw + turn * ease;
            view.pitch = from.pitch * (1 - ease);
            requestRender();
            if (t < 1) turning = requestAnimationFrame(step);
        };
        turning = requestAnimationFrame(step);
    };
    lock.addEventListener("click", () => turnTo(lock, 0));
    far.addEventListener("click", () => turnTo(far, Math.PI));

    // Dragging turns the Moon; with shift held, it moves the view, the ground under the cursor following it.
    let dragging: { x: number; y: number } | null = null;
    canvas.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        cancelAnimationFrame(turning);
        dragging = { x: event.clientX, y: event.clientY };
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
        if (!dragging) return;
        // A radian per disc radius on screen: the ground under the cursor follows it, whatever the zoom and the screen.
        const perPx = 1 / ((panel.clientWidth || 1) / across()[0]);
        if (event.shiftKey) {
            view.x -= (event.clientX - dragging.x) * perPx;
            view.y += (event.clientY - dragging.y) * perPx;
            keepInView();
        } else {
            if (event.clientX !== dragging.x || event.clientY !== dragging.y) locked(null);
            view.yaw += (event.clientX - dragging.x) * perPx;
            view.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, view.pitch + (event.clientY - dragging.y) * perPx));
        }
        dragging = { x: event.clientX, y: event.clientY };
        moved();
    });
    const release = () => {
        dragging = null;
        canvas.classList.remove("dragging");
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            // The point under the cursor stays under it: the middle moves towards it by what the view shrinks.
            const box = canvas.getBoundingClientRect();
            const cx = (event.clientX - box.left) / box.width - 0.5;
            const cy = 0.5 - (event.clientY - box.top) / box.height;
            const before = across();
            view.zoom = Math.max(ZOOM_MIN, Math.min(zoomMax(), view.zoom * Math.exp(-event.deltaY * 0.0015)));
            const after = across();
            view.x += cx * (before[0] - after[0]);
            view.y += cy * (before[1] - after[1]);
            keepInView();
            moved();
        },
        { passive: false },
    );
    canvas.addEventListener("dblclick", () => {
        cancelAnimationFrame(turning);
        Object.assign(view, { yaw: 0, pitch: 0, zoom: ZOOM_START, x: 0, y: 0 });
        locked(lock);
        requestRender();
    });
    // The Moon as shown, with the moment and the place written into its corner.
    find("[data-field=download]", root).addEventListener("click", () => {
        render();
        const copy = Object.assign(document.createElement("canvas"), { width: canvas.width, height: canvas.height });
        const context = copy.getContext("2d");
        if (!context) return;
        context.drawImage(canvas, 0, 0);
        const scale = canvas.width / (canvas.clientWidth || 1);
        Object.assign(context, {
            font: `${12 * scale}px ${getComputedStyle(root).fontFamily}`,
            fillStyle: "rgb(255 255 255 / 0.85)",
            textBaseline: "bottom",
        });
        context.fillText(`${momentAndPlace()}, ${note.textContent ?? ""}`, 8 * scale, copy.height - 6 * scale);
        copy.toBlob((blob) => save(blob, `himmelszelt-${root.id}-${momentStamp()}.png`), "image/png");
    });
    fullscreen.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () => {
        fullscreen.setAttribute("aria-pressed", String(document.fullscreenElement === stage));
        requestRender();
    });
    onChange(() => {
        placeValue();
        moved();
    });
    lunation.addEventListener("input", placeValue);
    placeValue();
    onTables(requestRender);
    onDisplay(requestRender);
    new ResizeObserver(requestRender).observe(root);
    requestRender();
}
