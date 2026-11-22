/**
 * The veil the eye lays over everything near a bright source, in cd/m² per lux the source throws into the eye, at
 * `angle` degrees from it, held within 0.1° to 100°: CIE's general disability glare equation (CIE 146:2002), for an eye
 * of `age` years, 30 by default, and `pigment` 0 for very dark eyes, 0.5 brown, 1 blue-green, the default, 1.2 light
 * blue. The TypeScript twin of `hdVeilingGlare` in `wgsl.glare`, for plotting it or sizing a veil on the CPU.
 */
export function veilingGlare(angle: number, age = 30, pigment = 1): number {
    const theta = Math.min(Math.max(angle, 0.1), 100);
    const aging = 1 + (age / 62.5) ** 4;
    return 10 / theta ** 3 + (5 / theta ** 2 + (0.1 * pigment) / theta) * aging + 0.0025 * pigment;
}

/**
 * The veil `veilingGlare` lays on average over a field of `radius` degrees around a source of `sourceRadius` degrees, in
 * cd/m² per lux: the light an eye adapts to while it looks about a scene with the source in it, not straight at it.
 * The source's own disc veils nothing, but counts in the field's solid angle.
 */
export function meanVeilingGlare(radius: number, sourceRadius = 0.25, age = 30, pigment = 1): number {
    const inner = Math.max(sourceRadius, 0.1);
    if (radius <= inner) return 0;
    // Over log angle, where the glare's steep fall near the source spreads evenly: Simpson's rule in 128 steps.
    const steps = 128;
    const from = Math.log(inner);
    const step = (Math.log(Math.min(radius, 180)) - from) / steps;
    let sum = 0;
    for (let i = 0; i <= steps; i++) {
        const theta = Math.exp(from + i * step);
        const weight = i === 0 || i === steps ? 1 : i % 2 === 1 ? 4 : 2;
        sum += weight * veilingGlare(theta, age, pigment) * Math.sin((theta * Math.PI) / 180) * theta;
    }
    const integral = ((sum * step) / 3) * 2 * Math.PI * (Math.PI / 180);
    return integral / (2 * Math.PI * (1 - Math.cos((Math.min(radius, 180) * Math.PI) / 180)));
}
