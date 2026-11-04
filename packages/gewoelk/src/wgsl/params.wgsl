// What the passes share: the per-frame uniform, the cloudscape's and each sheet's settings within it, and the modeling
// parameters a cloud map is made from. Structs only, no bindings: each pass binds them where it likes. Lengths in km,
// directions ENU (x east, y north, z up), light in lux and cd/m².

// A sheet: a thin layer of high cloud, cirrus or cirrostratus, read once where a ray crosses its sphere.
struct GwSheet {
    // Height above the ground, in km.
    altitude: f32,
    // Optical depth straight through the sheet where its map reads 1: the cloud's thickness in stops of light.
    opticalDepth: f32,
    coverage: f32,
    sharpness: f32,
    // Where the map's origin has drifted to with the wind, in km, and one map tile's size, in km.
    drift: vec2f,
    scale: f32,
    // The map's third coordinate, which evolves its shape.
    evolution: f32,
    albedo: f32,
    // The forward lobe's asymmetry, Henyey & Greenstein's g.
    forwardG: f32,
    enabled: u32,
    seed: u32,
    // The wind's direction, along which the fibers stretch, one tile of them across it in km, and how far they erode.
    streak: vec2f,
    fiberScale: f32,
    detail: f32,
    // How far ripples across the wind break the sheet into waves, cirrocumulus, 0 for none.
    ripples: f32,
    // The noise the sheet is made of, see SheetNoise in params.ts: the flow's sweep and hooks, how strongly and how
    // wide the strands bundle, the fibers' sharpness and stretch, the flocks' and the grain's erosion and size, and the
    // broad variation's depth and size. Sizes in km.
    sweep: f32,
    hook: f32,
    bundles: f32,
    bundleSize: f32,
    fiberPower: f32,
    fiberStretch: f32,
    flocks: f32,
    flockSize: f32,
    grain: f32,
    grainSize: f32,
    broad: f32,
    broadSize: f32,
    pad0: f32,
    pad1: f32,
    pad2: f32,
}

// The cloudscape: the voxel volume the low clouds live in, a slab of `height` km from `base` km up, repeating every
// `extent` km east and north, as Nubis3's grid did not but a sky to the horizon has to.
struct GwCloudscape {
    // Where the volume's origin has drifted to with the wind, in km.
    drift: vec2f,
    extent: f32,
    base: f32,
    height: f32,
    // Extinction per km of full density, and the single scattering albedo.
    extinction: f32,
    albedo: f32,
    // One tile of the detail noise, in km.
    noiseScale: f32,
    // How far inside the cloud the dimensional profile reaches 1, in km, and how far outside the stored distance reaches.
    profileDepth: f32,
    sdfRange: f32,
    // The smallest step inside a cloud, in km, and how steps grow with the square root of the distance.
    stepMin: f32,
    stepGrowth: f32,
    // The phase function's forward and backward lobes, and each order of scattering's share of the one before.
    forwardG: f32,
    backwardG: f32,
    multiScatter: f32,
    enabled: u32,
    // How far the detail noise erodes the profile, 0 for the profile alone, 1 for Nubis3's full erosion.
    detail: f32,
    // The sun's elevations above the local horizon the light grid's four slices hold, the first and the last, radians.
    lightElevations: vec2f,
    // How far over the ground the clouds reach before they have cleared away, in km, 0 for no end, and how far they
    // are all there, from where they grow fewer.
    clearing: f32,
    clearingFrom: f32,
    // The aerial perspective volume's reach in km and the scale its luminance is stored at; a reach of 0 for none.
    aerial: vec2f,
    // How far a broad, unrepeating field thins the clouds out in places, 0 to 1, and its size in km: the volume
    // repeats, the gaps it leaves do not.
    variation: f32,
    variationScale: f32,
    // The map's shaping into clouds, as the voxels have it, for thinning them in the march: the bottoms' offset and
    // how many times the ordinary clouds' height the slab is.
    offset: f32,
    towerScale: f32,
}

struct GwParams {
    // Unit vector towards the sun, z up.
    sunDirection: vec3f,
    // Observer height above the ground, in km.
    observerAltitude: f32,
    inverseViewProjection: mat4x4f,
    // The sun's illuminance at the observer, per channel in lux, and the projection's d, see dkProjectRay.
    sunIlluminance: vec3f,
    projectionDistance: f32,
    // The sky's irradiance on a surface facing up and the ground's on one facing down, in lux.
    skyIrradiance: vec3f,
    planetRadius: f32,
    groundIrradiance: vec3f,
    // What luminance in cd/m² is multiplied by, 1 / (1.2 * 2^EV100).
    exposure: f32,
    // The distance at which clouds have faded to 1/e into the sky behind them, in km: the air in between.
    fade: f32,
    // How far the first step is jittered, 0 to 1 step, and the frame, which animates the jitter.
    jitter: f32,
    frame: u32,
    sheets: u32,
    // The sky's luminance along the horizon, in cd/m²: what far clouds fade into without a background, and the cap with.
    horizonLuminance: vec3f,
    pad: f32,
    cloudscape: GwCloudscape,
    sheet: array<GwSheet, 2>,
}

// The sun's illuminance in lux by its elevation above the local horizon, which grows by a degree every 111 km towards
// the sun: rows for the cloudscape's base and top and each sheet, `GW_SUNLIGHT_ENTRIES` evenly from `span.x` to
// `span.y` radians each. Reddened and cut off by the planet's shadow, it lights far clouds after the near ones.
const GW_SUNLIGHT_ENTRIES: u32 = 32u;

struct GwSunlight {
    span: array<vec4f, 4>,
    illuminance: array<vec4f, 128>,
}

// What a cloud map is made from: the shaping of gwFbm into coverage, the map's third coordinate, and for the
// cloudscape's map the offset that keeps the clouds' bottoms flat.
struct GwModel {
    coverage: f32,
    sharpness: f32,
    // The share of the volume's height the bottoms may dip below the base level, 0 to 1, as the thesis' offset.
    offset: f32,
    evolution: f32,
    seed: u32,
    octaves: u32,
    // Which layer of the map array this model fills.
    layer: u32,
    // Lattice cells of the first octave across the map.
    cells: u32,
    // How much of the cloudscape grows into towers, 0 to 1, how deep its billows are, as a share of its height, and
    // billows across the volume, east and north.
    towers: f32,
    billows: f32,
    billowCells: u32,
    // How many times taller than the ordinary clouds the slab is, for the towers to rise into.
    towerScale: f32,
}

const GW_PI: f32 = 3.141592653589793;

fn gwHenyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
    let g2 = g * g;
    return (1.0 - g2) / (4.0 * GW_PI * pow(max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4), 1.5));
}

// Where a ray from `o` crosses a sphere of radius `r` about the origin: the two distances, the nearer first, or none.
struct GwHit {
    near: f32,
    far: f32,
    hits: bool,
}

fn gwSphere(o: vec3f, v: vec3f, r: f32) -> GwHit {
    let b = dot(o, v);
    let c = dot(o, o) - r * r;
    let disc = b * b - c;
    if (disc < 0.0) {
        return GwHit(0.0, 0.0, false);
    }
    let s = sqrt(disc);
    return GwHit(-b - s, -b + s, true);
}

// The stretch of a ray within the shell between the radii `r0 < r1`, from the observer at `o`: start and end, or none.
// A ray into the ground ends there, so clouds below the horizon stay hidden behind the planet.
fn gwShell(o: vec3f, v: vec3f, r0: f32, r1: f32, ground: f32) -> GwHit {
    let ro = length(o);
    let inner = gwSphere(o, v, r0);
    let outer = gwSphere(o, v, r1);
    let earth = gwSphere(o, v, ground);
    let hitsGround = earth.hits && earth.near > 0.0 && ro >= ground;
    var t0 = 0.0;
    var t1 = 0.0;
    if (ro < r0) {
        if (hitsGround) {
            return GwHit(0.0, 0.0, false);
        }
        t0 = inner.far;
        t1 = outer.far;
    } else if (ro <= r1) {
        t0 = 0.0;
        t1 = select(outer.far, inner.near, inner.hits && inner.near > 0.0);
    } else {
        if (!outer.hits || outer.near < 0.0) {
            return GwHit(0.0, 0.0, false);
        }
        t0 = outer.near;
        t1 = select(outer.far, inner.near, inner.hits && inner.near > 0.0);
    }
    return GwHit(t0, t1, t1 > t0);
}
