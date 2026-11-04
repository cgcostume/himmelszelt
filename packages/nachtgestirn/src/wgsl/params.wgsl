// What the Moon pass takes per frame. A struct only, no binding: the pass binds it where it likes. Directions ENU
// (x east, y north, z up) and unit length, lengths in km, light in lux, luminance in cd/m².

struct NbParams {
    // Turns pixels back into rays, as dunstkreis' sky pass: column major, no translation.
    inverseViewProjection: mat4x4f,
    // Turns a direction in the observer's frame into the Moon's own, selenographic: x towards 0° longitude, y towards
    // 90° east, z towards the north pole. From `moonOrientation`.
    orientation: mat3x3f,
    // Towards the Moon's center as it shows, and its apparent angular radius in radians.
    direction: vec3f,
    angularRadius: f32,
    // From the Moon's center towards the Sun, and the Sun's illuminance at the Moon in lux.
    sunDirection: vec3f,
    sunIlluminance: f32,
    // What the air lets through along the line of sight, per channel, and Earth's illuminance at the Moon in lux.
    transmittance: vec3f,
    earthshine: f32,
    // Earth's shadow: its axis, away from the Sun, through Earth's center, and the bend of the projection.
    shadowAxis: vec3f,
    projectionDistance: f32,
    // The Moon's center from Earth's center, in km, and the umbra's radius there.
    moonCenterKm: vec3f,
    umbraKm: f32,
    penumbraKm: f32,
    sunAngularRadius: f32,
    earthRadiusKm: f32,
    moonRadiusKm: f32,
    // What luminance is multiplied by, 1 / (1.2 * 2^EV100), and below which z of a ray the Moon is hidden.
    exposure: f32,
    horizonZ: f32,
    // What the color map is multiplied by to read as normal albedo, and the albedo without a map; per channel, below.
    albedoScale: f32,
    albedo: f32,
    // 1 the color map, 2 the relief, 4 the eclipse, 8 the relief's shadows.
    flags: u32,
    // The reflectance law: 0 Hapke's lunar law after Jensen et al., 1 Lambert's, to compare.
    law: u32,
    // How strong the umbra's refracted light is, 1 for a typical eclipse.
    umbraLight: f32,
    // The refraction table's spacing in apparent altitude, in radians: 0 for no table, the rays taken as they are.
    refractionStep: f32,
    // From the Moon's center towards Earth's, where earthshine comes from: a degree off the view at most.
    earthDirection: vec3f,
    // The apparent altitude of the table's first entry, in radians.
    refractionFrom: f32,
    // How far the air bends a ray down, in radians, at NB_REFRACTION_SAMPLES apparent altitudes over the disc's band,
    // from `refractionFrom` on by `refractionStep`.
    refraction: array<vec4f, 8>,
    // What the color map is multiplied by per channel besides `albedoScale`: from its own mean color to the Moon's.
    albedoTint: vec3f,
}

const NB_REFRACTION_SAMPLES: u32 = 32u;

const NB_FLAG_COLOR: u32 = 1u;
const NB_FLAG_RELIEF: u32 = 2u;
const NB_FLAG_ECLIPSE: u32 = 4u;
const NB_FLAG_SHADOWS: u32 = 8u;
