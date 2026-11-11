import { expect, test } from "@playwright/test";
import { MOON_RADIUS_KM, moonOrientation, type Vec3, viewFrame } from "../src/orientation.js";
import { fromSelenographic, selenographicPoint, surfaceCircle, surfacePoint } from "../src/surface.js";

const DEG = Math.PI / 180;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
// The Moon due south, halfway up, as seen from the northern hemisphere, without libration or tilt.
const SOUTH_UP: Vec3 = [0, -Math.SQRT1_2, Math.SQRT1_2];
const still = (direction: Vec3, libration = { longitude: 0, latitude: 0 }) =>
    moonOrientation({ direction, libration, positionAngleOfAxis: 0, parallacticAngle: 0 });
const towardViewer: Vec3 = [-SOUTH_UP[0], -SOUTH_UP[1], -SOUTH_UP[2]];

test("a place and the way back: the orientation's transpose undoes it", () => {
    const orientation = moonOrientation({
        direction: SOUTH_UP,
        libration: { longitude: 6, latitude: -5 },
        positionAngleOfAxis: 20,
        parallacticAngle: -10,
    });
    const body = selenographicPoint(-11.2, -43.3);
    const enu = fromSelenographic(orientation, body);
    // Applying the orientation, ENU to the Moon's frame, gives the point back.
    const back = [0, 1, 2].map((row) =>
        [0, 1, 2].reduce((s, k) => s + (orientation[k * 3 + row] ?? 0) * (enu[k] ?? 0), 0),
    );
    for (const [i, v] of back.entries()) expect(v).toBeCloseTo(body[i] ?? 0, 6);
});

test("the disc's center faces the viewer, a place 90° away lies on the limb, the far side is hidden", () => {
    const moon = { orientation: still(SOUTH_UP), direction: SOUTH_UP, sunDirection: towardViewer };
    expect(surfacePoint(moon, 0, 0).facing).toBeCloseTo(1, 6);
    expect(surfacePoint(moon, 90, 0).facing).toBeCloseTo(0, 6);
    expect(surfacePoint(moon, 180, 0).visible).toBe(false);
    // With the libration's longitude, the place under it is at the center.
    const turned = { ...moon, orientation: still(SOUTH_UP, { longitude: 7, latitude: -6 }) };
    expect(surfacePoint(turned, 7, -6).facing).toBeCloseTo(1, 6);
});

test("the Moon's east, Mare Crisium's side, is on the right of the disc and its north up", () => {
    const moon = { orientation: still(SOUTH_UP), direction: SOUTH_UP, sunDirection: towardViewer };
    const { right, up } = viewFrame(SOUTH_UP);
    const crisium = surfacePoint(moon, 59.1, 17.0).normal;
    expect(dot(crisium, right)).toBeCloseTo(Math.cos(17 * DEG) * Math.sin(59.1 * DEG), 6);
    expect(dot(crisium, up)).toBeCloseTo(Math.sin(17 * DEG), 6);
});

// Near 90° the arcsine magnifies the orientation's float32 rounding to some 0.01°.
test("the Sun stands overhead at the disc's center at full Moon and on the horizon on the terminator", () => {
    const full = { orientation: still(SOUTH_UP), direction: SOUTH_UP, sunDirection: towardViewer };
    expect(surfacePoint(full, 0, 0).sunAltitude).toBeCloseTo(90, 1);
    expect(surfacePoint(full, 0, 0).lit).toBe(true);
    // At first quarter seen from the north the Sun lights the right, the Moon's east: noon at 90° east, dusk at 0°.
    const { right } = viewFrame(SOUTH_UP);
    const quarter = { ...full, sunDirection: right };
    expect(surfacePoint(quarter, 0, 0).sunAltitude).toBeCloseTo(0, 4);
    expect(surfacePoint(quarter, 90, 0).sunAltitude).toBeCloseTo(90, 1);
    expect(surfacePoint(quarter, -30, 0).lit).toBe(false);
});

test("a crater's rim lies on the sphere at its radius from the center, all around it", () => {
    const orientation = still(SOUTH_UP, { longitude: 3, latitude: 4 });
    const center = fromSelenographic(orientation, selenographicPoint(-11.2, -43.3));
    const rim = surfaceCircle({ orientation }, -11.2, -43.3, 85.3, 36);
    expect(rim).toHaveLength(36);
    for (const p of rim) {
        expect(Math.hypot(...p)).toBeCloseTo(1, 6);
        expect(Math.acos(dot(p, center)) * MOON_RADIUS_KM).toBeCloseTo(85.3 / 2, 3);
    }
});
