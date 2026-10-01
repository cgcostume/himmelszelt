import { type AtmosphereModel, atmosphereTopRadiusKm, luminanceScale, spectrumToRgb } from "./model.js";
import { reflectanceAt } from "./spectral.js";

/** Size of the `DkAtmosphere` uniform block, in bytes: six vec4s, a mat4x3, eight scalars. */
export const ATMOSPHERE_UNIFORM_SIZE = 192;

/**
 * Packs a model into the `DkAtmosphere` layout declared by `wgsl/atmosphere.wgsl`, ready for `writeBuffer`.
 * The field order here mirrors that struct exactly and a test pins the two together, since nothing in the
 * toolchain would otherwise catch them drifting apart.
 *
 * Pass `target` to write into an existing buffer, e.g. a subrange of a larger uniform block of your own.
 */
export function atmosphereUniformData(model: AtmosphereModel, target?: Float32Array): Float32Array {
    const data = target ?? new Float32Array(ATMOSPHERE_UNIFORM_SIZE / 4);
    const scale = luminanceScale(model);

    data.set(model.rayleigh.beta, 0);
    data.set(model.mie.betaScattering, 4);
    data.set(model.mie.betaExtinction, 8);
    data.set(model.ozone.betaAbsorption, 12);
    data.set(
        model.solarSpectrum.map((e) => e * scale),
        16,
    );
    data.set(
        model.wavelengths.map((w) => reflectanceAt(model.groundAlbedo, w)),
        20,
    );
    // mat4x3f: four columns, one per wavelength, each a vec3 padded to 16 bytes.
    const matrix = spectrumToRgb(model);
    for (let j = 0; j < 4; ++j)
        data.set(
            [0, 1, 2].map((i) => matrix[i]?.[j] as number),
            24 + j * 4,
        );

    data[40] = model.planet.groundRadiusKm;
    data[41] = atmosphereTopRadiusKm(model);
    data[42] = model.mie.g;
    data[43] = model.rayleigh.scaleHeightKm;
    data[44] = model.mie.scaleHeightKm;
    data[45] = model.ozone.centerAltitudeKm;
    data[46] = model.ozone.widthKm / 2;
    data[47] = model.refractivity;

    return data;
}
