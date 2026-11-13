/**
 * Atmospheric refraction, traced through the model's own air: its refractive index n = 1 + refractivity · density
 * falls off with the Rayleigh layer, and every ray bends towards the denser air below it. This is the CPU twin of the
 * ray the WGSL follows (`dkPathAdvance` in `common.wgsl`), for where the sun shows, without a GPU.
 *
 * No fit is involved. Near the ground it lands within a few percent of Bennett's (Meeus 16.3), which a test pins, and
 * it holds at any height, looking up or down, from inside the atmosphere or through it from space.
 */
import type { AtmosphereModel, Spectral } from "./model.js";
import { spectrumToRgb } from "./model.js";

/**
 * Refractivity n - 1 of dry air around 550 nm, proportional to its density: 2.778e-4 at the standard atmosphere's
 * 15 °C and 1013.25 hPa (Edlén 1966). Colder or denser air bends light more.
 */
export function airRefractivity(temperatureC = 15, pressureHPa = 1013.25): number {
    return 2.778e-4 * (pressureHPa / 1013.25) * (288.15 / (273.15 + temperatureC));
}

type Vec2 = [number, number];

/** Enough for well below an arcsecond: the path bends by at most a degree, mostly around its lowest point. */
const SAMPLES = 200;

/** An upper bound on the bending in radians, as in the transmittance table: 1.1 times twice the horizon's. */
function refractionMargin(model: AtmosphereModel): number {
    return (
        1.1 * model.refractivity * Math.sqrt((2 * Math.PI * model.planet.groundRadiusKm) / model.rayleigh.scaleHeightKm)
    );
}

/** The air's extinction at an altitude in km, per km at the four wavelengths: molecules, aerosols and ozone. */
function extinctionAt(model: AtmosphereModel, altitude: number): Spectral {
    const { rayleigh, mie, ozone } = model;
    const molecules = Math.exp(-altitude / rayleigh.scaleHeightKm);
    const aerosols = Math.exp(-altitude / mie.scaleHeightKm);
    const o3 = Math.max(0, 1 - Math.abs(altitude - ozone.centerAltitudeKm) / (ozone.widthKm / 2));
    return rayleigh.beta.map(
        (b, i) => b * molecules + (mie.betaExtinction[i] ?? 0) * aerosols + (ozone.betaAbsorption[i] ?? 0) * o3,
    ) as unknown as Spectral;
}

/**
 * How far a ray bends, in radians, from altitude `h` (km) with the local cosine `mu` until it leaves the atmosphere, and
 * the optical depth it passes at the four wavelengths, or `null` when it ends on the ground. Followed through its
 * vertical plane: x along the horizontal it starts in, y up.
 */
function trace(model: AtmosphereModel, h: number, mu: number): { bend: number; depth: number[] } | null {
    const { groundRadiusKm: rg, thicknessKm } = model.planet;
    const scaleHeight = model.rayleigh.scaleHeightKm;
    const rt = rg + thicknessKm;
    const r0 = rg + h;

    // Bouguer's invariant n r sin(z) decides whether the ray reaches the ground, as in `dkIntersectsGround`.
    const n = (altitude: number) => 1 + model.refractivity * Math.exp(-Math.max(altitude, 0) / scaleHeight);
    const nr = n(h) * r0;
    if (mu < 0 && nr * nr * (1 - mu * mu) <= (n(0) * rg) ** 2) return null;

    const altitudeAt = ([x, y]: Vec2) => Math.hypot(x, r0 + y) - rg;
    const upAt = ([x, y]: Vec2): Vec2 => {
        const r = Math.hypot(x, r0 + y);
        return [x / r, (r0 + y) / r];
    };
    const turn = (p: Vec2, [dx, dy]: Vec2): Vec2 => {
        const refractivity = n(altitudeAt(p)) - 1;
        const [ux, uy] = upAt(p);
        const g = -refractivity / (scaleHeight * (1 + refractivity));
        const along = g * (ux * dx + uy * dy);
        return [g * ux - along * dx, g * uy - along * dy];
    };
    const normalize = ([x, y]: Vec2): Vec2 => {
        const length = Math.hypot(x, y);
        return [x / length, y / length];
    };

    let position: Vec2 = [0, 0];
    let direction: Vec2 = [Math.sqrt(Math.max(1 - mu * mu, 0)), mu];
    const depth = [0, 0, 0, 0];
    for (let i = 0; i < SAMPLES; ++i) {
        const r = rg + altitudeAt(position);
        const [ux, uy] = upAt(position);
        const localMu = ux * direction[0] + uy * direction[1];
        const remaining = Math.max(-r * localMu + Math.sqrt(Math.max(r * r * (localMu * localMu - 1) + rt * rt, 0)), 0);
        const ds = remaining / (SAMPLES - i);

        const [tx, ty] = turn(position, direction);
        const middle = normalize([direction[0] + tx * 0.5 * ds, direction[1] + ty * 0.5 * ds]);
        const halfway: Vec2 = [position[0] + middle[0] * 0.5 * ds, position[1] + middle[1] * 0.5 * ds];
        const [mx, my] = turn(halfway, middle);
        extinctionAt(model, Math.max(altitudeAt(halfway), 0)).forEach((e, k) => {
            depth[k] = (depth[k] ?? 0) + e * ds;
        });
        position = [position[0] + middle[0] * ds, position[1] + middle[1] * ds];
        direction = normalize([direction[0] + mx * ds, direction[1] + my * ds]);
    }
    // The angle between the start and exit directions, both in the start's frame.
    const [sx, sy] = [Math.sqrt(Math.max(1 - mu * mu, 0)), mu];
    return {
        bend: Math.atan2(sx * direction[1] - sy * direction[0], sx * direction[0] + sy * direction[1]) * -1,
        depth,
    };
}

/** The ray seen at `apparentAltitude` degrees from `observerHeightM` meters up, traced from where it is in the air:
 *  null on the ground, `{ bend: 0, depth: none }` past the atmosphere from space. */
function traceSeen(model: AtmosphereModel, observerHeightM: number, apparentAltitude: number) {
    const a = (apparentAltitude * Math.PI) / 180;
    const h = observerHeightM / 1000;
    const { groundRadiusKm: rg, thicknessKm } = model.planet;
    if (h <= thicknessKm) return trace(model, h, Math.sin(a));

    // From space: straight to where the ray enters the atmosphere, if it does.
    const r = rg + h;
    const b = r * Math.sin(a);
    const discriminant = b * b - (h - thicknessKm) * (r + rg + thicknessKm);
    if (discriminant < 0 || b >= 0) return { bend: 0, depth: [0, 0, 0, 0] };
    const t = -b - Math.sqrt(discriminant);
    const [ex, ey] = [t * Math.cos(a), r + t * Math.sin(a)];
    return trace(model, thicknessKm, (ex * Math.cos(a) + ey * Math.sin(a)) / Math.hypot(ex, ey));
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
    if (ray === null) return null;
    const toRgb = spectrumToRgb(model);
    const rgb = (spectrum: readonly number[]) =>
        toRgb.map((row) => row.reduce((sum, m, j) => sum + m * (spectrum[j] ?? 0), 0));
    const sun = rgb(model.solarSpectrum);
    const through = rgb(model.solarSpectrum.map((s, k) => s * Math.exp(-passes * (ray.depth[k] ?? 0))));
    return through.map((c, i) => Math.max(c, 0) / Math.max(sun[i] ?? 1, 1e-12)) as [number, number, number];
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
