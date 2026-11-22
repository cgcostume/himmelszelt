import { expect, test } from "@playwright/test";
import { evaluateWgsl, gpuDevice, wgslSource } from "./gpu.js";

const source = wgslSource("ground");
const DEG = Math.PI / 180;
const HEIGHT = 2;
type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

/** A ray as the tests pass it: from `east` of the origin and `up` above the plane, along an azimuth and an altitude. */
const ray = (east: number, up: number, azimuth: number, altitude: number): Vec4 => [east, up, azimuth, altitude];
const directionOf = ([, , azimuth, altitude]: Vec4): Vec3 => [
    Math.cos(altitude * DEG) * Math.sin(azimuth * DEG),
    Math.cos(altitude * DEG) * Math.cos(azimuth * DEG),
    Math.sin(altitude * DEG),
];
const DIRECTION =
    "vec3f(cos(radians(input.w)) * sin(radians(input.z)), cos(radians(input.w)) * cos(radians(input.z)), sin(radians(input.w)))";

/** The lookups `rbGroundedDirection` gives for `rays`, its bend meeting the dome `meets` degrees up. */
async function grounded(reach: number, radius: number, rays: Vec4[], meets = 0) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return [];
    const args = `vec3f(input.x, 0.0, input.y), ${DIRECTION}, ${HEIGHT}.0, ${reach}, ${radius}, radians(${meets.toFixed(6)})`;
    return evaluateWgsl(device, source, `vec4f(rbGroundedDirection(${args}), 0.0)`, rays);
}

/** As rbGroundedMeets: how high up the dome, in degrees, the bend `soft` of the widest meets it for an image horizon. */
function meetsFor(radius: number, soft: number, horizon: number) {
    const r = radius / HEIGHT;
    const rises = Math.sin(horizon * DEG);
    const up = soft * Math.min(Math.max((1 + r * rises) / (1 + rises), 0), 0.5 * (r + 1));
    return Math.asin(Math.min(Math.max((up - 1) / (r - up), -1), 1)) / DEG;
}

/**
 * The bend as rbGroundedDirection lays it, in capture heights: the plane's edge, the control point on the plane, where
 * it meets the dome and the weight, the circle at its longest reach, and the lookups to its two ends as the sines of
 * how far below the horizon.
 */
function bend(reach: number, radius: number, meets = 0) {
    const dome = HEIGHT / radius;
    if (radius >= 1e9) {
        return { dome, edge: HEIGHT / Math.hypot(HEIGHT, reach), foot: dome, hill: true, along: reach / HEIGHT };
    }
    const r = 1 / dome;
    const rises = Math.min(Math.max(Math.sin(meets * DEG), -dome), 0.99);
    const up = (1 + r * rises) / (1 + rises);
    const longest = Math.sqrt(Math.max((r - 1) * (r + 1 - 2 * up), 0));
    const along = Math.min(Math.max(reach / HEIGHT, 0), longest);
    const control = (r + rises) / Math.sqrt(1 - rises * rises);
    const weight = Math.cos(0.5 * Math.asin(rises) + Math.PI / 4);
    const end = [r * Math.sqrt(1 - rises * rises), 1 + r * rises] as const;
    const corner = 1 + r * rises <= 1e-6;
    return {
        dome,
        edge: corner ? -rises : 1 / Math.hypot(1, along),
        foot: -rises,
        hill: false,
        along: corner ? longest : along,
        control,
        weight,
        end,
        circle: { center: [longest, up] as const, longest },
    };
}

/** The bend's point at parameter t, in capture heights, out from under the capture point and up. */
function bendPoint(b: ReturnType<typeof bend>, t: number) {
    const [w0, w1, w2] = [(1 - t) ** 2, 2 * (b.weight ?? 0) * t * (1 - t), t * t];
    const [ex = 0, ez = 0] = b.end ?? [];
    const sum = w0 + w1 + w2;
    return [(b.along * w0 + (b.control ?? 0) * w1 + ex * w2) / sum, (ez * w2) / sum] as const;
}

/** How far along a lookup the surface lies, in the scene's units: the twin of `rbGroundedGap`, by bisection. */
function surfaceDistance(lookup: Vec3, reach: number, radius: number, meets = 0) {
    const b = bend(reach, radius, meets);
    const down = -lookup[2];
    if (down >= b.edge) return HEIGHT / down;
    if (b.hill) {
        const t = Math.min(Math.max((down - b.foot) / (b.edge - b.foot), 0), 1);
        return HEIGHT / (b.dome + (b.edge - b.dome) * t * t * (2 - t));
    }
    if (down <= b.foot) return HEIGHT / b.dome;
    // The bend's point seen along the lookup, its angle below the horizon rising with t.
    const angle = (t: number) => {
        const [x, z] = bendPoint(b, t);
        return (1 - z) / Math.hypot(x, 1 - z);
    };
    let [lo, hi] = [0, 1];
    for (let k = 0; k < 80; k++) {
        const mid = 0.5 * (lo + hi);
        if (angle(mid) > down) lo = mid;
        else hi = mid;
    }
    const [x, z] = bendPoint(b, 0.5 * (lo + hi));
    return HEIGHT * Math.hypot(x, 1 - z);
}

/**
 * How far the surface's point along a lookup lies off the ray, as an angle seen from where the image was taken, in
 * radians: by so much the lookup misses what the ray meets.
 */
function miss([east, up]: Vec4, direction: Vec3, lookup: Vec3, reach: number, radius: number, meets = 0) {
    const distance = surfaceDistance(lookup, reach, radius, meets);
    const fromEye: Vec3 = [distance * lookup[0] - east, distance * lookup[1], distance * lookup[2] + HEIGHT - up];
    const along = fromEye[0] * direction[0] + fromEye[1] * direction[1] + fromEye[2] * direction[2];
    expect(along).toBeGreaterThan(0);
    return Math.hypot(...fromEye.map((f, i) => f - along * (direction[i] as number))) / distance;
}

test("seen from where the image was taken, the grounded image is the image", async () => {
    const rays = [-80, -30, -5, -0.5, 0, 0.5, 20, 80].map((altitude) => ray(0, HEIGHT, 40, altitude));
    for (const [reach, radius] of [
        [8, 1e9],
        [8, 30],
        [1e9, 1e9],
    ]) {
        const lookups = await grounded(reach as number, radius as number, rays);
        if (lookups.length === 0) return;
        rays.forEach((r, i) => {
            directionOf(r).forEach((d, k) => {
                expect(lookups[i]?.[k], `reach ${reach}, radius ${radius}, ray ${i}`).toBeCloseTo(d, 5);
            });
        });
    }
});

test("within its reach the ground is the plane, and above the horizon the dome", async () => {
    // From 3 east and 1 up, looking east and down by 30°: the plane 1.73 further east, 4.73 from the origin.
    const onPlane = ray(3, 1, 90, -30);
    const upwards = ray(3, 3, 90, 20);
    const lookups = await grounded(8, 30, [onPlane, upwards], 0);
    if (lookups.length === 0) return;
    const hit = 3 + 1 / Math.tan(30 * DEG);
    const expected = [hit / Math.hypot(hit, HEIGHT), 0, -HEIGHT / Math.hypot(hit, HEIGHT)];
    expected.forEach((e, k) => {
        expect(lookups[0]?.[k]).toBeCloseTo(e, 5);
    });
    // The ray upwards meets the sphere of 30 about where the image was taken, 26.84 along.
    const [x, , z] = directionOf(upwards);
    const b = 3 * x + (3 - HEIGHT) * z;
    const along = Math.sqrt(b * b - 10 + 900) - b;
    expect(along).toBeCloseTo(26.84, 2);
    [3 + along * x, 0, 3 - HEIGHT + along * z].forEach((m, k) => {
        expect(lookups[1]?.[k]).toBeCloseTo(m / 30, 5);
    });
});

/** Reach, dome radius and how high the bend meets the dome, in degrees: circles, flatter arcs, corners. */
const FINITE: [number, number, number][] = [
    [13, 15, 0],
    [6, 15, 0],
    [1, 15, 0],
    [0, 15, 0],
    [11, 15, meetsFor(15, 1, 4)],
    [5, 15, meetsFor(15, 1, 4)],
    [14, 15, meetsFor(15, 0.5, 0)],
    [4, 15, meetsFor(15, 0.5, -3)],
    [40, 15, meetsFor(15, 0, 0)],
    [6, 15, meetsFor(15, 0, 0)],
    [20, 30, 0],
    [150, 200, 10],
];

test("under a dome the ground only rises from the plane into the dome, never beyond it, never under the plane", () => {
    for (const [reach, radius, meets] of FINITE) {
        const where = `reach ${reach}, radius ${radius}, meets ${meets}°`;
        const b = bend(reach, radius, meets);
        // The worst of each, over the bend: how far beyond the dome, under the plane, back down, and, seen from the
        // capture point, back up, so that each lookup meets it once.
        let [beyond, under, sinks, turns] = [-1, -1, -1, -1];
        let [lastZ, lastBelow] = [-1, Number.POSITIVE_INFINITY];
        for (let k = 0; k <= 4000; k++) {
            const [x, z] = bendPoint(b, k / 4000);
            const below = (1 - z) / Math.hypot(x, 1 - z);
            beyond = Math.max(beyond, Math.hypot(x, z - 1) - radius / HEIGHT);
            under = Math.max(under, -z);
            sinks = Math.max(sinks, lastZ - z);
            turns = Math.max(turns, below - lastBelow);
            [lastZ, lastBelow] = [z, below];
        }
        expect(beyond, where).toBeLessThanOrEqual(1e-9 * radius);
        expect(under, where).toBeLessThanOrEqual(1e-12);
        expect(sinks, where).toBeLessThanOrEqual(1e-12);
        expect(turns, where).toBeLessThanOrEqual(1e-12);
        // Above where it meets the dome, the sky lies on the dome.
        const above = Math.min(-b.foot + 1e-6, 1);
        const sky: Vec3 = [Math.sqrt(1 - above * above), 0, above];
        expect(surfaceDistance(sky, reach, radius, meets), where).toBeCloseTo(radius, 6);
    }
});

test("the bend leaves the plane level at the reach and meets the dome at its slope, whatever the reach", () => {
    for (const [reach, radius, meets] of FINITE) {
        const where = `reach ${reach}, radius ${radius}, meets ${meets}°`;
        const b = bend(reach, radius, meets);
        if (b.end === undefined || b.end[1] <= 1e-6) continue;
        const h = 1e-6;
        const [p0, p1] = [bendPoint(b, 0), bendPoint(b, h)];
        expect(p0[0], where).toBeCloseTo(Math.min(reach / HEIGHT, b.circle?.longest ?? 0), 9);
        expect(p0[1], where).toBeCloseTo(0, 12);
        expect(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]), where).toBeCloseTo(0, 4);
        const [q0, q1] = [bendPoint(b, 1 - h), bendPoint(b, 1)];
        expect(Math.hypot(q1[0], q1[1] - 1), where).toBeCloseTo(radius / HEIGHT, 9);
        // The dome's wall runs at right angles to the line from the capture point.
        const slope = Math.atan2(q1[1] - q0[1], q1[0] - q0[0]);
        const wall = Math.atan2(q1[0], -(q1[1] - 1));
        expect(Math.abs(slope - wall), where).toBeLessThan(1e-4);
    }
});

test("at its longest reach the bend is the circle that touches plane and dome, the hard corner at its lowest", () => {
    for (const [, radius, meets] of FINITE) {
        const b = bend(1e9, radius, meets);
        const [cx, cz] = b.circle?.center ?? [0, 0];
        if (cz <= 1e-9) continue;
        const where = `radius ${radius}, meets ${meets}°`;
        // Its center as high as its radius, and as far from the capture point as the dome's radius less its own.
        expect(Math.hypot(cx, cz - 1), where).toBeCloseTo(radius / HEIGHT - cz, 9);
        let off = 0;
        for (let k = 0; k <= 32; k++) {
            const [x, z] = bendPoint(b, k / 32);
            off = Math.max(off, Math.abs(Math.hypot(x - cx, z - cz) - cz));
        }
        expect(off, where).toBeLessThan(1e-9);
    }
    // The quarter circle as high as the capture point at a reach a height short of the radius.
    expect(bend(1e9, 15, 0).circle?.longest).toBeCloseTo((15 - HEIGHT) / HEIGHT, 9);
    // As low as where the plane meets the dome, the plane on up to it, whatever the reach.
    const corner = bend(6, 15, meetsFor(15, 0, 0));
    expect(corner.edge).toBeCloseTo(corner.foot, 12);
    expect(corner.along * HEIGHT).toBeCloseTo(Math.sqrt(15 * 15 - HEIGHT * HEIGHT), 6);
});

test("rbGroundedMeets and rbGroundedReach give the bend that meets the dome where the image's horizon does", async () => {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return;
    const cases: Vec4[] = [];
    for (const soft of [0, 0.5, 1]) for (const horizon of [-10, -5, 0, 4, 20]) cases.push([soft, horizon, 0, 0]);
    const meets = `rbGroundedMeets(${HEIGHT}.0, 15.0, input.x, radians(input.y))`;
    const call = `vec4f(degrees(${meets}), rbGroundedReach(${HEIGHT}.0, 15.0, ${meets}), 0.0, 0.0)`;
    const results = await evaluateWgsl(device, source, call, cases);
    cases.forEach(([soft, horizon], i) => {
        const where = `soft ${soft}, horizon ${horizon}°`;
        const [meets = 0, reach = 0] = results[i] ?? [];
        expect(meets, where).toBeCloseTo(meetsFor(15, soft, horizon), 2);
        // The widest meets the dome at the image's horizon, unless that lies below where the plane meets the dome.
        if (soft === 1 && Math.sin(horizon * DEG) > -HEIGHT / 15) expect(meets, where).toBeCloseTo(horizon, 2);
        expect(reach / HEIGHT, where).toBeCloseTo(bend(1e9, 15, meets).circle?.longest ?? 0, 3);
    });
});

test("under a dome without end the ground falls away past its reach like a hilltop", () => {
    for (let depression = 0.25; depression <= 90; depression += 0.25) {
        const lookup: Vec3 = [Math.cos(depression * DEG), 0, -Math.sin(depression * DEG)];
        const distance = surfaceDistance(lookup, 8, 1e9);
        expect(HEIGHT + distance * lookup[2]).toBeLessThanOrEqual(1e-6);
    }
});

test("past its reach a ray meets the one surface, whatever the reach, the dome and the bend", async () => {
    const rays: Vec4[] = [];
    for (const [east, up] of [
        [0.5, 1.2],
        [4, 0.3],
        [6, 1.85],
        [6, 9],
        [-15, 4],
        [-11, 0.5],
        [12, 1.5],
    ]) {
        for (const azimuth of [90, 30, -120]) {
            for (const altitude of [-60, -25, -12, -6, -2, -0.5, 0, 1, 4, 10]) {
                rays.push(ray(east as number, up as number, azimuth, altitude));
            }
        }
    }
    const cases: [number, number, number][] = [[8, 1e9, 0], [3, 1e9, 0], [1e9, 30, 0], ...FINITE];
    for (const [reach, radius, meets] of cases) {
        const lookups = await grounded(reach, radius, rays, meets);
        if (lookups.length === 0) return;
        rays.forEach((r, i) => {
            // An eye in the room the bend takes from the dome is outside the surface, where no ray starts.
            const [east, up] = r;
            const fromCapture = Math.hypot(east, up - HEIGHT);
            const towards: Vec3 = [east / fromCapture, 0, (up - HEIGHT) / fromCapture];
            if (fromCapture >= surfaceDistance(towards, reach, radius, meets)) return;
            const lookup = lookups[i]?.slice(0, 3) as Vec3;
            const where = `reach ${reach}, radius ${radius}, meets ${meets}°, ray ${r}`;
            expect(Math.hypot(...lookup), where).toBeCloseTo(1, 5);
            expect(miss(r, directionOf(r), lookup, reach, radius, meets), where).toBeLessThan(5e-5);
        });
    }
});

test("the lookup goes over from the ground to the horizon without a jump", async () => {
    // A sweep of half a degree a step from straight down to the horizon, from beside and above where the image was taken.
    const rays = Array.from({ length: 180 }, (_, i) => ray(2, 3, 90, -89.5 + i * 0.5));
    const cases: [number, number, number][] = [
        [8, 1e9, 0],
        [8, 30, 0],
        [3, 15, 0],
        [13, 15, 0],
        [5, 15, meetsFor(15, 1, 4)],
    ];
    for (const [reach, radius, meets] of cases) {
        const lookups = await grounded(reach, radius, rays, meets);
        if (lookups.length === 0) return;
        const altitudes = lookups.map((l) => Math.asin(l[2]) / DEG);
        for (let i = 1; i < altitudes.length; ++i) {
            const step = (altitudes[i] as number) - (altitudes[i - 1] as number);
            expect(step, `reach ${reach}, radius ${radius}, step ${i}`).toBeGreaterThan(0);
            expect(step, `reach ${reach}, radius ${radius}, step ${i}`).toBeLessThan(1.5);
        }
    }
});
