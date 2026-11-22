import { state, update } from "../sternzeit/state";
import type { SkyCamera } from "./skycamera";
import { frameHeight } from "./skyframe";

/**
 * Flying through a figure's sky. The figure's flight button takes off: the mouse is captured and turns the view the way
 * it moves, as in a first-person game, a mark at the view's center showing where it heads. F does the same with the
 * pointer over the view, and F again lands. Escape lands too, but the browser also leaves full screen on it. In flight
 * W and S move along the view and back, A and D to the sides, E up and Q down, at a speed of the height over the ground
 * per second: slow among the grass, fast in orbit, and a descent never hits the ground. Shift, held, speeds it up
 * steadily to a few times that, and let go, lets it fall back; the view widens a little with the speed. The page's place
 * moves along with the flight. Only one figure flies at a time, and frames come only while something moves.
 */

// Meters per second per meter of height, and the height the speed never falls below.
const SPEED_PER_HEIGHT = 1;
const LEAST_HEIGHT_M = 10;
// How many times faster Shift makes it at most, the seconds that takes to build up or die down by 1/e, and how much
// wider the field of view is at that most.
const BOOST = 6;
const BOOST_SECONDS = 0.7;
const BOOST_VIEW = 0.08;
const STEEPEST = (89 * Math.PI) / 180;
// Earth's mean radius, and the step in degrees the page's place moves by in flight: about 100 m, so a slow flight does
// not redraw every figure of the page each frame.
const EARTH_KM = 6371;
const PLACE_STEP = 0.001;
const KEYS: Record<string, readonly [forward: number, right: number, up: number]> = {
    KeyW: [1, 0, 0],
    KeyS: [-1, 0, 0],
    KeyD: [0, 1, 0],
    KeyA: [0, -1, 0],
    KeyE: [0, 0, 1],
    KeyQ: [0, 0, -1],
    ArrowUp: [1, 0, 0],
    ArrowDown: [-1, 0, 0],
    ArrowRight: [0, 1, 0],
    ArrowLeft: [0, -1, 0],
};

export const flightSpeed = (heightM: number) => SPEED_PER_HEIGHT * Math.max(heightM, LEAST_HEIGHT_M);
// In km/h, to three digits: "36 km/h", "8,810,000 km/h".
const speedText = (mps: number) => `${Number((mps * 3.6).toPrecision(3)).toLocaleString("en-US")} km/h`;

let landCurrent: (() => void) | null = null;

/**
 * Wires flight to `canvas` and to `button`, which takes off and lands: `height` gives the observer's height in m,
 * `move` takes a step east and north in km and the new height in m, `look` is told when the camera has turned or
 * its field of view changed. While in flight, `hint`, the frame's line on how to navigate, says how to fly.
 */
export function flight(
    canvas: HTMLCanvasElement,
    camera: SkyCamera,
    options: {
        button: Element | null;
        height: () => number;
        move: (eastKm: number, northKm: number, heightM: number) => void;
        look: () => void;
        hint?: Element | null;
    },
) {
    const { button, height, move, look, hint } = options;
    const resting = hint?.textContent ?? "";
    const held = new Set<string>();
    let flying = false;
    let captured = false;
    let shift = false;
    // How many times the height's speed it flies at, 1 to BOOST, and how much of the camera's field of view is its.
    let boost = 1;
    let widened = 1;
    let frame = 0;
    let last = 0;

    const showHint = () => {
        if (!hint) return;
        const speed = speedText(flightSpeed(height()) * boost);
        hint.textContent = flying ? `Flying at ${speed}: W A S D, E up, Q down, Shift faster. F lands.` : resting;
    };
    // The view a little wider the faster it goes, over whatever the wheel has set.
    function widen() {
        const next = 1 + (BOOST_VIEW * (boost - 1)) / (BOOST - 1);
        camera.fov = (camera.fov / widened) * next;
        widened = next;
    }
    const run = () => {
        if (frame) return;
        last = performance.now();
        frame = requestAnimationFrame(step);
    };
    function step(now: number) {
        frame = 0;
        if (!flying) return;
        const dt = Math.min((now - last) / 1000, 0.1);
        last = now;
        let [forward, right, up] = [0, 0, 0];
        for (const code of held) {
            const [f, r, u] = KEYS[code] ?? [0, 0, 0];
            [forward, right, up] = [forward + f, right + r, up + u];
        }
        const moving = forward !== 0 || right !== 0 || up !== 0;
        // Shift builds the speed up while it flies, and it dies down again once Shift is let go or the flight rests.
        const towards = shift && moving ? BOOST : 1;
        boost += (towards - boost) * (1 - Math.exp(-dt / BOOST_SECONDS));
        if (Math.abs(towards - boost) < 0.005) boost = towards;
        widen();
        if (moving) {
            const h = height();
            const reach = flightSpeed(h) * boost * dt;
            const { yaw, pitch } = camera;
            // Along the view, climbing with its pitch, and across it, level.
            const east = forward * Math.cos(pitch) * Math.sin(yaw) + right * Math.cos(yaw);
            const north = forward * Math.cos(pitch) * Math.cos(yaw) - right * Math.sin(yaw);
            const climb = forward * Math.sin(pitch) + up;
            move((east * reach) / 1000, (north * reach) / 1000, h + climb * reach);
        } else {
            look();
        }
        showHint();
        if (moving || boost !== 1) frame = requestAnimationFrame(step);
    }
    function show() {
        canvas.toggleAttribute("data-flying", flying);
        canvas.parentElement?.toggleAttribute("data-flying", flying);
        button?.setAttribute("aria-pressed", String(flying));
        showHint();
    }
    function land() {
        if (!flying) return;
        flying = false;
        shift = false;
        held.clear();
        boost = 1;
        widen();
        if (document.pointerLockElement === canvas) document.exitPointerLock();
        if (landCurrent === land) landCurrent = null;
        show();
        look();
    }
    function takeOff() {
        landCurrent?.();
        landCurrent = land;
        flying = true;
        // Refused where the browser has no capture to give: flight goes on, turned by dragging.
        Promise.resolve(canvas.requestPointerLock()).catch(() => {});
        show();
        look();
    }
    button?.addEventListener("click", () => (flying ? land() : takeOff()));

    // Captured, the mouse turns the view the way it moves, a pixel by a pixel's worth of the field of view.
    canvas.addEventListener("mousemove", (event) => {
        if (!flying || document.pointerLockElement !== canvas) return;
        const perPixel = Math.min(camera.fov, Math.PI) / canvas.clientHeight;
        camera.yaw += event.movementX * perPixel;
        camera.pitch = Math.max(-STEEPEST, Math.min(STEEPEST, camera.pitch - event.movementY * perPixel));
        look();
    });
    // Escape lets the mouse go before any key event tells of it: the flight ends with the capture.
    document.addEventListener("pointerlockchange", () => {
        if (flying && captured && document.pointerLockElement !== canvas) land();
        captured = document.pointerLockElement === canvas;
    });
    let over = false;
    canvas.addEventListener("pointerenter", () => (over = true));
    canvas.addEventListener("pointerleave", () => (over = false));
    window.addEventListener("keydown", (event) => {
        const typing =
            event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable]");
        const plain = !(event.ctrlKey || event.metaKey || event.altKey);
        if (event.code === "KeyF" && plain && !event.repeat && !typing && (flying || over)) {
            event.preventDefault();
            return flying ? land() : takeOff();
        }
        if (!flying) return;
        if (event.key === "Escape") return land();
        if (event.key === "Shift") {
            shift = true;
            return run();
        }
        if (!(event.code in KEYS) || event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        held.add(event.code);
        run();
    });
    window.addEventListener("keyup", (event) => {
        if (event.key === "Shift") shift = false;
        held.delete(event.code);
    });
    window.addEventListener("blur", () => {
        shift = false;
        held.clear();
    });
}

/**
 * Flight for the figure in `root`, by its frame's fly button, and what the figure draws from: the height it is seen
 * from (see `frameHeight`), how far it has flown from where it started, in km east and north, and whether it is in
 * flight. The page's latitude and longitude follow the flight, a step at a time and exactly on landing. `render` asks
 * for a frame.
 */
export function flightIn(root: HTMLElement, canvas: HTMLCanvasElement, camera: SkyCamera, render: () => void) {
    const seenFrom = frameHeight(root, render);
    const flown = { east: 0, north: 0 };
    const flying = () => canvas.hasAttribute("data-flying");
    // The place flown to, exactly, and what of it the page was last given: changed elsewhere, the flight goes on there.
    const place = { latitude: state.latitude, longitude: state.longitude };
    const given = { ...place };
    function fly(eastKm: number, northKm: number) {
        if (state.latitude !== given.latitude || state.longitude !== given.longitude)
            Object.assign(place, { latitude: state.latitude, longitude: state.longitude });
        const degrees = 180 / Math.PI / EARTH_KM;
        const across = Math.max(Math.cos((place.latitude * Math.PI) / 180), 0.01);
        place.latitude = Math.min(Math.max(place.latitude + northKm * degrees, -89.99), 89.99);
        place.longitude += (eastKm * degrees) / across;
        Object.assign(given, { latitude: state.latitude, longitude: state.longitude });
    }
    function give(step: number) {
        if (state.latitude !== given.latitude || state.longitude !== given.longitude) return;
        const across = Math.cos((place.latitude * Math.PI) / 180);
        const moved = Math.hypot(place.latitude - given.latitude, (place.longitude - given.longitude) * across);
        if (moved <= step) return;
        update(place);
        Object.assign(place, { latitude: state.latitude, longitude: state.longitude });
        Object.assign(given, place);
    }
    // A view kept on the Sun or the Moon is let go, as a drag lets it go.
    const look = () => {
        if (flying())
            for (const lock of root.querySelectorAll('[data-field="lock"], [data-field="sunLock"]'))
                lock.setAttribute("aria-pressed", "false");
        else give(0);
        render();
    };
    flight(canvas, camera, {
        button: root.querySelector('[data-field="fly"]'),
        height: seenFrom.get,
        move(eastKm, northKm, heightM) {
            flown.east += eastKm;
            flown.north += northKm;
            fly(eastKm, northKm);
            give(PLACE_STEP);
            seenFrom.set(heightM);
            look();
        },
        look,
        hint: root.querySelector(".fig-hint"),
    });
    return { flown, height: seenFrom.get, flying };
}
