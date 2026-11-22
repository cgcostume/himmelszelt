import { find } from "../dom";
import { paintRange } from "../range";
import { offsetSliders } from "../sternzeit/offset";
import { onChange, state, update } from "../sternzeit/state";

// The height slider's scale: log10 of the height in meters, from 1 m to the space station's 408 km, in thousandths.
const LOG_TOP = Math.log10(408_000);
const heightOf = (value: number) => Math.round(10 ** ((value / 1000) * LOG_TOP));
const sliderOf = (heightM: number) => (Math.log10(Math.max(1, heightM)) / LOG_TOP) * 1000;
const meters = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 100_000 ? 1 : 0)} km`);

/**
 * The height the figure in `root` is seen from, in m. In a frame with a height of its own (see SkyFrame.astro) that is
 * the page's until the frame's scale or a flight sets another, which no other figure follows, and the page's again once
 * that changes; `changed` hears of it. Any other frame's height is the page's, and setting it sets the page's.
 */
export function frameHeight(root: HTMLElement, changed?: () => void) {
    const frame = root.matches("[data-sky-frame]") ? root : root.querySelector<HTMLElement>("[data-sky-frame]");
    const own = frame?.hasAttribute("data-own-height") ? frame : null;
    if (changed) own?.addEventListener("skyheight", changed);
    return {
        get: () => Number(own?.dataset.heightM) || state.heightM,
        set(heightM: number) {
            const clamped = Math.min(Math.max(heightM, 1), 408_000);
            if (!own) return update({ heightM: clamped });
            own.dataset.heightM = String(clamped);
            own.dispatchEvent(new Event("skyheight"));
        },
    };
}

// Play steps the moment on by 12 seconds, thirty times a second: an hour in 10 seconds. It is the page's animation, so
// the controls' animate button and every play button show it, and anything else that sets the moment stops it.
const STEP = 12 / 86_400;
let playing: ReturnType<typeof setInterval> | null = null;
function play(on: boolean) {
    if (playing !== null) clearInterval(playing);
    playing = on ? setInterval(() => update({ jd: Number((state.jd + STEP).toFixed(7)) }), 1000 / 30) : null;
    update({ animate: on, ...(on ? { live: false } : {}) });
}
onChange(() => {
    if (!state.animate && playing !== null) {
        clearInterval(playing);
        playing = null;
    }
});

/**
 * Wires every frame on the page once (see SkyFrame.astro): the height, play, the options' fold and full screen. The Sun
 * lock, the grid and the download are the figure's own.
 */
export function skyFrames() {
    offsetSliders();
    for (const frame of document.querySelectorAll<HTMLElement>("[data-sky-frame]")) {
        if (frame.hasAttribute("data-wired")) continue;
        frame.setAttribute("data-wired", "");
        const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, frame);

        const height = field<HTMLInputElement>("height");
        const offset = field<HTMLInputElement>("offset");
        const time = offset.closest<HTMLElement>("[data-offset]");
        const heightValue = field("heightValue");
        const seenFrom = frameHeight(frame);
        height.addEventListener("input", () => seenFrom.set(heightOf(Number(height.value))));
        let pageHeight = state.heightM;
        // A figure that plays by a clock of its own has no play of the page's.
        const playButton = frame.querySelector<HTMLElement>('[data-field="play"]');
        playButton?.addEventListener("click", () => play(!state.animate));
        const sync = () => {
            // The page's height has changed: the frame's own gives way to it.
            if (state.heightM !== pageHeight) delete frame.dataset.heightM;
            pageHeight = state.heightM;
            if (document.activeElement !== height) height.value = String(sliderOf(seenFrom.get()));
            paintRange(height);
            heightValue.textContent = meters(Math.round(seenFrom.get()));
            heightValue.style.setProperty("--at", String(Number(height.value) / 1000));
            // How far along the time slider is, for its value riding the rail in full screen.
            const span = Number(offset.max) - Number(offset.min);
            time?.style.setProperty("--at", String((Number(offset.value) - Number(offset.min)) / span));
            playButton?.setAttribute("aria-pressed", String(state.animate));
            playButton?.setAttribute("aria-label", state.animate ? "Pause" : "Play");
        };
        onChange(sync);
        frame.addEventListener("skyheight", sync);
        sync();

        // The marks step through their states, off, the compass, the compass with the grid, before the figure hears the click.
        const marks = field("marks");
        const titles: string[] = JSON.parse(marks.dataset.titles ?? "[]");
        marks.addEventListener(
            "click",
            () => {
                const level = (Number(marks.dataset.level) + 1) % Number(marks.dataset.levels);
                marks.dataset.level = String(level);
                marks.setAttribute("aria-pressed", String(level > 0));
                marks.title = titles[level] ?? "";
            },
            { capture: true },
        );

        const options = frame.querySelector('[data-field="options"]');
        const panel = frame.querySelector<HTMLElement>('[data-field="optionsPanel"]');
        if (options && panel) {
            const show = (open: boolean) => {
                options.setAttribute("aria-pressed", String(open));
                panel.hidden = !open;
            };
            // Open where the view leaves room beside them, folded away on a phone.
            show(frame.clientWidth >= 640);
            options.addEventListener("click", () => show(Boolean(panel.hidden)));
        }

        const fullscreen = field("fullscreen");
        fullscreen.addEventListener("click", () =>
            document.fullscreenElement ? document.exitFullscreen() : frame.requestFullscreen(),
        );
        // Full screen, the time slider is on the dark too.
        document.addEventListener("fullscreenchange", () => {
            const on = document.fullscreenElement === frame;
            fullscreen.setAttribute("aria-pressed", String(on));
            frame.classList.toggle("as-seen", on);
        });
    }
}
