import { find } from "../dom";
import { paintRange } from "../range";
import { offsetSliders } from "../sternzeit/offset";
import { onChange, state, update } from "../sternzeit/state";

// The height slider's scale: log10 of the height in meters, from 1 m to the space station's 408 km, in thousandths.
const LOG_TOP = Math.log10(408_000);
const heightOf = (value: number) => Math.round(10 ** ((value / 1000) * LOG_TOP));
const sliderOf = (heightM: number) => (Math.log10(Math.max(1, heightM)) / LOG_TOP) * 1000;
const meters = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 100_000 ? 1 : 0)} km`);

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

// Play's two halves of the triangle and pause's two bars, four corners each in the same order, so one folds into the
// other corner by corner, as YouTube's button does.
const PLAY = [
    [4, 2.5, 9, 5.556, 9, 10.444, 4, 13.5],
    [8.5, 5.25, 13, 8, 13, 8, 8.5, 10.75],
];
const PAUSE = [
    [4, 3, 7, 3, 7, 13, 4, 13],
    [9, 3, 12, 3, 12, 13, 9, 13],
];
const MORPH_MS = 200;

/** Folds `button`'s icon towards pause while `playing`, towards play otherwise, from wherever it is. */
function morph(button: Element) {
    const paths = [...button.querySelectorAll("path")];
    let t = 0;
    let target = 0;
    let frame = 0;
    let last = 0;
    const draw = () => {
        const ease = t * t * (3 - 2 * t);
        paths.forEach((path, i) => {
            const points = (PLAY[i] ?? []).map((p, k) => p + ((PAUSE[i]?.[k] ?? p) - p) * ease);
            const corners = [0, 2, 4, 6].map((k) => `${points[k]?.toFixed(3)} ${points[k + 1]?.toFixed(3)}`);
            path.setAttribute("d", `M${corners.join("L")}Z`);
            // Paused, the bars snap to whole pixels, so both come out equally wide.
            path.setAttribute("shape-rendering", t === 1 ? "crispEdges" : "auto");
        });
    };
    const step = (now: number) => {
        const dt = (now - last) / MORPH_MS;
        last = now;
        t = target > t ? Math.min(target, t + dt) : Math.max(target, t - dt);
        draw();
        frame = t === target ? 0 : requestAnimationFrame(step);
    };
    return (playing: boolean) => {
        target = playing ? 1 : 0;
        if (frame || t === target) return;
        last = performance.now();
        frame = requestAnimationFrame(step);
    };
}

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
        height.addEventListener("input", () => update({ heightM: heightOf(Number(height.value)) }, height));
        const playButton = field("play");
        playButton.addEventListener("click", () => play(!state.animate));
        const fold = morph(playButton);
        const sync = () => {
            if (document.activeElement !== height) height.value = String(sliderOf(state.heightM));
            paintRange(height);
            heightValue.textContent = meters(Math.round(state.heightM));
            heightValue.style.setProperty("--at", String(Number(height.value) / 1000));
            // How far along the time slider is, for its value riding the rail in full screen.
            const span = Number(offset.max) - Number(offset.min);
            time?.style.setProperty("--at", String((Number(offset.value) - Number(offset.min)) / span));
            playButton.setAttribute("aria-pressed", String(state.animate));
            playButton.setAttribute("aria-label", state.animate ? "Pause" : "Play");
            fold(state.animate);
        };
        onChange(sync);
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
