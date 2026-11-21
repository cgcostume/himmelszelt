// What the star passes take per frame. A struct only, no binding: the pass binds it where it likes. Requires
// `seeing.wgsl` (dunstkreis') before it. Directions ENU (x east, y north, z up) and unit length, angles in radians,
// light in lux, luminance in cd/m².

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
    // How many of a tile entry's low bits hold the star, the rest its brightness; the time in seconds, for the
    // twinkling; free; how strong the eye's veil around a bright star is, 1 for the eye's own, 0 for none.
    indexBits: u32,
    time: f32,
    free2: f32,
    glare: f32,
    // What the stars' and the Milky Way's light are multiplied by, 1 for as measured; stars fainter than this
    // magnitude are left out; the bend of the projection.
    starLight: f32,
    milkyWay: f32,
    magnitudeLimit: f32,
    projectionDistance: f32,
    // 1 the air table, `shAir`, 2 the Milky Way, 4 the stars, 8 the deep stars, 16 the twinkling.
    flags: u32,
    // The tiles the stars are binned into: their size in pixels, how many across, and how many stars one holds, the
    // brightest.
    tileSize: u32,
    tilesX: u32,
    capacity: u32,
    // Below this exposed luminance a star's image is cut off, and no image grows past this radius in pixels.
    threshold: f32,
    maxRadius: f32,
    // The magnitude below which the faint stars are drawn, for a compact layout, whose order is not the brightest
    // first; free.
    faintLimit: f32,
    free1: f32,
    // The target's size in pixels, what a texel of value 1 of the Milky Way's map stands for in cd/m², and how many
    // degrees of the viewer's own field of view a pixel of the target spans, for the veil, which is the viewer's eye's.
    width: u32,
    height: u32,
    milkyWayLuminance: f32,
    screenDegreesPerPixel: f32,
    // What luminance is multiplied by where the image is finally shown, for the cut-off, the knee and the halo: the
    // exposure itself unless a later pass exposes; the exposed luminance at which a star's core stops brightening and
    // its excess light goes into its halo; the share of that light the halo shows, 0 for none; how many levels the
    // halos' grid has.
    displayExposure: f32,
    knee: f32,
    halo: f32,
    haloLevels: u32,
    // The constellations' lines: their color in units of display white and how much of it shows, 0 for none; their
    // width in pixels and how far from a star they stop, in pixels; and which constellations show, a bit each.
    lineColor: vec3f,
    lineOpacity: f32,
    lineWidth: f32,
    lineGap: f32,
    // How many of the faint stars after the catalog's are drawn.
    faintCount: u32,
    // The stops below 1 the Milky Way's map spans, each channel's logarithm; 0 for a map read linear.
    milkyWayStops: f32,
    constellations: vec4u,
    // What hides the stars behind it, the Moon say: towards its center as it shows, and the cosine of its angular
    // radius, above 1 for none.
    occluder: vec4f,
    // How the air's turbulence makes a star flicker, dunstkreis' `seeingUniformData`, its variance scaled by the
    // square of the twinkling's strength.
    seeing: DkSeeing,
    // The white balance, helldunkel's `whiteBalance`, on the composed light before the exposure; the identity for none.
    whiteBalance: mat3x3f,
    // The share of a halo's light each level of the halos' grid spreads, four a vec4, finest first, adding up to 1:
    // the halo's profile at its width, `haloWeights`.
    haloWeights: array<vec4f, 3>,
}

// One star binned into the tiles its image reaches: where it is on the target, in pixels, its image's width there, the
// radius its light is drawn to, 0 for a star not drawn, its core's light at the eye in lux per channel, the luminance
// at its center per lux, its whole light at the eye in lux as a luminance, the share of its core's light the core
// shows under the knee, its whole light in its brightest channel, which a full tile keeps the brightest by, and the
// light its halo shows in lux, as a luminance.
struct ShSplat {
    pixel: vec2f,
    sigma: f32,
    radius: f32,
    light: vec3f,
    peak: f32,
    whole: f32,
    core: f32,
    brightest: f32,
    halo: f32,
}

const SH_FLAG_AIR: u32 = 1u;
const SH_FLAG_MILKY_WAY: u32 = 2u;
const SH_FLAG_STARS: u32 = 4u;
// The deep stars' sums hold this frame's light.
const SH_FLAG_DEEP: u32 = 8u;
const SH_FLAG_TWINKLE: u32 = 16u;
const SH_PI: f32 = 3.141592653589793;
// Rec. 709's luminance of linear sRGB.
const SH_LUMINANCE: vec3f = vec3f(0.2126, 0.7152, 0.0722);
// A star of magnitude 0 above the air, in lux: the Sun's 128,000 lux at magnitude -26.74.
const SH_MAGNITUDE_ZERO_LUX: f32 = 2.5775e-6;
// Floats per star in the catalog: magnitude, right ascension and declination in degrees, the proper motions in
// arcseconds a year, red, green and blue at unit luminance.
const SH_STAR_FIELDS: u32 = 8u;
// Words per star in the compact catalog, and per block of 64 compact faint or deep stars.
const SH_COMPACT_STAR_WORDS: u32 = 3u;
const SH_BLOCK_WORDS: u32 = 97u;
// The exposed luminance, in units of display white, the halo's light rises towards logarithmically.
const SH_HALO_KNEE: f32 = 0.25;
// The halos' grid: a texel of its finest level spans so many pixels of the target, and it reaches so many pixels past
// the target's edges, so a bright star just outside still throws its halo in. Each level halves the one before.
const SH_HALO_SCALE: u32 = 2u;
const SH_HALO_MARGIN: u32 = 64u;
// What half floats hold, in units of display white.
const SH_HALO_MOST: f32 = 6e4;

// A piece of a constellation's line on the target, in pixels: its two ends, the two stars its line joins, and whether
// it shows.
struct ShPiece {
    a: vec2f,
    b: vec2f,
    starA: vec2f,
    starB: vec2f,
    shown: f32,
    pad0: f32,
    pad1: f32,
    pad2: f32,
}

// What the deep stars' pass takes per frame besides: the view's axis and the cosine of the angle from it past which no
// star reaches the target, and the magnitude down to which the deep stars are drawn.
struct ShDeep {
    axis: vec3f,
    cosCone: f32,
    magnitudeLimit: f32,
    pad0: f32,
    pad1: f32,
    pad2: f32,
}

// The exposed luminance, in units of display white, one step of the deep stars' sums stands for: a 128th of the
// default threshold, and room for sixteen thousand times display white in a pixel. And how many pixels from its own
// a deep star's light reaches at most.
const SH_DEEP_STEP: f32 = 1.0 / 262144.0;
const SH_DEEP_REACH: i32 = 3;

// The pieces a constellation's line is drawn in, and how many of them a tile holds.
const SH_LINE_PIECES: u32 = 8u;
const SH_LINE_CAPACITY: u32 = 16u;
