// What the star passes take per frame. A struct only, no binding: the pass binds it where it likes. Directions ENU
// (x east, y north, z up) and unit length, angles in radians, light in lux, luminance in cd/m².

struct ShParams {
    // Turns pixels back into rays, as dunstkreis' sky pass: column major, no translation.
    inverseViewProjection: mat4x4f,
    // Turns a star's J2000 equatorial unit vector into the observer's ENU frame: precession and the sidereal time in
    // one, sternzeit's `stars.horizontalMatrix`.
    skyRotation: mat3x3f,
    // What luminance is multiplied by, 1 / (1.2 * 2^EV100); the z of a ray below which the ground hides the sky.
    exposure: f32,
    horizonZ: f32,
    // Years since J2000.0, for the stars' proper motion, and the width of a star's image on the target, the standard
    // deviation of its Gaussian point spread, in pixels: the viewer's eye blurs a point on the screen, not the sky.
    years: f32,
    psfPixels: f32,
    // The apparent altitude of the lowest ray that reaches space, below which a ray ends on the ground; the time in
    // seconds, for the twinkling; how strongly the stars twinkle, 1 as the eye sees it; how strong the eye's veil
    // around a bright star is, 1 for the eye's own, 0 for none.
    airHorizon: f32,
    time: f32,
    scintillation: f32,
    glare: f32,
    // What the stars' and the Milky Way's light are multiplied by, 1 for as measured; stars fainter than this
    // magnitude are left out; the bend of the projection.
    starLight: f32,
    milkyWay: f32,
    magnitudeLimit: f32,
    projectionDistance: f32,
    // 1 the air table, 2 the Milky Way, 4 the stars.
    flags: u32,
    // The tiles the stars are binned into: their size in pixels, how many across, and how many stars one holds.
    tileSize: u32,
    tilesX: u32,
    capacity: u32,
    // Below this exposed luminance a star's image is cut off, and no image grows past this radius in pixels.
    threshold: f32,
    maxRadius: f32,
    // The observer's height in meters and the pupil's diameter in cm, for the twinkling.
    heightM: f32,
    pupilCm: f32,
    // The target's size in pixels, what a texel of value 1 of the Milky Way's map stands for in cd/m², and how many
    // degrees of the viewer's own field of view a pixel of the target spans, for the veil, which is the viewer's eye's.
    width: u32,
    height: u32,
    milkyWayLuminance: f32,
    screenDegreesPerPixel: f32,
    // How far the air bends a ray down at SH_AIR_SAMPLES apparent altitudes from airHorizon to the zenith, spaced by
    // the square of the entry's share, in radians; and what it lets through there, per channel.
    airBends: array<vec4f, 32>,
    airTransmittance: array<vec4f, 128>,
}

// One star binned into the tiles its image reaches: where it is on the target, in pixels, its image's width there, the
// radius its light is drawn to, its light at the eye in lux per channel, the luminance at its center per lux, and how
// many pixels a radian of sky spans at it.
struct ShSplat {
    pixel: vec2f,
    sigma: f32,
    radius: f32,
    light: vec3f,
    peak: f32,
    pixelsPerRadian: f32,
    pad0: f32,
    pad1: f32,
    pad2: f32,
}

const SH_AIR_SAMPLES: u32 = 128u;
const SH_FLAG_AIR: u32 = 1u;
const SH_FLAG_MILKY_WAY: u32 = 2u;
const SH_FLAG_STARS: u32 = 4u;
const SH_PI: f32 = 3.141592653589793;
// A star of magnitude 0 above the air, in lux: the Sun's 128,000 lux at magnitude -26.74.
const SH_MAGNITUDE_ZERO_LUX: f32 = 2.5775e-6;
// Floats per star in the catalog: magnitude, right ascension and declination in degrees, the proper motions in
// arcseconds a year, red, green and blue at unit luminance.
const SH_STAR_FIELDS: u32 = 8u;
