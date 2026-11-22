import { find } from "../dom";
import { groundSurface, onGroundSurface } from "./ground-state";
import { createGroundedView } from "./grounded-view";

const DEG = Math.PI / 180;
const root = find("#grounded");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const canvas = field<HTMLCanvasElement>("canvas");
const camera = { yaw: 150 * DEG, pitch: 12 * DEG, distance: 6, fov: 50 * DEG };

function setPitch(pitch: number) {
    camera.pitch = Math.max(Math.asin(Math.max(-1, -0.55 / camera.distance)), Math.min(89 * DEG, pitch));
}

const pressed = (name: string) => field(name).getAttribute("aria-pressed") === "true";

// The surface the ground geometry figure sets with its sliders, or the defaults without it.
const request = createGroundedView(canvas, () => {
    const { height, lift, reach, radius, meets } = groundSurface();
    if (pressed("flat")) camera.distance = Math.min(camera.distance, 0.8 * radius);
    return { camera, height, lift, reach, radius, flat: pressed("flat"), even: pressed("even"), meets };
});

if (request) {
    onGroundSurface(request);
    for (const name of ["flat", "even"]) {
        field(name).addEventListener("click", () => {
            field(name).setAttribute("aria-pressed", String(!pressed(name)));
            request();
        });
    }
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        const move = (e: PointerEvent) => {
            const perPixel = camera.fov / canvas.clientHeight;
            camera.yaw = start.yaw + (e.clientX - start.x) * perPixel;
            setPitch(start.pitch + (e.clientY - start.y) * perPixel);
            request();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.distance = Math.max(1.5, Math.min(100, camera.distance * Math.exp(event.deltaY * 0.002)));
            setPitch(camera.pitch);
            request();
        },
        { passive: false },
    );
}
