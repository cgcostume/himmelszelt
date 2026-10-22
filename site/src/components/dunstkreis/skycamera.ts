/**
 * The camera the figures look at the sky through from the observer's place: its view, in the observer's ENU frame,
 * yaw a compass azimuth, and dragging to look around and scrolling to zoom. Shared, so that every such figure turns and
 * zooms alike.
 */

const DEG = Math.PI / 180;

export type SkyCamera = { yaw: number; pitch: number; fov: number };
export type Vec3 = [number, number, number];

// Zooming out past 100 degrees bends the perspective into a stereographic fisheye, complete at the widest view of
// 200 degrees: the projection's d (see dunstkreis' projectionDistance). Looking up, the whole sky then shows as a disc,
// with ten degrees below the horizon to spare at the top and bottom edges.
export const MIN_FOV = 0.5 * DEG;
export const MAX_FOV = 200 * DEG;
export const projectionDistance = (fov: number) => Math.min(1, Math.max(0, (fov - 100 * DEG) / (MAX_FOV - 100 * DEG)));

/** The image plane radius at `theta` from the axis, for the projection's d: (d + 1) sin(theta) / (d + cos(theta)). */
export const imageRadius = (theta: number, d: number) => ((d + 1) * Math.sin(theta)) / (d + Math.cos(theta));

export type Basis = ReturnType<typeof cameraBasis>;

/** The camera's forward, right and up vectors, the image plane's half extents, the field of view across its height,
 *  and the projection's d. */
export function cameraBasis({ yaw, pitch, fov }: SkyCamera, aspect: number) {
    const f: Vec3 = [Math.cos(pitch) * Math.sin(yaw), Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch)];
    const r: Vec3 = [Math.cos(yaw), -Math.sin(yaw), 0];
    const u: Vec3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    const d = projectionDistance(fov);
    const ty = imageRadius(fov / 2, d);
    return { f, r, u, tx: ty * aspect, ty, d };
}

const dot = (a: readonly number[], b: readonly number[]) =>
    (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);

/** Where `direction` shows in the view, in pixels from the top left, by the same projection the shader inverts: the
 *  angle from the axis to the image plane radius. Null behind the camera. */
export function project(direction: Vec3, basis: Basis, width: number, height: number) {
    const cosTheta = dot(direction, basis.f);
    if (basis.d + cosTheta <= 1e-3 || (basis.d === 0 && cosTheta <= 0)) return null;
    const inPlane = direction.map((c, i) => c - (basis.f[i] ?? 0) * cosTheta);
    const sinTheta = Math.hypot(...inPlane);
    const scale = sinTheta > 1e-9 ? imageRadius(Math.atan2(sinTheta, cosTheta), basis.d) / sinTheta : 1;
    const x = (dot(inPlane, basis.r) * scale) / basis.tx;
    const y = (dot(inPlane, basis.u) * scale) / basis.ty;
    return { x: ((x + 1) / 2) * width, y: ((1 - y) / 2) * height };
}

/**
 * Drag on `canvas` to look around, a pixel of drag turning the view by a pixel's worth of the field of view so the sky
 * follows the pointer, short of the zenith and the nadir; turn the wheel to zoom. `onChange` after every change,
 * `onDrag` once a drag moves.
 */
export function lookAround(
    canvas: HTMLCanvasElement,
    camera: SkyCamera,
    { onChange, onDrag }: { onChange: () => void; onDrag?: () => void },
) {
    canvas.addEventListener("pointerdown", (event) => {
        canvas.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, yaw: camera.yaw, pitch: camera.pitch };
        const move = (e: PointerEvent) => {
            onDrag?.();
            const perPixel = Math.min(camera.fov, Math.PI) / canvas.clientHeight;
            camera.yaw = start.yaw - (e.clientX - start.x) * perPixel;
            camera.pitch = Math.max(-89 * DEG, Math.min(89 * DEG, start.pitch + (e.clientY - start.y) * perPixel));
            onChange();
        };
        canvas.addEventListener("pointermove", move);
        canvas.addEventListener("pointerup", () => canvas.removeEventListener("pointermove", move), { once: true });
    });
    canvas.addEventListener(
        "wheel",
        (event) => {
            event.preventDefault();
            camera.fov = Math.max(MIN_FOV, Math.min(MAX_FOV, camera.fov * Math.exp(event.deltaY * 0.001)));
            onChange();
        },
        { passive: false },
    );
}

/** The full screen button of a view: it fills the screen with `view`, and shows whether it does. */
export function bindFullscreen(button: HTMLElement, view: HTMLElement) {
    button.addEventListener("click", () =>
        document.fullscreenElement ? document.exitFullscreen() : view.requestFullscreen(),
    );
    document.addEventListener("fullscreenchange", () =>
        button.setAttribute("aria-pressed", String(document.fullscreenElement === view)),
    );
}
