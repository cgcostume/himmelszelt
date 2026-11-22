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

/** The lookups `rbGroundedDirection` gives for `rays`, or with a `rounding` of the dome's foot `rbGroundedDirectionRounded`. */
async function grounded(reach: number, radius: number, rays: Vec4[], rounding?: number) {
    const device = await gpuDevice();
    test.skip(device === null, "GPU tests disabled; run pnpm test:gpu");
    if (!device) return [];
    const args = `vec3f(input.x, 0.0, input.y), ${DIRECTION}, ${HEIGHT}.0, ${reach}, ${radius}`;
    const call =
        rounding === undefined
            ? `rbGroundedDirection(${args})`
            : `rbGroundedDirectionRounded(${args}, ${rounding.toFixed(6)})`;
    return evaluateWgsl(device, source, `vec4f(${call}, 0.0)`, rays);
}

/** How far along a lookup the surface lies, in the scene's units: the twin of what `rbGroundedGap` fades. */
function surfaceDistance(lookup: Vec3, reach: number, radius: number, rounding = 0) {
    const dome = HEIGHT / radius;
    const reached = Math.max(HEIGHT / Math.hypot(HEIGHT, reach), 2 * dome);
    const foot = dome * (1 - Math.max(rounding, 0));
    const edge = rounding < 0 ? dome + (reached - dome) * (1 + rounding) : reached;
    const down = -lookup[2];
    if (down >= edge) return HEIGHT / down;
    const t = Math.min(Math.max((down - foot) / Math.max(edge - foot, 1e-30), 0), 1);
    return HEIGHT / (dome + t * t * ((edge - dome) * (3 - 2 * t) + (edge - foot) * (t - 1)));
}

/**
 * How far the surface's point along a lookup lies off the ray, as an angle seen from where the image was taken, in
 * radians: by so much the lookup misses what the ray meets.
 */
function miss([east, up]: Vec4, direction: Vec3, lookup: Vec3, reach: number, radius: number, rounding = 0) {
    const distance = surfaceDistance(lookup, reach, radius, rounding);
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
    const lookups = await grounded(8, 30, [onPlane, upwards]);
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

test("the surface stays within the dome, and past the dome's foot at the plane's level or under it", () => {
    for (const [reach, radius] of [
        [8, 30],
        [3, 200],
        [6, 15],
    ]) {
        for (let depression = 0; depression <= 90; depression += 0.25) {
            const lookup: Vec3 = [Math.cos(depression * DEG), 0, -Math.sin(depression * DEG)];
            const distance = surfaceDistance(lookup, reach as number, radius as number);
            expect(distance).toBeLessThanOrEqual((radius as number) * (1 + 1e-12));
            // Down to the dome's foot it is the dome, above the plane; from there on at the plane's level or under it.
            const foot = -lookup[2] >= HEIGHT / (radius as number);
            if (foot) expect(HEIGHT + distance * lookup[2]).toBeLessThanOrEqual(1e-9);
            else expect(distance).toBeCloseTo(radius as number, 9);
        }
    }
});

test("past its reach a ray meets the one surface, whatever the reach and the dome", async () => {
    const rays: Vec4[] = [];
    for (const [east, up] of [
        [0.5, 1.2],
        [4, 0.3],
        [6, 1.85],
        [6, 9],
        [-15, 4],
    ]) {
        for (const azimuth of [90, 30, -120]) {
            for (const altitude of [-60, -25, -12, -6, -2, -0.5, 0, 1]) {
                rays.push(ray(east as number, up as number, azimuth, altitude));
            }
        }
    }
    for (const [reach, radius] of [
        [8, 1e9],
        [3, 1e9],
        [8, 30],
        [3, 200],
        [1e9, 30],
    ]) {
        const lookups = await grounded(reach as number, radius as number, rays);
        if (lookups.length === 0) return;
        rays.forEach((r, i) => {
            const lookup = lookups[i]?.slice(0, 3) as Vec3;
            const where = `reach ${reach}, radius ${radius}, ray ${r}`;
            expect(Math.hypot(...lookup), where).toBeCloseTo(1, 5);
            expect(miss(r, directionOf(r), lookup, reach as number, radius as number), where).toBeLessThan(1e-5);
        });
    }
});

test("the lookup goes over from the ground to the horizon without a jump", async () => {
    // A sweep of half a degree a step from straight down to the horizon, from beside and above where the image was taken.
    const rays = Array.from({ length: 180 }, (_, i) => ray(2, 3, 90, -89.5 + i * 0.5));
    for (const [reach, radius] of [
        [8, 1e9],
        [8, 30],
    ]) {
        const lookups = await grounded(reach as number, radius as number, rays);
        if (lookups.length === 0) return;
        const altitudes = lookups.map((l) => Math.asin(l[2]) / DEG);
        for (let i = 1; i < altitudes.length; ++i) {
            const step = (altitudes[i] as number) - (altitudes[i - 1] as number);
            expect(step, `reach ${reach}, radius ${radius}, step ${i}`).toBeGreaterThan(0);
            expect(step, `reach ${reach}, radius ${radius}, step ${i}`).toBeLessThan(1.5);
        }
    }
});

const ROUNDINGS = [-1, -0.5, 0.5, 1];

test("a rounded foot stays within the dome and under where it begins, and a sharp one at the plane's level", () => {
    for (const [reach, radius] of [
        [8, 30],
        [3, 200],
        [6, 15],
        [1e9, 30],
    ]) {
        for (const rounding of [...ROUNDINGS, 0.1]) {
            const where = `reach ${reach}, radius ${radius}, rounding ${rounding}`;
            const dome = HEIGHT / (radius as number);
            const foot = dome * (1 - Math.max(rounding, 0));
            let last = Number.POSITIVE_INFINITY;
            for (let depression = 0; depression <= 90; depression += 0.125) {
                const lookup: Vec3 = [Math.cos(depression * DEG), 0, -Math.sin(depression * DEG)];
                const distance = surfaceDistance(lookup, reach as number, radius as number, rounding);
                const z = HEIGHT + distance * lookup[2];
                expect(distance, where).toBeLessThanOrEqual((radius as number) * (1 + 1e-12));
                // Drawing in towards straight down, never back out.
                expect(distance, where).toBeLessThanOrEqual(last * (1 + 1e-12));
                last = distance;
                if (-lookup[2] <= foot) expect(distance, where).toBeCloseTo(radius as number, 9);
                else if (rounding > 0) expect(z, where).toBeLessThanOrEqual(rounding * HEIGHT + 1e-9);
                else if (-lookup[2] >= dome) expect(z, where).toBeLessThanOrEqual(1e-9);
            }
        }
    }
});

test("a foot rounded to -1 is the hard corner of plane and dome, and the default is the cubic it always was", () => {
    for (let depression = 0; depression <= 90; depression += 0.25) {
        const lookup: Vec3 = [Math.cos(depression * DEG), 0, -Math.sin(depression * DEG)];
        const down = Math.sin(depression * DEG);
        expect(surfaceDistance(lookup, 8, 30, -1)).toBeCloseTo(Math.min(30, HEIGHT / down), 9);
        const dome = HEIGHT / 30;
        const edge = Math.max(HEIGHT / Math.hypot(HEIGHT, 8), 2 * dome);
        const t = Math.min(Math.max((down - dome) / (edge - dome), 0), 1);
        const cubic = down >= edge ? HEIGHT / down : HEIGHT / (dome + (edge - dome) * t * t * (2 - t));
        expect(surfaceDistance(lookup, 8, 30)).toBeCloseTo(cubic, 9);
    }
});

test("the rounded foot leaves the dome and meets the plane at their slopes", () => {
    // The inverse distance over the lookup's part downwards: flat on the dome, of slope 1 on the plane.
    const h = 1e-7;
    for (const rounding of [0, 0.5, 1]) {
        const inverse = (down: number) => 1 / surfaceDistance([Math.sqrt(1 - down * down), 0, -down], 8, 30, rounding);
        const dome = HEIGHT / 30;
        const foot = dome * (1 - rounding);
        const edge = Math.max(HEIGHT / Math.hypot(HEIGHT, 8), 2 * dome);
        expect((inverse(foot + h) - inverse(foot)) / h).toBeCloseTo(0, 4);
        expect((inverse(edge) - inverse(edge - h)) / h).toBeCloseTo(1 / HEIGHT, 4);
    }
});

test("rounded either way, a ray meets the one surface", async () => {
    const rays: Vec4[] = [];
    for (const [east, up] of [
        [0.5, 1.2],
        [4, 0.3],
        [6, 1.85],
        [6, 9],
        [-15, 4],
        [-26, 0.5],
        [25, 1.5],
    ]) {
        for (const azimuth of [90, 30, -120]) {
            for (const altitude of [-60, -25, -12, -6, -2, -0.5, 0, 1, 4, 10]) {
                rays.push(ray(east as number, up as number, azimuth, altitude));
            }
        }
    }
    for (const rounding of ROUNDINGS) {
        for (const [reach, radius] of [
            [8, 30],
            [3, 200],
            [1e9, 30],
            [8, 1e9],
        ]) {
            const lookups = await grounded(reach as number, radius as number, rays, rounding);
            if (lookups.length === 0) return;
            rays.forEach((r, i) => {
                // An eye in the room the fillet takes from the dome is outside the surface, where no ray starts.
                const [east, up] = r;
                const fromCapture = Math.hypot(east, up - HEIGHT);
                const towards: Vec3 = [east / fromCapture, 0, (up - HEIGHT) / fromCapture];
                if (fromCapture >= surfaceDistance(towards, reach as number, radius as number, rounding)) return;
                const lookup = lookups[i]?.slice(0, 3) as Vec3;
                const where = `reach ${reach}, radius ${radius}, rounding ${rounding}, ray ${r}`;
                expect(Math.hypot(...lookup), where).toBeCloseTo(1, 5);
                const off = miss(r, directionOf(r), lookup, reach as number, radius as number, rounding);
                expect(off, where).toBeLessThan(1e-4);
            });
        }
    }
});

test("a rounding of 0 is rbGroundedDirection, and rounded the lookup still goes over to the horizon without a jump", async () => {
    const rays = Array.from({ length: 180 }, (_, i) => ray(2, 3, 90, -89.5 + i * 0.5));
    const plain = await grounded(8, 30, rays);
    if (plain.length === 0) return;
    const zero = await grounded(8, 30, rays, 0);
    plain.forEach((l, i) => {
        l.forEach((v, k) => {
            expect(zero[i]?.[k]).toBe(v);
        });
    });
    for (const rounding of ROUNDINGS) {
        const lookups = await grounded(8, 30, rays, rounding);
        const altitudes = lookups.map((l) => Math.asin(l[2]) / DEG);
        for (let i = 1; i < altitudes.length; ++i) {
            const step = (altitudes[i] as number) - (altitudes[i - 1] as number);
            expect(step, `rounding ${rounding}, step ${i}`).toBeGreaterThanOrEqual(0);
            expect(step, `rounding ${rounding}, step ${i}`).toBeLessThan(1.5);
        }
    }
});
