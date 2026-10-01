// What the per-frame passes share: one uniform with everything that may change per frame, and the light meter's
// buffer, written on the GPU and read there. Structs only, no bindings: each pass binds them where it likes.

struct DkSkyParams {
    // Unit vector towards the sun in the observer's local frame, z up. The true direction: the view rays are bent
    // by the air, and an already refracted sun would move twice.
    sunDirection: vec3f,
    // Observer altitude above the ground, in km. Not the radius, which f32 resolves to only ~0.5 m. Above the top of
    // the atmosphere, every pixel is raymarched from where its ray enters it.
    observerAltitude: f32,
    inverseViewProjection: mat4x4f,
    // What luminance in cd/m² is multiplied by, 1 / (1.2 * 2^EV100), unless it is metered.
    exposure: f32,
    // The Sun's apparent angular radius, in radians.
    sunAngularRadius: f32,
    // The projection's d, from 0 (the matrix's own perspective) to 1 (stereographic), see dkProjectRay.
    projectionDistance: f32,
    // Added to the metered exposure, in EV: positive brightens. The keys' ramp over the day included.
    exposureCompensation: f32,
    // The EV100s metering may expose with: night stays dark instead of being lifted to day.
    autoExposureRange: vec2f,
}

struct DkMetering {
    // log2 of the geometric mean luminance, in cd/m².
    log2Luminance: f32,
    // The sun's illuminance at the observer, per channel in lux: what reaches it through the air, for a renderer that
    // lights its scene by the sun as a light of its own.
    sunIlluminance: vec3f,
    // The sky's irradiance on the ground at the four wavelengths, gathered by dkGroundIrradiance.
    groundLight: vec4f,
    // How far the sky-view table's rays bent on their way out, per row, as the sine of the angle: the same for every
    // azimuth. The sky pass turns a view ray by it to find where the sun disc shows; 0 for rows on the ground.
    bend: array<f32>,
}
