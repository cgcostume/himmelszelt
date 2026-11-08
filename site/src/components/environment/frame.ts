import { paintRange } from "../range";
import { changed, hdri, onHdri, onLoading, pending, remeter, setResolution, view } from "./hdri";

const DEG = Math.PI / 180;
/** The slider's reach either way, in EV, and further for an image metered near or past it. */
const EV_REACH = 8;
/** How near the metered value a dragged slider lands on it, in EV. */
const SNAP = 0.08;
/** How near zero, in pixels, the metered value's tick is too near zero's mark to leave that room. */
const NEAR_ZERO = 12;
const frames = [...document.querySelectorAll<HTMLElement>("[data-env-frame]")];

/** The HDRI's name, its authors and a link to its page; of the reader's own file, only the name. */
function credit() {
    if (hdri.authors.length === 0) return hdri.name ? [`${hdri.name}, your own`] : [];
    const link = Object.assign(document.createElement("a"), {
        href: `https://polyhaven.com/a/${hdri.id}`,
        textContent: hdri.name,
    });
    return [link, ` by ${hdri.authors.join(" and ")}, Poly Haven`];
}

let credited: string | null = null;

function sync() {
    const fresh = credited !== hdri.name;
    credited = hdri.name;
    for (const frame of frames) {
        if (fresh) frame.querySelector('[data-env="author"]')?.replaceChildren(...credit());
        frame.dataset.mode = view.projected ? "view" : "map";
        const hint = frame.querySelector('[data-env="hint"]');
        if (hint) {
            hint.textContent = frame.dataset.ownView
                ? frame.dataset.ownView
                : view.projected
                  ? "Drag to look around, scroll to zoom. Rendered with WebGPU."
                  : "Rendered with WebGPU.";
        }
        const press = (selector: string, on: boolean) =>
            frame.querySelector(selector)?.setAttribute("aria-pressed", String(on));
        press('[data-env="map"]', !view.projected);
        press('[data-env="view"]', view.projected);
        press('[data-env="clipped"]', view.clipped);
        for (const button of frame.querySelectorAll<HTMLElement>("[data-resolution]")) {
            const chosen = button.dataset.resolution === hdri.resolution;
            button.setAttribute("aria-pressed", String(chosen));
            button.toggleAttribute("data-busy", chosen && pending.id !== null);
        }
        const ev = frame.querySelector<HTMLInputElement>('[data-env="ev"]');
        const mark = frame.querySelector<HTMLElement>('[data-env="meteredMark"]');
        if (mark && ev) {
            const reach = Math.max(EV_REACH, Math.ceil(Math.abs(hdri.metered)) + 2);
            ev.min = String(-reach);
            ev.max = String(reach);
            if (document.activeElement !== ev) ev.value = String(hdri.ev100);
            paintRange(ev);
            const label = (name: string, text: string) => {
                const it = frame.querySelector(`[data-env="${name}"]`);
                if (it) it.textContent = text;
            };
            label("low", `\u2212${reach}`);
            label("high", `+${reach}`);
            const share = (hdri.metered + reach) / (2 * reach);
            mark.hidden = !hdri.name;
            mark.setAttribute("aria-pressed", String(hdri.following));
            mark.style.left = `${share * 100}%`;
            // Its name on the side away from zero, which it then only meets right next to it.
            mark.toggleAttribute("data-left", hdri.metered < 0);
            const near = Math.abs(share - 0.5) * (mark.parentElement?.clientWidth ?? 0) < NEAR_ZERO;
            frame.querySelector<HTMLElement>('[data-env="zero"]')?.toggleAttribute("hidden", !mark.hidden && near);
        }
        const reading = frame.querySelector('[data-env="reading"]');
        if (reading) reading.textContent = hdri.ev100.toFixed(1);
    }
}

for (const frame of frames) {
    const on = (name: string, act: () => void) =>
        frame.querySelector(`[data-env="${name}"]`)?.addEventListener("click", () => {
            act();
            changed();
        });
    on("map", () => {
        view.projected = false;
    });
    on("view", () => {
        view.projected = true;
    });
    on("clipped", () => {
        view.clipped = !view.clipped;
    });
    for (const button of frame.querySelectorAll<HTMLElement>("[data-resolution]")) {
        button.addEventListener("click", () => setResolution(button.dataset.resolution as typeof hdri.resolution));
    }
    const ev = frame.querySelector<HTMLInputElement>('[data-env="ev"]');
    // Only under a pointer: a key's or the wheel's small steps would never get away from it again.
    let dragging = false;
    ev?.addEventListener("pointerdown", () => {
        dragging = true;
    });
    window.addEventListener("pointerup", () => {
        dragging = false;
    });
    ev?.addEventListener("input", () => {
        const value = Number(ev.value);
        // A tenth at a time, but for the reading itself, which the thumb then sits on exactly.
        hdri.ev100 = dragging && Math.abs(value - hdri.metered) < SNAP ? hdri.metered : Math.round(value * 10) / 10;
        ev.value = String(hdri.ev100);
        hdri.following = hdri.ev100 === hdri.metered;
        changed();
    });
    const options = frame.querySelector('[data-env="options"]');
    const panel = frame.querySelector<HTMLElement>('[data-env="optionsPanel"]');
    if (options && panel) {
        const show = (open: boolean) => {
            options.setAttribute("aria-pressed", String(open));
            panel.hidden = !open;
        };
        // Open where the view leaves room beside them, folded away on a phone.
        show(frame.clientWidth >= 640);
        options.addEventListener("click", () => show(Boolean(panel.hidden)));
    }
    const fullscreen = frame.querySelector('[data-env="fullscreen"]');
    fullscreen?.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : frame.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () => {
        fullscreen?.setAttribute("aria-pressed", String(document.fullscreenElement === frame));
        // Full screen, what is drawn in the page's ink is on the dark too.
        frame.classList.toggle("as-seen", document.fullscreenElement === frame);
    });
    // Looking around, only in the view: the map has nowhere to go.
    frame.addEventListener("pointerdown", (event) => {
        if (frame.dataset.ownView || !view.projected || !(event.target instanceof HTMLCanvasElement)) return;
        const canvas = event.target;
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: view.yaw, pitch: view.pitch };
        const move = (e: PointerEvent) => {
            const perPixel = view.fov / canvas.clientHeight;
            view.yaw = start.yaw - (e.clientX - start.x) * perPixel;
            view.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, start.pitch + (e.clientY - start.y) * perPixel));
            changed();
            if (view.metering === "center" || view.metering === "spot") remeter();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    frame.addEventListener(
        "wheel",
        (event) => {
            if (frame.dataset.ownView || !view.projected || !(event.target instanceof HTMLCanvasElement)) return;
            event.preventDefault();
            view.fov = Math.max(20 * DEG, Math.min(120 * DEG, view.fov * Math.exp(event.deltaY * 0.001)));
            changed();
            if (view.metering === "center" || view.metering === "spot") remeter();
        },
        { passive: false },
    );
}
onHdri(sync);
onLoading(sync);
sync();
