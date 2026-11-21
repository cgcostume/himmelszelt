// The sheet of high cloud, read once per pixel where its ray crosses the sheet's shell, from the map `highmap.comp.wgsl`
// bakes: thinned to patches and bands, its puffs softened and eaten by billows, lit by the sun through a thin layer and
// by the sky, and its shadow on the ground. Written alone, linear in cd/m², with what it lets through of what lies
// behind. Requires `params.wgsl`, dunstkreis' `camera.wgsl` and the output binding.

// What the sheet is read by: a change of any of it leaves the map as it is. Lengths in km.
struct GwHighSheet {
    // Height above the ground, the optical depth straight through where the map reads 1, and one tile of the map.
    altitude: f32,
    opticalDepth: f32,
    tile: f32,
    // How much of the sky the sheet's patches and bands cover, 0 for no sheet.
    coverage: f32,
    // Unit vector the wind blows towards, east and north: the map's x axis.
    wind: vec2f,
    // Where the observer stands over the map, east and north: their place less how far the sheet has drifted.
    offset: vec2f,
    // A patch's size across, how many times as long as wide a band is, and the bands' angle to the wind, in radians.
    patchSize: f32,
    bandStretch: f32,
    bandAngle: f32,
    // How far a patch thins out towards its edge, and how far a puff fades out past its rim, 0 to 1 each.
    edge: f32,
    softness: f32,
    // How deep billows eat into the puffs, the largest billows' size, and how far they have crept.
    billows: f32,
    billowSize: f32,
    billowShift: f32,
    // How far a puff's sunward neighbors shade it, and the forward lobe's asymmetry, Henyey & Greenstein's g.
    relief: f32,
    forwardG: f32,
    // The distance over the ground at which the last cloud is gone, 0 for no end, and from where they thin out.
    clearing: f32,
    clearingFrom: f32,
}

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var<uniform> gwSunlight: GwSunlight;
@group(0) @binding(2) var<uniform> gwHigh: GwHighSheet;
@group(0) @binding(3) var gwHighMap: texture_2d<f32>;
@group(0) @binding(4) var gwHighMapSampler: sampler;

// The row of the sunlight table that holds the sun's light at the sheet's altitude: the first sheet's.
override GW_HIGH_SUNLIGHT_ROW: u32 = 2u;

// The largest lumps of the billows' noise across the map's tile, as baked.
const GW_HIGH_BILLOW_CELLS: f32 = 32.0;
// How many levels of the map up the softest puffs are read from.
const GW_HIGH_SOFT_LEVELS: f32 = 3.5;
// The distances at which the air has hidden the ground's shadows and the sheet to 1/e, in km, and the angle the sun's
// disc spans.
const GW_HIGH_GROUND_AIR: f32 = 90.0;
const GW_HIGH_AIR: f32 = 220.0;
const GW_HIGH_SUN_ANGLE: f32 = 0.0093;
// A puff's thickness over its width.
const GW_HIGH_LUMP: f32 = 0.35;
// How much of the ground's light a cloud's full shadow takes, the rest being the sky's.
const GW_HIGH_SHADOW: f32 = 0.7;
// The largest luminance the output's half floats hold, in cd/m².
const GW_HIGH_BRIGHTEST: f32 = 65504.0;

// The ray through a point of the target, in pixels from its top left corner, on dunstkreis' camera.
fn gwHighRay(position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    return dkProjectRay(gwParams.inverseViewProjection, ndc, clamp(gwParams.projectionDistance, 0.0, 1.0));
}

// Where on a unit sphere about the planet's center `up` lies from the observer's zenith, as an arc east and north: by
// the sine, which keeps its precision near the zenith where the cosine has lost it.
fn gwHighGround(up: vec3f) -> vec2f {
    let s = length(up.xy);
    return up.xy * select(1.0, atan2(s, up.z) / max(s, 1e-12), s > 1e-6);
}

// The sun's illuminance on the sheet where the sun stands `elevation` radians above the local horizon.
fn gwHighSunAt(elevation: f32) -> vec3f {
    let span = gwSunlight.span[GW_HIGH_SUNLIGHT_ROW].xy;
    let f = clamp((elevation - span.x) / max(span.y - span.x, 1e-6), 0.0, 1.0) * f32(GW_SUNLIGHT_ENTRIES - 1u);
    let i = min(u32(f), GW_SUNLIGHT_ENTRIES - 2u);
    let at = GW_HIGH_SUNLIGHT_ROW * GW_SUNLIGHT_ENTRIES + i;
    return mix(gwSunlight.illuminance[at].rgb, gwSunlight.illuminance[at + 1u].rgb, f - f32(i));
}

// The sheet's density over a point of the ground, `over` km east and north of the observer, for a footprint of `lod`
// levels of the map: the tile read in the wind's frame, thinned to the patches of the broad field.
fn gwHighDensity(over: vec2f, lod: f32) -> f32 {
    let g = over + gwHigh.offset;
    let along = gwHigh.wind;
    let w = vec2f(dot(g, along), dot(g, vec2f(along.y, -along.x)));
    let detail = textureSampleLevel(gwHighMap, gwHighMapSampler, w / gwHigh.tile, lod);
    // The bands lie at their own angle to the wind, stretched along it.
    let c = cos(gwHigh.bandAngle);
    let s = sin(gwHigh.bandAngle);
    let b = vec2f((c * w.x + s * w.y) / gwHigh.bandStretch, -s * w.x + c * w.y) / (4.0 * gwHigh.patchSize);
    let field = textureSampleLevel(gwHighMap, gwHighMapSampler, b, max(lod - log2(4.0 * gwHigh.patchSize / gwHigh.tile), 0.0));
    let broad = clamp((field.b - 0.28) / 0.44, 0.0, 1.0);
    let soft = 0.02 + 0.3 * gwHigh.edge;
    // The last twentieth of the coverage fades what the field's peaks would keep, so a sheet blends out to none.
    let stays = smoothstep(1.0 - gwHigh.coverage - soft, 1.0 - gwHigh.coverage + soft, broad) * smoothstep(0.0, 0.05, gwHigh.coverage);
    // Softness: the puffs read from a coarser level of the map, a blur that spreads each one past its rim.
    let blurred = textureSampleLevel(gwHighMap, gwHighMapSampler, w / gwHigh.tile, lod + gwHigh.softness * GW_HIGH_SOFT_LEVELS).r * (1.0 + 0.8 * gwHigh.softness);
    // Towards a patch's edge the threshold rises: small puffs go first, large ones shrink, and the veil thins.
    let left = clamp((vec2f(blurred, detail.g) - (1.0 - stays)) / max(stays, 0.05), vec2f(0.0), vec2f(1.0)) * sqrt(stays);
    // Billows: the noise read twice, at two sizes and creeping two ways, so its lumps change as they go. It eats into
    // the puffs from their rims, as the detail noise erodes a volume's profile, and gives the blur its lumps back.
    let size = GW_HIGH_BILLOW_CELLS * gwHigh.billowSize;
    let fine = max(lod + log2(gwHigh.tile / size), 0.0);
    let creep = vec2f(0.8, 0.6) * gwHigh.billowShift;
    let one = textureSampleLevel(gwHighMap, gwHighMapSampler, (w + creep) / size, fine).a;
    let two = textureSampleLevel(gwHighMap, gwHighMapSampler, (vec2f(w.y, -w.x) + creep) / (size * 1.62), max(fine - 0.7, 0.0)).a;
    // The height becomes a density, level at the rim and in the middle, and the billows thin it lump by lump, the
    // more the nearer the rim: no threshold, so an edge stays as soft as the blur made it.
    let whole = left.x * left.x * (3.0 - 2.0 * left.x);
    let dense = whole * clamp(1.0 - 1.8 * gwHigh.billows * (0.6 * one + 0.4 * two) * (1.0 - whole), 0.0, 1.0);
    return clamp(dense + left.y * (1.0 - 0.6 * dense), 0.0, 1.0);
}

// How much of the sheet's coverage is left over the ground point `over`: less towards the clearing, as of the clouds
// under it.
fn gwHighKept(over: vec2f) -> f32 {
    if (gwHigh.clearing <= 0.0) {
        return 1.0;
    }
    return 1.0 - smoothstep(min(gwHigh.clearingFrom, 0.99 * gwHigh.clearing), gwHigh.clearing, length(over));
}

// How much of its light the ground at `at` loses to the sheet's shadow, seen along `v` from `far` km, a pixel there
// `spread` radians wide: the sheet read where the way to the sun crosses it, as blurred as the pixel's footprint and
// the sun's disc make it, for what a layer that scatters forwards lets through of the light on it.
fn gwHighShadow(at: vec3f, v: vec3f, far: f32, spread: f32) -> f32 {
    let sun = normalize(gwParams.sunDirection);
    let up = normalize(at);
    let rise = dot(sun, up);
    if (rise <= 0.0) {
        return 0.0;
    }
    let r = gwParams.planetRadius + gwHigh.altitude;
    let reach = gwSphere(at, sun, r).far;
    let over = gwHighGround(normalize(at + sun * reach)) * r;
    let wide = max(far * spread / max(abs(dot(v, up)), 0.03), reach * GW_HIGH_SUN_ANGLE);
    let texels = f32(textureDimensions(gwHighMap).x) / gwHigh.tile;
    let tau = gwHigh.opticalDepth * gwHighDensity(over, max(log2(wide * texels), 0.0)) * gwHighKept(over);
    let passed = gwDiffused(tau / max(rise, 0.05), gwHigh.forwardG);
    return GW_HIGH_SHADOW * smoothstep(0.0, 0.12, rise) * (1.0 - passed) * exp(-far / GW_HIGH_GROUND_AIR);
}

// The sheet along the ray `v` through a pixel `spread` radians wide: its light in cd/m² as it reaches the eye, and
// what it lets through of what lies behind, 1 where there is none, less where its shadow lies on the ground.
fn gwHighAlong(v: vec3f, spread: f32) -> vec4f {
    let sun = normalize(gwParams.sunDirection);
    // A meter up at least: from the ground itself a ray down would miss it.
    let observer = max(gwParams.observerAltitude, 1e-3);
    let o = vec3f(0.0, 0.0, gwParams.planetRadius + observer);
    let r = gwParams.planetRadius + gwHigh.altitude;
    let shell = gwSphere(o, v, r);
    let below = observer < gwHigh.altitude;
    let t = select(shell.near, shell.far, below);
    let earth = gwSphere(o, v, gwParams.planetRadius);
    let grounded = earth.hits && earth.near > 0.0;
    // Where the ray ends on the ground, the sheet's shadow there takes from what the ground sends.
    var lit = 1.0;
    if (grounded) {
        lit = 1.0 - gwHighShadow(o + v * earth.near, v, earth.near, spread);
    }
    if (!shell.hits || t <= 0.0 || (grounded && earth.near < t)) {
        return vec4f(0.0, 0.0, 0.0, lit);
    }
    let p = o + v * t;
    let up = normalize(p);
    // Where on the ground the point lies over, by the arc from the observer.
    let over = gwHighGround(up) * r;
    let mu = max(abs(dot(v, up)), 0.03);
    let texel = gwHigh.tile / f32(textureDimensions(gwHighMap).x);
    let lod = max(log2(t * spread / texel) + 0.5 * log2(1.0 / mu), 0.0);
    let density = gwHighDensity(over, lod) * gwHighKept(over);
    let tau = gwHigh.opticalDepth * density;
    let through = exp(-tau / mu);
    let sine = dot(sun, up);
    let mu0 = max(sine, 0.03);
    // A puff is a lump more than a slab: a low sun's light crosses no more of it than its width.
    let across = max(mu0, GW_HIGH_LUMP * sqrt(max(1.0 - sine * sine, 0.0)));
    let light = gwHighSunAt(asin(clamp(sine, -1.0, 1.0)));
    // The cloud between the point and the sun, a puff's width on: its sunward neighbors shade it.
    let reach = min(sqrt(max(1.0 - mu0 * mu0, 0.0)) / mu0, 4.0) * 0.15;
    let toSun = normalize(sun.xy + vec2f(1e-9));
    let sunward = gwHighDensity(over + toSun * reach, lod + 1.0);
    // And lump by lump: brighter where the cloud falls away towards the sun, darker behind a lump. What the neighbors
    // let through is scattered light too, as under the sheet: a high cloud is thin, and has next to no shading.
    let slope = density - gwHighDensity(over + toSun * 0.05, lod);
    let shade = gwDiffused(gwHigh.relief * gwHigh.opticalDepth * sunward * min(reach / 0.15, 2.0), gwHigh.forwardG) * clamp(1.0 + gwHigh.relief * 0.9 * slope, 0.45, 1.7);
    // Light scattered once on its way through a thin layer, lit from above and seen from below or above.
    let phase = 0.78 * gwHenyeyGreenstein(dot(v, sun), gwHigh.forwardG) + 0.22 * gwHenyeyGreenstein(dot(v, sun), -0.2);
    let sameSide = (dot(v, up) > 0.0) == below;
    var once = tau / mu * through;
    if (abs(across - mu) > 1e-3) {
        once = across / (across - mu) * (exp(-tau / across) - through);
    }
    if (!sameSide) {
        once = across / (across + mu) * (1.0 - exp(-tau / across - tau / mu));
    }
    // And many times: what a thick puff still lets through, or sends back, as diffuse light.
    let passed = gwDiffused(tau, gwHigh.forwardG);
    let many = mu0 / GW_PI * select(1.0 - passed, max(passed - exp(-tau / across), 0.0), sameSide);
    // The sky's light on it as an even glow: its mean luminance overhead, and the horizon's.
    let sky = 0.6 * gwParams.skyIrradiance / GW_PI + 0.4 * gwParams.horizonLuminance;
    let cloud = light * shade * (phase * once + many) + sky * (1.0 - through) * 0.9;
    // The air in between takes the far sheet into the sky's color.
    let near = exp(-t / GW_HIGH_AIR);
    return vec4f(cloud * near, (1.0 - (1.0 - through) * near) * lit);
}

// The sheet alone, for a pass that composes it over a sky.
@compute @workgroup_size(8, 8, 1)
fn gwHighSheet(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    if (gwHigh.coverage <= 0.0) {
        gwOutputStore(id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
        return;
    }
    let at = vec2f(id.xy) + 0.5;
    let v = gwHighRay(at, size);
    // The angle a pixel spans, by the next one's ray.
    let spread = length(gwHighRay(at + vec2f(1.0, 0.0), size) - v);
    let sheet = gwHighAlong(v, spread);
    // About the sun a thin sheet is brighter than a half float holds: dimmed to it there, its color kept.
    let brightest = max(sheet.r, max(sheet.g, sheet.b));
    gwOutputStore(id.xy, vec4f(sheet.rgb * min(1.0, GW_HIGH_BRIGHTEST / max(brightest, 1.0)), sheet.a));
}
