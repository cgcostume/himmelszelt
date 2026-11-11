// What the Moon pass takes. Structs only, no binding: the pass binds them where it likes. Directions ENU (x east,
// y north, z up) and unit length, lengths in km, angles in radians, light in lux, luminance in cd/m².

// What changes from frame to frame.
struct NgParams {
    // The camera: turns pixels back into rays, as dunstkreis' sky pass, column major, no translation.
    inverseViewProjection: mat4x4f,

    // The Moon: turns a direction in the observer's frame into the Moon's own, selenographic, from `moonOrientation`:
    // x towards 0° longitude, y towards 90° east, z towards the north pole. Towards its center as it shows, and its
    // apparent angular radius.
    orientation: mat3x3f,
    direction: vec3f,
    angularRadius: f32,

    // The light: from the Moon's center towards the Sun, and the Sun's illuminance at the Moon; towards Earth's center,
    // where earthshine comes from, and Earth's illuminance at the Moon.
    sunDirection: vec3f,
    sunIlluminance: f32,
    earthDirection: vec3f,
    earthshine: f32,

    // What the air lets through along the line of sight, per channel, where the air's table does not say it per ray;
    // and the bend of the projection, as dunstkreis' sky pass.
    transmittance: vec3f,
    projectionDistance: f32,

    // What luminance is multiplied by, 1 / (1.2 * 2^EV100); below which z of a ray the ground hides the Moon; the
    // Moon's radius; and the Sun's angular radius.
    exposure: f32,
    horizonZ: f32,
    moonRadiusKm: f32,
    sunAngularRadius: f32,

    // The color map, decoded, made normal albedo per channel: its scale, and the Moon's tint, or gray. Without a map
    // the disc is `albedo` all over.
    albedoMatrix: mat3x3f,
    albedo: f32,

    // What the frame draws, NG_FLAG_*.
    flags: u32,

    // The shadow map, from `shadow.comp.wgsl`: the Sun's direction in the Moon's frame it was made for, and a texel's
    // angle on the unit sphere; the axis its longitudes about the Sun count from, and the first longitude of its
    // window; the window's first angle from the subsolar point, its width and height in texels, and the Sun's angular
    // radius it casts with, 0 a point.
    shadowSun: vec4f,
    shadowEast: vec4f,
    shadowWindow: vec4f,

    // Where the detail strip lies in the whole maps' uv: its west, north, east and south edges.
    detailRegion: vec4f,

    // Earth's shadow, with NG_FLAG_ECLIPSE: its axis, away from the Sun, and how bright the light Earth's air bends
    // into it, 1 for a typical eclipse; the Moon's center from Earth's, and the penumbra's radius there; Earth's radius.
    shadowAxis: vec3f,
    umbraLight: f32,
    moonCenterKm: vec3f,
    penumbraKm: f32,
    earthRadiusKm: f32,

    // The air's table, with NG_FLAG_AIR: the apparent altitude of its first entry, and the step between them.
    refractionFrom: f32,
    refractionStep: f32,

    // The air's shimmer, for `shimmer.comp.wgsl`: the image's rms wander, the time in seconds the turbulence has
    // drifted by, how far the air spreads green from red and blue, and the finest cell on the sky; how much its larger
    // cells move patches of the image as a whole and its smaller make it boil within them, and how fast the wind
    // carries them across the sky, in radians a second.
    shimmer: vec4f,
    shimmerParts: vec4f,
}

// What changes only with the air towards the Moon or with an eclipse: written when it changes.
struct NgTables {
    // How far the air bends a ray down, at NG_REFRACTION_SAMPLES apparent altitudes from `refractionFrom` on by
    // `refractionStep`, four to a vector; and what it lets through at each, per channel.
    bends: array<vec4f, 8>,
    airTransmittance: array<vec4f, 32>,

    // The sunlight Earth's air bends into its shadow, as a share of the sunlight per channel, at NG_UMBRA_SAMPLES
    // distances from the shadow's axis, from the axis to the penumbra's edge.
    umbra: array<vec4f, 64>,
}

const NG_REFRACTION_SAMPLES: u32 = 32u;
const NG_UMBRA_SAMPLES: u32 = 64u;

// What a frame draws: the color map, the relief from the heights, the shadows it casts, the relief displaced where it
// shows rather than only shaded, earthshine, the air's bending and dimming per ray, and Earth's shadow.
const NG_FLAG_COLOR: u32 = 1u;
const NG_FLAG_RELIEF: u32 = 2u;
const NG_FLAG_SHADOWS: u32 = 4u;
const NG_FLAG_DISPLACE: u32 = 8u;
const NG_FLAG_EARTHSHINE: u32 = 16u;
const NG_FLAG_AIR: u32 = 32u;
const NG_FLAG_ECLIPSE: u32 = 64u;
