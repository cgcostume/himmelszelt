import { find } from "../dom";
import { createGroundedView } from "./grounded-view";

const DEG = Math.PI / 180;
const root = find("#grounded");
const field = <T extends HTMLElement = HTMLElement>(name: string) => find<T>(`[data-field="${name}"]`, root);
const canvas = field<HTMLCanvasElement>("canvas");
const camera = { yaw: 150 * DEG, pitch: 12 * DEG, distance: 6, fov: 50 * DEG };
// As good as without end, for the ground's reach and the dome's radius.
const FAR = 1e9;

function setPitch(pitch: number) {
    camera.pitch = Math.max(Math.asin(Math.max(-1, -0.55 / camera.distance)), Math.min(89 * DEG, pitch));
}

const slider = (name: string) => Number(field<HTMLInputElement>(name).value);
// The dome's radius from 5 to 500 and the ground's reach from 3 to 300 on logarithmic sliders, the last step of each
// without end. The dome holds the scene whatever the height, and the ground reaches as far as the library lets it,
// about half the dome's radius.
const far = (name: string, from: number) => (slider(name) >= 100 ? FAR : from * 100 ** (slider(name) / 99));
const domeRadius = () => Math.max(far("radius", 5), 2.5 * slider("height"));
const groundReach = () => Math.min(far("reach", 3), Math.sqrt(domeRadius() ** 2 / 4 - slider("height") ** 2));
const reading = (length: number) => (length >= FAR ? "∞" : length.toFixed(length < 10 ? 1 : 0));
const pressed = (name: string) => field(name).getAttribute("aria-pressed") === "true";

const request = createGroundedView(canvas, () => {
    if (pressed("flat")) camera.distance = Math.min(camera.distance, 0.8 * domeRadius());
    field("heightReading").textContent = slider("height").toFixed(1);
    field("liftReading").textContent = `${slider("lift").toFixed(1)}°`;
    field("reachReading").textContent = reading(groundReach());
    field("radiusReading").textContent = reading(domeRadius());
    return {
        camera,
        height: slider("height"),
        lift: slider("lift"),
        reach: groundReach(),
        radius: domeRadius(),
        flat: pressed("flat"),
        even: pressed("even"),
    };
});

if (request) {
    for (const name of ["height", "lift", "reach", "radius"]) field(name).addEventListener("input", request);
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
