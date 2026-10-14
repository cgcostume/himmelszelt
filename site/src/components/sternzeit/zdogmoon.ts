// The Moon in the Zdog scenes (Fig. 1, 3 and 6) as the camera sees it, lit from the Sun where the figure draws it, so
// its lit side points at the drawn Sun whatever the figure's schematic distances, and its phase changes as the scene
// turns. The phase seen from Earth is the moon calendar's and the locked views'; here it is the camera's.
import Zdog from "zdog";
import { SUN_SYMBOL, themeColor } from "./figure";

type Point = { x: number; y: number; z: number };
type Rotation = { x: number; y: number; z: number };

const { Anchor, Shape } = Zdog;

// Zdog's turn of a point, as Vector.rotate makes it: about z, then y, then x, each turning one pair of axes.
function turnPair(p: Point, angle: number, a: "x" | "y", b: "y" | "z"): Point {
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    return { ...p, [a]: p[a] * c - p[b] * s, [b]: p[b] * c + p[a] * s };
}
const turn = (p: Point, r: Rotation) => turnPair(turnPair(turnPair(p, r.z, "x", "y"), r.y, "x", "z"), r.x, "y", "z");
const unturn = (p: Point, r: Rotation) =>
    turnPair(turnPair(turnPair(p, -r.x, "y", "z"), -r.y, "x", "z"), -r.z, "x", "y");

const OUTLINE_POINTS = 24;
// The outline around the Sun and the Moon, in screen pixels, as --body-edge in global.css.
const EDGE_PX = 0.8;

/**
 * Where the light comes from: "scene", from the Sun where the figure draws it, so the lit side points at the drawn Sun;
 * or "parallel", from the Sun's direction, as sunlight really arrives, which differs where the distances are schematic.
 */
const LIGHT_FROM: "scene" | "parallel" = "scene";

/**
 * A Moon at `translate`, `radiusPx` across on screen whatever the zoom: its outline (on the light page only), its night
 * side, and the part lit by the Sun, the half of the disc towards it on screen closed by the terminator. Call `update`
 * whenever the scene turns or zooms.
 */
/**
 * The Sun's disc at `translate`, `radiusPx` across on screen, with its outline (on the light page only) behind it. The
 * disc is returned, for the classes the figures give it.
 */
export function zdogSun(addTo: Zdog.Anchor, translate: Point = { x: 0, y: 0, z: 0 }, radiusPx = SUN_SYMBOL.radius) {
    new Shape({ addTo, translate, stroke: 2 * (radiusPx + EDGE_PX), color: themeColor("--sun-edge") });
    return new Shape({ addTo, translate, stroke: 2 * radiusPx, color: themeColor("--sun-fill") });
}

export function zdogMoon(addTo: Zdog.Anchor, translate: Point = { x: 0, y: 0, z: 0 }, radiusPx = SUN_SYMBOL.radius) {
    const anchor = new Anchor({ addTo, translate });
    new Shape({ addTo: anchor, stroke: 2 * (radiusPx + EDGE_PX), color: themeColor("--moon-edge") });
    new Shape({ addTo: anchor, stroke: 2 * radiusPx, color: themeColor("--moon-night") });
    const lit = new Shape({
        addTo: anchor,
        path: [{ x: 0, y: 0, z: 0 }],
        closed: true,
        fill: true,
        stroke: false,
        color: themeColor("--moon-lit"),
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
        const [ex, ey, ez] = [
            unturn({ x: 1, y: 0, z: 0 }, rotation),
            unturn({ x: 0, y: 1, z: 0 }, rotation),
            unturn({ x: 0, y: 0, z: 1 }, rotation),
        ];
        // Screen pixels around the Moon, turned towards the Sun, into the scene; a hair towards the camera, over the disc.
        const [c, s] = [Math.cos(angle), Math.sin(angle)];
        const at = (x: number, y: number) => {
            const [sx, sy, sz] = [x * c - y * s, x * s + y * c, r * 0.1];
            return {
                x: sx * ex.x + sy * ey.x + sz * ez.x,
                y: sx * ex.y + sy * ey.y + sz * ez.y,
                z: sx * ex.z + sy * ey.z + sz * ez.z,
            };
        };
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
