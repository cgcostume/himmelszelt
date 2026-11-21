/**
 * Atmospheric refraction, traced through the model's own air: its refractive index n = 1 + refractivity · density
 * falls off with the Rayleigh layer, and every ray bends towards the denser air below it. This is the CPU twin of the
 * ray the WGSL follows (`dkPathAdvance` in `common.wgsl`), for where the sun shows, without a GPU.
 *
 * No fit is involved. Near the ground it lands within a few percent of Bennett's (Meeus 16.3), which a test pins, and
 * it holds at any height, looking up or down, from inside the atmosphere or through it from space.
 */
import type { AtmosphereModel } from "./model.js";
import { luminanceScale, spectrumToRgb } from "./model.js";

/**
 * Refractivity n - 1 of dry air around 550 nm, proportional to its density: 2.778e-4 at the standard atmosphere's
 * 15 °C and 1013.25 hPa (Edlén 1966). Colder or denser air bends light more.
 */
export function airRefractivity(temperatureC = 15, pressureHPa = 1013.25): number {
    return 2.778e-4 * (pressureHPa / 1013.25) * (288.15 / (273.15 + temperatureC));
}

/** Enough for well below an arcsecond: the path bends by at most a degree, mostly around its lowest point. */
export const TRACE_SAMPLES = 200;

/** An upper bound on the bending in radians, as in the transmittance table: 1.1 times twice the horizon's. */
function refractionMargin(model: AtmosphereModel): number {
    return (
        1.1 * model.refractivity * Math.sqrt((2 * Math.PI * model.planet.groundRadiusKm) / model.rayleigh.scaleHeightKm)
    );
}

/** A ray through the air: how far it bent, in radians, the optical depth it passed at the four wavelengths, and the
 *  air it crossed, in zenith columns of the molecules from sea level. */
export interface TracedRay {
    bend: number;
    depth: [number, number, number, number];
    airmass: number;
    /** How far from the observer the ray enters the air, in km: 0 from within it. */
    start: number;
}

/**
 * Follows a ray from altitude `h` (km) with the local cosine `mu` until it leaves the atmosphere, or returns `null`
 * when it ends on the ground. Through its vertical plane: x along the horizontal it starts in, y up. `path` takes the
 * ray's points in that plane, the start and the end of each of the `TRACE_SAMPLES` steps, x and y in km.
 */
function trace(model: AtmosphereModel, h: number, mu: number, path?: Float64Array): TracedRay | null {
    const { groundRadiusKm: rg, thicknessKm } = model.planet;
    const { rayleigh, mie, ozone, refractivity: k } = model;
    const scaleHeight = rayleigh.scaleHeightKm;
    const rt = rg + thicknessKm;
    const r0 = rg + h;

    // Bouguer's invariant n r sin(z) decides whether the ray reaches the ground, as in `dkIntersectsGround`.
    const n = (altitude: number) => 1 + k * Math.exp(-Math.max(altitude, 0) / scaleHeight);
    const nr = n(h) * r0;
    if (mu < 0 && nr * nr * (1 - mu * mu) <= (n(0) * rg) ** 2) return null;

    const [r0b, r1b, r2b, r3b] = rayleigh.beta;
    const [m0, m1, m2, m3] = mie.betaExtinction;
    const [o0, o1, o2, o3] = ozone.betaAbsorption;
    // The loop runs on plain numbers, no arrays: a table of these rays is traced whenever the observer's height moves.
    let px = 0;
    let py = 0;
    let dx = Math.sqrt(Math.max(1 - mu * mu, 0));
    let dy = mu;
    let depth0 = 0;
    let depth1 = 0;
    let depth2 = 0;
    let depth3 = 0;
    let airmass = 0;
    for (let i = 0; i < TRACE_SAMPLES; ++i) {
        let cy = r0 + py;
        let r = Math.sqrt(px * px + cy * cy);
        const localMu = (px * dx + cy * dy) / r;
        const remaining = Math.max(-r * localMu + Math.sqrt(Math.max(r * r * (localMu * localMu - 1) + rt * rt, 0)), 0);
        const ds = remaining / (TRACE_SAMPLES - i);
        if (path) {
            path[2 * i] = px;
            path[2 * i + 1] = py;
        }

        // How the direction turns per km, the ray equation: towards denser air, by the part of grad(n) / n across the
        // ray. By the midpoint rule: half a step by the turn at the start, the whole one by the turn found there.
        let refractivity = k * Math.exp(-Math.max(r - rg, 0) / scaleHeight);
        let g = -refractivity / (scaleHeight * (1 + refractivity));
        let along = (g * (px * dx + cy * dy)) / r;
        let mx = dx + ((g * px) / r - along * dx) * 0.5 * ds;
        let my = dy + ((g * cy) / r - along * dy) * 0.5 * ds;
        let length = Math.sqrt(mx * mx + my * my);
        mx /= length;
        my /= length;
        const hx = px + mx * 0.5 * ds;
        const hy = py + my * 0.5 * ds;
        cy = r0 + hy;
        r = Math.sqrt(hx * hx + cy * cy);
        const altitude = Math.max(r - rg, 0);
        const molecules = Math.exp(-altitude / scaleHeight);
        refractivity = k * molecules;
        g = -refractivity / (scaleHeight * (1 + refractivity));
        along = (g * (hx * mx + cy * my)) / r;
        const tx = (g * hx) / r - along * mx;
        const ty = (g * cy) / r - along * my;

        const aerosols = Math.exp(-altitude / mie.scaleHeightKm);
        const ozoneAt = Math.max(0, 1 - Math.abs(altitude - ozone.centerAltitudeKm) / (ozone.widthKm / 2));
        depth0 += (r0b * molecules + m0 * aerosols + o0 * ozoneAt) * ds;
        depth1 += (r1b * molecules + m1 * aerosols + o1 * ozoneAt) * ds;
        depth2 += (r2b * molecules + m2 * aerosols + o2 * ozoneAt) * ds;
        depth3 += (r3b * molecules + m3 * aerosols + o3 * ozoneAt) * ds;
        airmass += (molecules * ds) / scaleHeight;

        px += mx * ds;
        py += my * ds;
        dx += tx * ds;
        dy += ty * ds;
        length = Math.sqrt(dx * dx + dy * dy);
        dx /= length;
        dy /= length;
    }
    if (path) {
        path[2 * TRACE_SAMPLES] = px;
        path[2 * TRACE_SAMPLES + 1] = py;
    }
    // The angle between the start and exit directions, both in the start's frame.
    const [sx, sy] = [Math.sqrt(Math.max(1 - mu * mu, 0)), mu];
    return {
        bend: -Math.atan2(sx * dy - sy * dx, sx * dx + sy * dy),
        depth: [depth0, depth1, depth2, depth3],
        airmass,
        start: 0,
    };
}

/**
 * The ray seen at `apparentAltitude` degrees from `observerHeightM` meters up, traced from where it is in the air: null
 * on the ground, no bend and no air past the atmosphere from space. `path` as `trace` takes it, around the point the
 * ray starts in the air at, `start` km along it from the observer.
 */
export function traceSeen(
    model: AtmosphereModel,
    observerHeightM: number,
    apparentAltitude: number,
    path?: Float64Array,
): TracedRay | null {
    const a = (apparentAltitude * Math.PI) / 180;
    const h = observerHeightM / 1000;
    const { groundRadiusKm: rg, thicknessKm } = model.planet;
    if (h <= thicknessKm) return trace(model, h, Math.sin(a), path);

    // From space: straight to where the ray enters the atmosphere, if it does.
    const r = rg + h;
    const b = r * Math.sin(a);
    const discriminant = b * b - (h - thicknessKm) * (r + rg + thicknessKm);
    if (discriminant < 0 || b >= 0) {
        path?.fill(0);
        return { bend: 0, depth: [0, 0, 0, 0], airmass: 0, start: 0 };
    }
    const t = -b - Math.sqrt(discriminant);
    const [ex, ey] = [t * Math.cos(a), r + t * Math.sin(a)];
    const ray = trace(model, thicknessKm, (ex * Math.cos(a) + ey * Math.sin(a)) / Math.hypot(ex, ey), path);
    return ray && { ...ray, start: t };
}

/**
 * The apparent altitude of the horizon the air shows from `observerHeightM` meters up, in degrees: the lowest ray that
 * still reaches space, by Bouguer's invariant, as `refractionAngle` and the passes decide it. A little below the level
 * from the ground, 20° below it from the space station's orbit.
 */
export function apparentHorizon(model: AtmosphereModel, observerHeightM: number): number {
    const { groundRadiusKm: rg, thicknessKm } = model.planet;
    const n = (altitudeKm: number) => 1 + model.refractivity * Math.exp(-altitudeKm / model.rayleigh.scaleHeightKm);
    const h = Math.max(observerHeightM / 1000, 0);
    return (-Math.acos(Math.min((n(0) * rg) / (n(Math.min(h, thicknessKm)) * (rg + h)), 1)) * 180) / Math.PI;
}

/**
 * How far the air bends a ray seen at `apparentAltitude` degrees from `observerHeightM` meters up, in degrees: where it
 * leaves the atmosphere lies that much lower. `null` for a ray that ends on the ground. From above the atmosphere, the
 * ray is followed from where it enters it.
 */
export function refractionAngle(
    model: AtmosphereModel,
    observerHeightM: number,
    apparentAltitude: number,
): number | null {
    const ray = traceSeen(model, observerHeightM, apparentAltitude);
    return ray === null ? null : (ray.bend * 180) / Math.PI;
}

/**
 * What the air lets through of sunlight along a ray seen at `apparentAltitude` degrees from `observerHeightM` meters
 * up, per channel of linear sRGB: the light of a body there, the Moon's or a planet's, dimmed and reddened, traced along
 * the same bent path as `refractionAngle`, so it agrees with the transmittance table the sky is drawn from. `null` for a
 * ray that ends on the ground. The CPU twin of the table's lookup, for a few rays per frame without a round trip.
 * `passes` is how often the light crosses that air: 2 for sunlight grazing the ground at `observerHeightM`, in through
 * the air and out again, as into Earth's shadow. It multiplies the optical depth before the spectrum becomes a color,
 * which squaring the color would not do: a channel as wide as sRGB's would come out several percent greener.
 */
export function airTransmittance(
    model: AtmosphereModel,
    observerHeightM: number,
    apparentAltitude: number,
    passes = 1,
): [number, number, number] | null {
    const ray = traceSeen(model, observerHeightM, apparentAltitude);
    return ray === null ? null : sunlightThrough(model)(ray.depth, passes);
}

/** What is left of sunlight behind an optical depth at the four wavelengths, per channel of linear sRGB, for a model. */
export function sunlightThrough(model: AtmosphereModel) {
    const toRgb = spectrumToRgb(model);
    const rgb = (spectrum: readonly number[]) =>
        toRgb.map((row) => row.reduce((sum, m, j) => sum + m * (spectrum[j] ?? 0), 0));
    const sun = rgb(model.solarSpectrum);
    return (depth: readonly number[], passes = 1) => {
        const through = rgb(model.solarSpectrum.map((s, k) => s * Math.exp(-passes * (depth[k] ?? 0))));
        return through.map((c, i) => Math.max(c, 0) / Math.max(sun[i] ?? 1, 1e-12)) as [number, number, number];
    };
}

/**
 * The illuminance a light in the true (geometric) `direction` gives at `observerHeightM` meters up, in lux per channel of
 * linear sRGB: `illuminance` above the air, the Sun's by default, through it along the bent path from where it shows,
 * zero once even the most bent ray ends on the ground. The CPU twin of the sky pass' `sunIlluminance()` and
 * `moonIlluminance()`, for the same frame without a round trip; it traces the bent ray where the meter takes the
 * table's straight one, a few percent apart within a degree of the horizon. ENU, like every direction here.
 */
export function lightThroughAir(
    model: AtmosphereModel,
    direction: readonly [number, number, number],
    observerHeightM: number,
    illuminance = model.solarIlluminance,
): [number, number, number] {
    const apparent = apparentDirection(direction, model, observerHeightM);
    const altitude = (Math.asin(Math.max(-1, Math.min(1, apparent[2]))) * 180) / Math.PI;
    const ray = traceSeen(model, observerHeightM, altitude);
    if (ray === null) return [0, 0, 0];
    const scale = (luminanceScale(model) * illuminance) / model.solarIlluminance;
    const through = model.solarSpectrum.map((s, k) => s * Math.exp(-(ray.depth[k] ?? 0)));
    return spectrumToRgb(model).map(
        (row) =>
            Math.max(
                row.reduce((sum, m, j) => sum + m * (through[j] ?? 0), 0),
                0,
            ) * scale,
    ) as [number, number, number];
}

/**
 * Where a body in the true (geometric) `direction` shows, lifted by the air, as seen from `observerHeightM` meters up:
 * for pointing a camera at the sun, or marking where it shows. ENU, like every direction here. Solved by bisection,
 * since the bending is traced from the apparent direction: its true one only grows with it. A body hidden behind the
 * planet, below even the most bent ray, is returned as it is.
 */
export function apparentDirection(
    direction: readonly [number, number, number],
    model: AtmosphereModel,
    observerHeightM: number,
): [number, number, number] {
    const [x, y, z] = direction;
    const horizontal = Math.hypot(x, y);
    if (horizontal < 1e-9 || model.refractivity <= 0) return [x, y, z];

    const trueAltitude = Math.atan2(z, horizontal);
    const lowered = (a: number) => {
        const bend = refractionAngle(model, observerHeightM, (a * 180) / Math.PI);
        return bend === null ? Number.NEGATIVE_INFINITY : a - (bend * Math.PI) / 180;
    };
    let [low, high] = [trueAltitude, Math.min(trueAltitude + refractionMargin(model), Math.PI / 2)];
    for (let i = 0; i < 40; ++i) {
        const middle = (low + high) / 2;
        if (lowered(middle) < trueAltitude) low = middle;
        else high = middle;
    }
    const altitude = (low + high) / 2;
    if (lowered(altitude) === Number.NEGATIVE_INFINITY) return [x, y, z];
    const cosAltitude = Math.cos(altitude);
    return [(x / horizontal) * cosAltitude, (y / horizontal) * cosAltitude, Math.sin(altitude)];
}
