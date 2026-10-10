// What the tables' texels stand for and where a ray lands in them, in double precision: twins of dunstkreis' lut.wgsl
// both ways, and of common.wgsl's bent path, which the sky-view table is traced along. Texel coordinates run from 0 to
// n - 1 over a table's own rows and columns, as stored, before a preview flips them.

import type { AtmosphereModel } from "@himmelszelt/dunstkreis";
import type { Ray } from "./pick";

type Vec = number[];
type Size = { width: number; height: number };
export type Texel = { x: number; y: number };
export type Geometry = ReturnType<typeof geometry>;

/** The planet and its air, from a model: radii in km, the refractivity at an altitude, the tables' horizon terms. */
export function geometry(model: AtmosphereModel) {
    const Rg = model.planet.groundRadiusKm;
    const Rt = Rg + model.planet.thicknessKm;
    const HR = model.rayleigh.scaleHeightKm;
    const n = (h: number) => 1 + model.refractivity * Math.exp(-Math.max(h, 0) / HR);
    const toTop = (r: number, mu: number) =>
        Math.max(-r * mu + Math.sqrt(Math.max(r * r * (mu * mu - 1) + Rt * Rt, 0)), 0);
    return {
        Rg,
        Rt,
        top: Rt - Rg,
        HR,
        H: Math.sqrt(Rt * Rt - Rg * Rg),
        n,
        toTop,
        horizonMu(h: number) {
            const nr = n(h) * (Rg + h);
            const n0 = n(0) * Rg;
            return -Math.sqrt(Math.max(nr * nr - n0 * n0, 0)) / nr;
        },
        muMin(r: number) {
            const m = 1.1 * model.refractivity * Math.sqrt((2 * Math.PI * Rg) / HR);
            const rho = Math.sqrt(r * r - Rg * Rg);
            return (-rho / r) * Math.cos(m) - (Rg / r) * Math.sin(m);
        },
    };
}

const unit = (i: number, n: number) => (n > 1 ? i / (n - 1) : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Transmittance texel (x, y) of a `width` by `height` table: the radius, the cosine of the sun's zenith angle, and
 *  the distance to the top along it. */
export function transmittanceAt(g: Geometry, { width, height }: Size, x: number, y: number) {
    const rho = g.H * unit(y, height);
    const r = Math.sqrt(rho * rho + g.Rg * g.Rg);
    const dMin = g.Rt - r;
    const d = dMin + unit(x, width) * (g.toTop(r, g.muMin(r)) - dMin);
    const mu = d > 0 ? clamp((g.H * g.H - rho * rho - d * d) / (2 * r * d), -1, 1) : 1;
    return { r, mu, d };
}

/** Where radius `r` and cosine `mu` land in the transmittance table, as fractional texel coordinates. */
export function transmittanceTexel(g: Geometry, { width, height }: Size, r: number, mu: number): Texel {
    const rho = Math.sqrt(Math.max(r * r - g.Rg * g.Rg, 0));
    const dMin = g.Rt - r;
    const dMax = g.toTop(r, g.muMin(r));
    const xMu = dMax > dMin ? (g.toTop(r, Math.max(mu, g.muMin(r))) - dMin) / (dMax - dMin) : 0;
    return { x: clamp(xMu, 0, 1) * (width - 1), y: clamp(rho / g.H, 0, 1) * (height - 1) };
}

/** Multiple scattering texel (x, y): the altitude and the cosine of the sun's zenith angle, both linear. */
export function multiScatteringAt(g: Geometry, { width, height }: Size, x: number, y: number) {
    return { altitude: unit(y, height) * g.top, muS: unit(x, width) * 2 - 1 };
}

export function multiScatteringTexel(g: Geometry, { width, height }: Size, altitude: number, muS: number): Texel {
    return { x: clamp(muS * 0.5 + 0.5, 0, 1) * (width - 1), y: clamp(altitude / g.top, 0, 1) * (height - 1) };
}

/** Sky-view texel (x, y), seen from `h` km up: the view's cosine `mu`, its azimuth from the sun, and its angle below
 *  the visible horizon, negative above it. */
export function skyViewAt(g: Geometry, { width, height }: Size, h: number, x: number, y: number) {
    const zenithHorizon = Math.acos(g.horizonMu(h));
    const v = unit(y, height);
    const t = v < 0.5 ? 1 - v * 2 : v * 2 - 1;
    const below = v < 0.5 ? -zenithHorizon * t * t : (Math.PI - zenithHorizon) * t * t;
    const s = unit(x, width);
    const azimuth = Math.acos(clamp(1 - 2 * s * s, -1, 1));
    return { mu: Math.cos(zenithHorizon + below), azimuth, below, zenithHorizon };
}

/** Where a view with cosine `mu` and `azimuth` from the sun, either side, lands in the sky-view table seen from `h`. */
export function skyViewTexel(g: Geometry, { width, height }: Size, h: number, mu: number, azimuth: number): Texel {
    const zenithHorizon = Math.acos(g.horizonMu(h));
    const below = Math.acos(clamp(mu, -1, 1)) - zenithHorizon;
    const y =
        below < 0
            ? (1 - Math.sqrt(-below / zenithHorizon)) * 0.5
            : Math.sqrt(below / (Math.PI - zenithHorizon)) * 0.5 + 0.5;
    const x = Math.sqrt(clamp(0.5 - Math.cos(azimuth) * 0.5, 0, 1));
    return { x: x * (width - 1), y: clamp(y, 0, 1) * (height - 1) };
}

const add = (a: Vec, b: Vec, s = 1) => a.map((c, i) => c + (b[i] ?? 0) * s);
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec) => a.map((c) => c / Math.hypot(...a));

/**
 * The view ray the sky-view table traces from `h` km up along `direction` (ENU, z up), bent by the air, in `samples`
 * steps: the path, the planet's center at (0, 0, -Rg - h) and the observer at the origin, and at the middle of each
 * step, where the two lookups happen, its position, altitude, the cosine of the sun's zenith angle there, and how far
 * along the path it lies, from 0 to 1. A ray going up takes steps growing with the square of the distance, as there.
 */
export function traceView(g: Geometry, h: number, direction: Vec, sunDirection: Vec, samples: number) {
    const mu = clamp(direction[2], -1, 1);
    const flat = [direction[0], direction[1], 0];
    const horizontal = Math.hypot(...flat) > 1e-9 ? normalize(flat) : [1, 0, 0];
    const r0 = g.Rg + h;
    const refractivity = (altitude: number) => g.n(altitude) - 1;
    const nr = g.n(h) * r0;
    const hitsGround = mu < 0 && nr * nr * (1 - mu * mu) <= (g.n(0) * g.Rg) ** 2;
    // The path in its vertical plane: x along the horizontal it starts in, y up from the observer.
    const altitudeAt = (p: Vec) => Math.hypot(p[0], r0 + p[1]) - g.Rg;
    const upAt = (p: Vec) => normalize([p[0], r0 + p[1]]);
    const turn = (p: Vec, d: Vec) => {
        const n = refractivity(altitudeAt(p));
        const up = upAt(p);
        // The ray equation: towards denser air, by the part of grad(n) / n across the ray.
        const k = -n / (g.HR * (1 + n));
        const gradient = [k * up[0], k * up[1]];
        const along = gradient[0] * d[0] + gradient[1] * d[1];
        return [gradient[0] - along * d[0], gradient[1] - along * d[1]];
    };
    const remaining = (p: Vec, d: Vec) => {
        const altitude = altitudeAt(p);
        const up = upAt(p);
        const m = d[0] * up[0] + d[1] * up[1];
        const r = g.Rg + altitude;
        if (!hitsGround) return g.toTop(r, m);
        const rhoSquared = altitude * (2 * g.Rg + altitude);
        if (m < 0 && r * r * m * m >= rhoSquared) return rhoSquared / (-r * m + Math.sqrt(r * r * m * m - rhoSquared));
        return Math.max(-r * m, 0);
    };
    const toWorld = (p: Vec) => add(add([0, 0, 0], horizontal, p[0]), [0, 0, 1], p[1]);
    const toWorldUp = (v: Vec) => add(add([0, 0, 0], horizontal, v[0]), [0, 0, 1], v[1]);
    let p: Vec = [0, 0];
    let d = [Math.sqrt(1 - mu * mu), mu];
    const path = [toWorld(p)];
    const points: { position: Vec; altitude: number; muS: number; along: number }[] = [];
    const n = samples;
    let traveled = 0;
    for (let i = 0; i < samples; i++) {
        const ds = remaining(p, d) * (mu >= 0 ? (2 * i + 1) / (n * n - i * i) : 1 / (n - i));
        const t0 = turn(p, d);
        const dm = normalize([d[0] + t0[0] * 0.5 * ds, d[1] + t0[1] * 0.5 * ds]);
        const middle = [p[0] + dm[0] * 0.5 * ds, p[1] + dm[1] * 0.5 * ds];
        const t1 = turn(middle, dm);
        const altitude = Math.max(altitudeAt(middle), 0);
        points.push({
            position: toWorld(middle),
            altitude,
            muS: clamp(dot(toWorldUp(upAt(middle)), sunDirection), -1, 1),
            along: traveled + ds / 2,
        });
        traveled += ds;
        p = [p[0] + dm[0] * ds, p[1] + dm[1] * ds];
        d = normalize([d[0] + t1[0] * ds, d[1] + t1[1] * ds]);
        path.push(toWorld(p));
    }
    for (const point of points) point.along /= traveled;
    return { path, points, hitsGround, center: [0, 0, -r0] };
}

/** A view ray's direction in ENU from its cosine `mu` and its `azimuth` from the sun, clockwise like a compass's. */
export function viewDirection(mu: number, azimuth: number, sunDirection: Vec) {
    const sunAzimuth = Math.atan2(sunDirection[0], sunDirection[1]);
    const s = Math.sqrt(Math.max(1 - mu * mu, 0));
    return [s * Math.sin(sunAzimuth + azimuth), s * Math.cos(sunAzimuth + azimuth), mu];
}

/** The signed azimuth from the sun of an ENU `direction`, in (-pi, pi]. */
export function azimuthFromSun(direction: Vec, sunDirection: Vec) {
    const a = Math.atan2(direction[0], direction[1]) - Math.atan2(sunDirection[0], sunDirection[1]);
    return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Every texel a picked ray touches, per table, as fractional texel coordinates; for a view ray also its trace. A view
 * ray reads one sky-view texel, and was built from two lookups at each of its samples: the transmittance towards the
 * sun, and the multiple scattering, both at the sample's altitude and sun angle. `sizes` holds each table's size, `h`
 * the observer's altitude in km.
 */
export type TableName = "transmittance" | "multiScattering" | "skyView";

export function lookups(
    g: Geometry,
    sizes: Record<TableName, Size>,
    h: number,
    sunDirection: Vec,
    ray: Ray,
    samples: number,
) {
    const texels: Record<TableName, Texel[]> = { transmittance: [], multiScattering: [], skyView: [] };
    if (ray.kind === "transmittance") {
        texels.transmittance.push(transmittanceTexel(g, sizes.transmittance, ray.r, ray.mu));
        return { texels };
    }
    if (ray.kind === "multiScattering") {
        texels.multiScattering.push(multiScatteringTexel(g, sizes.multiScattering, ray.altitude, ray.muS));
        return { texels };
    }
    const trace = traceView(g, h, viewDirection(ray.mu, ray.azimuth, sunDirection), sunDirection, samples);
    for (const { altitude, muS } of trace.points) {
        texels.transmittance.push(transmittanceTexel(g, sizes.transmittance, g.Rg + altitude, muS));
        texels.multiScattering.push(multiScatteringTexel(g, sizes.multiScattering, altitude, muS));
    }
    texels.skyView.push(skyViewTexel(g, sizes.skyView, h, ray.mu, ray.azimuth));
    return { texels, trace };
}
