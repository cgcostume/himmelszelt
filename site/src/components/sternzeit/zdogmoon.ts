// The Moon, and Earth in the orbits, in the Zdog scenes (the armillary sphere, the orbits, the observer's frame and the
// sun path diagram) as the camera sees them, lit from the Sun where the figure draws it, so the lit side points at the
// drawn Sun whatever the figure's schematic distances, and the phase changes as the scene turns. The phase seen from
// Earth is the moon calendar's and the locked views'; here it is the camera's.
import Zdog from "zdog";
import { SUN_SYMBOL, themeColor } from "./figure";

export type Point = { x: number; y: number; z: number };
export type Rotation = { x: number; y: number; z: number };

const { Anchor, Shape } = Zdog;

// Zdog's turn of a point, as Vector.rotate makes it: about z, then y, then x, each turning one pair of axes.
function turnPair(p: Point, angle: number, a: "x" | "y", b: "y" | "z"): Point {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    return { ...p, [a]: p[a] * c - p[b] * s, [b]: p[b] * c + p[a] * s };
}
/** A scene point as the camera sees it once the scene is turned by `r`: x right, y down, z towards the viewer. */
export const turn = (p: Point, r: Rotation) =>
    turnPair(turnPair(turnPair(p, r.z, "x", "y"), r.y, "x", "z"), r.x, "y", "z");
/** The inverse of {@link turn}: a point in the camera's frame back into the scene's. */
export const unturn = (p: Point, r: Rotation) =>
    turnPair(turnPair(turnPair(p, -r.x, "y", "z"), -r.y, "x", "z"), -r.z, "x", "y");

/** Screen pixels around a point, in a scene turned by `rotation`, as offsets in the scene: x right, y down, z towards
 *  the viewer. What a billboard is drawn with. */
export function viewToScene(rotation: Rotation) {
    const [ex, ey, ez] = [
        unturn({ x: 1, y: 0, z: 0 }, rotation),
        unturn({ x: 0, y: 1, z: 0 }, rotation),
        unturn({ x: 0, y: 0, z: 1 }, rotation),
    ];
    return (x: number, y: number, z = 0): Point => ({
        x: x * ex.x + y * ey.x + z * ez.x,
        y: x * ex.y + y * ey.y + z * ez.y,
        z: x * ex.z + y * ey.z + z * ez.z,
    });
}

const OUTLINE_POINTS = 24;
// The outline around the Sun and the Moon, in screen pixels, as --body-edge in global.css.
const EDGE_PX = 0.8;

/**
 * Where the light comes from: "scene", from the Sun where the figure draws it, so the lit side points at the drawn Sun;
 * or "parallel", from the Sun's direction, as sunlight really arrives, which differs where the distances are schematic.
 */
const LIGHT_FROM: "scene" | "parallel" = "scene";

/**
 * The Sun's disc at `translate`, `radiusPx` across on screen, with its outline (on the light page only) behind it. The
 * disc is returned, for the classes the figures give it.
 */
export function zdogSun(addTo: Zdog.Anchor, translate: Point = { x: 0, y: 0, z: 0 }, radiusPx = SUN_SYMBOL.radius) {
    new Shape({ addTo, translate, stroke: 2 * (radiusPx + EDGE_PX), color: themeColor("--sun-edge") });
    return new Shape({ addTo, translate, stroke: 2 * radiusPx, color: themeColor("--sun-fill") });
}

/** The colors a lit body is drawn in, as the figures' CSS tokens resolve them. */
export interface BodyColors {
    edge: string;
    night: string;
    lit: string;
}

/**
 * A Moon at `translate`, `radiusPx` across on screen whatever the zoom: its outline (on the light page only), its night
 * side, and the part lit by the Sun, the half of the disc towards it on screen closed by the terminator. Call `update`
 * whenever the scene turns or zooms.
 */
export function zdogMoon(addTo: Zdog.Anchor, translate: Point = { x: 0, y: 0, z: 0 }, radiusPx = SUN_SYMBOL.radius) {
    const colors = {
        edge: themeColor("--moon-edge"),
        night: themeColor("--moon-night"),
        lit: themeColor("--moon-lit"),
    };
    return zdogBody(addTo, translate, radiusPx, colors);
}

/** Any body lit by the Sun, as {@link zdogMoon} draws the Moon, in its own colors: Earth in the orbits. */
export function zdogBody(addTo: Zdog.Anchor, translate: Point, radiusPx: number, colors: BodyColors) {
    const anchor = new Anchor({ addTo, translate });
    new Shape({ addTo: anchor, stroke: 2 * (radiusPx + EDGE_PX), color: colors.edge });
    new Shape({ addTo: anchor, stroke: 2 * radiusPx, color: colors.night });
    const lit = new Shape({
        addTo: anchor,
        path: [{ x: 0, y: 0, z: 0 }],
        closed: true,
        fill: true,
        stroke: false,
        color: colors.lit,
    });
    // The Sun and the Moon where the figure draws them, around the scene's center (Earth's or the observer's).
    function update(sun: Point, moon: Point, rotation: Rotation, zoom: number) {
        const toSun = LIGHT_FROM === "parallel" ? sun : { x: sun.x - moon.x, y: sun.y - moon.y, z: sun.z - moon.z };
        const length = Math.hypot(toSun.x, toSun.y, toSun.z);
        const seen = turn({ x: toSun.x / length, y: toSun.y / length, z: toSun.z / length }, rotation);
        // Zdog's +z points at the viewer, so seen.z is the cosine of the phase angle, and this the part seen lit.
        const fraction = (1 + seen.z) / 2;
        const angle = Math.atan2(seen.y, seen.x);
        const r = radiusPx / zoom;
        const toScene = viewToScene(rotation);
        // Screen pixels around the body, turned towards the Sun, into the scene; a hair towards the camera, over the disc.
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        const at = (x: number, y: number) => toScene(x * c - y * s, x * s + y * c, r * 0.1);
        const half = Array.from(
            { length: OUTLINE_POINTS + 1 },
            (_, i) => -Math.PI / 2 + (i * Math.PI) / OUTLINE_POINTS,
        );
        const limb = half.map((t) => at(r * Math.cos(t), r * Math.sin(t)));
        const terminator = [...half].reverse().map((t) => at(r * (1 - 2 * fraction) * Math.cos(t), r * Math.sin(t)));
        lit.path = [...limb, ...terminator];
        lit.updatePath();
    }
    return { anchor, update };
}
