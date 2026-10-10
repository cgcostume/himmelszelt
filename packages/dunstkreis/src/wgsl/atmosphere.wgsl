// The atmosphere's physical parameters as a uniform block, so a consumer can bind one buffer and compose
// these functions into their own shader. `@himmelszelt/dunstkreis` fills it via `atmosphereUniformData()`.
//
// Nothing here declares a binding: the struct is passed to every function by value instead. That keeps the
// snippet free of any assumption about group or binding indices, which is what makes it droppable into an
// existing pipeline. Declare the `var<uniform>` yourself, at whatever group and binding suit you.
//
// Light is computed at four wavelengths, one per vec4 component, red to blue, and turned into linear sRGB by
// `toRgb` at the end. 192 bytes; `atmosphereUniformData()` writes exactly this layout and a test pins the two together.
struct DkAtmosphere {
    // Rayleigh scattering coefficient, per km. Doubles as its extinction: air does not absorb.
    betaR: vec4f,
    // Mie scattering coefficient, per km.
    betaMSca: vec4f,
    // Mie extinction coefficient, i.e. scattering plus absorption.
    betaMEx: vec4f,
    // Ozone absorption coefficient, per km. Ozone only absorbs, so it has no scattering counterpart.
    betaOAbs: vec4f,
    // The sun's spectral irradiance above the atmosphere, scaled so `toRgb` turns it into its illuminance in lux:
    // everything computed from it comes out in cd/m².
    solarIlluminance: vec4f,
    // The ground's albedo at the four wavelengths: how much of the light it receives it reflects, diffusely.
    groundAlbedo: vec4f,
    // The four wavelengths to linear sRGB, a matrix fitted to sky spectra: rgb = toRgb * spectral.
    toRgb: mat4x3f,

    // Ground radius and the radius of the top of the atmosphere, in km. The observer must stay below the top.
    Rg: f32,
    Rt: f32,
    // Cornette-Shanks asymmetry factor. Positive is forward-scattering.
    mieG: f32,
    // Rayleigh scale height, in km.
    HR: f32,

    // Mie scale height, in km.
    HM: f32,
    // Center altitude of the ozone layer, in km, and half its linear falloff width.
    ozoneCenter: f32,
    ozoneHalfWidth: f32,
    // Refractivity n - 1 of the air on the ground, falling off with its density; 0 leaves every ray straight.
    refractivity: f32,
}

// A spectral quantity, light or a transmittance at the four wavelengths, in linear sRGB.
fn dkToRgb(a: DkAtmosphere, spectral: vec4f) -> vec3f {
    return a.toRgb * spectral;
}
