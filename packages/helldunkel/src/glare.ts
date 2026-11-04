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
