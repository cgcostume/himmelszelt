// God rays for the layered model: the shafts of sunlight and of the clouds' shade in the air, for a ray from the observer
// in any projection. The sun's light comes in parallel lines, and every point of one line has the same clouds in the
// sun's way. So a line is a point of a plane, the one where it passes the observer's level, and a ray from the observer
// runs straight outwards over that plane from the observer's own line: the ray towards the sun and the one away from it
// stay there, which is where the shafts meet. The table is that plane around the observer's line, a row for each
// direction outwards and a column for each distance, and holds the mean shade from the middle out to there. The shade
// along any stretch of a ray is then the difference of two reads: no steps through the air and no grain, however many
// shadows the ray crosses. Shadow maps are summed along such rows by Baran et al. (2010) and Chen et al. (2011), whose
// rows are a camera's epipolar lines; these are a ray's own. A texel holds four values, the shade of what a line has
// above four altitudes, from the layers' lowest base to short of their highest top: air between and over the clouds has
// fewer of them in the sun's way. Requires `params.wgsl`, `layers.comp.wgsl` and the output binding.

// The table for the march; for the pass that sums it, the shade to sum.
@group(0) @binding(7) var gwGodRaysTable: texture_2d<f32>;

// Whether the march reads the table. Without, it asks at a few points of a ray for one number.
override GW_GOD_RAYS: bool = false;

// Where the columns stand, in km from the middle: evenly up to about the first distance, then by a ratio to the second.
const GW_GOD_RAYS_NEAR: f32 = 4.0;
const GW_GOD_RAYS_FAR: f32 = 512.0;
// The sine of the lowest sun the lines are laid for: a lower one counts as one there.
const GW_GOD_RAYS_LOW_SUN: f32 = 0.05;
// The samples of a line through a flat layer, and through towers or a front.
const GW_GOD_RAYS_STEPS: vec2u = vec2u(8u, 16u);
// The stretches of a ray its air's shade is weighed over.
const GW_GOD_RAYS_STRETCHES: u32 = 8u;
// The air whose light a shade takes, as dunstkreis has it: the heights in km over which its molecules and its haze thin
// to 1/e, the distance over which molecules alone fade daylight to 1/e, and how far forwards the haze scatters. What a
// shorter fade than the molecules' holds is haze: dunstkreis' default air fades in 60 km, a hazy summer day's in 20.
const GW_GOD_RAYS_SCALES: vec2f = vec2f(8.0, 1.2);
const GW_GOD_RAYS_CLEAR: f32 = 75.0;
const GW_GOD_RAYS_HAZE_G: f32 = 0.8;

fn gwGodRaysSun() -> vec3f {
    let sun = normalize(gwParams.sunDirection);
    return normalize(vec3f(sun.xy, max(sun.z, GW_GOD_RAYS_LOW_SUN)));
}

// The distance from the middle a column stands at, the column as a share of the table's width, and back.
fn gwGodRaysDistance(column: f32) -> f32 {
    return GW_GOD_RAYS_NEAR * (exp(column * log(1.0 + GW_GOD_RAYS_FAR / GW_GOD_RAYS_NEAR)) - 1.0);
}

fn gwGodRaysColumn(distance: f32) -> f32 {
    return clamp(log(1.0 + distance / GW_GOD_RAYS_NEAR) / log(1.0 + GW_GOD_RAYS_FAR / GW_GOD_RAYS_NEAR), 0.0, 1.0);
}

// A ray's way over the plane: x its row, as a share of a turn, y the km it runs outwards for each km of its length.
fn gwGodRaysWay(v: vec3f) -> vec2f {
    let sun = gwGodRaysSun();
    let k = v.xy - sun.xy * (v.z / sun.z);
    let speed = length(k);
    if (speed < 1e-6) {
        return vec2f(0.0);
    }
    return vec2f(fract(atan2(k.y, k.x) / (2.0 * GW_PI)), speed);
}

// The mean shade along the row `row` from the middle `distance` km out, above each of the four altitudes.
fn gwGodRaysMean(row: f32, distance: f32) -> vec4f {
    let width = f32(textureDimensions(gwGodRaysTable).x);
    let column = (0.5 + gwGodRaysColumn(distance) * (width - 1.0)) / width;
    return textureSampleLevel(gwGodRaysTable, gwLayerSampler, vec2f(column, row), 0.0);
}

// What each of the four altitudes' shade counts for at `altitude`: the nearest two, and none at the layers' top.
fn gwGodRaysAt(altitude: f32, bounds: vec2f) -> vec4f {
    let level = 4.0 * clamp((altitude - bounds.x) / (bounds.y - bounds.x), 0.0, 1.0);
    return max(vec4f(1.0) - abs(vec4f(level) - vec4f(0.0, 1.0, 2.0, 3.0)), vec4f(0.0));
}

// The molecules' and the haze's shares of the light of air that fades by 1/e in `fade` km, at the ground, scattered by
// the angle of cosine `mu` from the sun: the haze lies low and sends most of its light forwards, so the hazier the air
// and the nearer the sun, the more the low air counts, and with it the shafts.
fn gwGodRaysShares(mu: f32, fade: f32) -> vec2f {
    let molecules = 3.0 / (16.0 * GW_PI) * (1.0 + mu * mu);
    let haze = max(GW_GOD_RAYS_CLEAR / fade - 1.0, 0.0) * gwHenyeyGreenstein(mu, GW_GOD_RAYS_HAZE_G);
    return vec2f(molecules, haze) / (molecules + haze);
}

// The shade of the air between the observer at `o` and `t` km along the ray `v`, whose way over the plane is `way`.
fn gwGodRaysBefore(o: vec3f, v: vec3f, way: vec2f, t: f32, bounds: vec2f) -> f32 {
    let altitude = length(o + v * 0.5 * t) - gwParams.planetRadius;
    return dot(gwGodRaysAt(altitude, bounds), gwGodRaysMean(way.x, t * way.y));
}

// How much of the air along a ray lies in the layers' shade, as the march asks it of a few points, and how thin that
// air is on the whole, against the air at the ground: over stretches that each send a like share of `lit`, the air's
// light at the distance `fade` fades it by, thinner air counting for less, by its `shares`.
fn gwGodRaysAir(o: vec3f, v: vec3f, way: vec2f, lit: f32, fade: f32, bounds: vec2f, shares: vec2f) -> vec2f {
    var shade = vec2f(0.0);
    var before = vec4f(0.0);
    var reached = 0.0;
    for (var k = 0u; k < GW_GOD_RAYS_STRETCHES; k = k + 1u) {
        let part = (vec2f(f32(k)) + vec2f(0.5, 1.0)) / f32(GW_GOD_RAYS_STRETCHES);
        let t = -fade * log(vec2f(1.0) - part * lit);
        let to = t.y * way.y;
        let mean = gwGodRaysMean(way.x, to);
        let sum = to * mean;
        let altitude = length(o + v * t.x) - gwParams.planetRadius;
        let thin = dot(shares, exp(-max(altitude, 0.0) / GW_GOD_RAYS_SCALES));
        // A ray at the sun or away from it stays on its line: the stretch has no length on the plane. Clamped, as the
        // difference of two means of 16 bits each may fall a little outside.
        let between = clamp((sum - before) / max(to - reached, 1e-9), vec4f(0.0), vec4f(1.0));
        let stretch = select(mean, between, to - reached > 1e-6);
        shade = shade + thin * vec2f(dot(gwGodRaysAt(altitude, bounds), stretch), 1.0);
        before = sum;
        reached = to;
    }
    return vec2f(shade.x / max(shade.y, 1e-6), shade.y / f32(GW_GOD_RAYS_STRETCHES));
}

// The share of the light behind the layers that the air up to `farthest` km along a ray sends, as thin as `thin`: all
// that a shade can take. Beyond lies the ground, which counts as a long way of air, or the air over the layers' top,
// thinning with height and no longer a way than the planet's curve leaves a ray along the ground.
fn gwGodRaysShare(o: vec3f, v: vec3f, thin: f32, lit: f32, farthest: f32, fade: f32, grounded: bool, shares: vec2f) -> f32 {
    let under = thin * lit;
    let end = o + v * max(farthest, 0.0);
    let rise = max(dot(v, end) / length(end), 1e-3);
    let ways = min(GW_GOD_RAYS_SCALES / rise, sqrt(0.5 * GW_PI * gwParams.planetRadius * GW_GOD_RAYS_SCALES));
    let above = dot(shares, exp(-max(length(end) - gwParams.planetRadius, 0.0) / GW_GOD_RAYS_SCALES) * ways) / fade;
    return under / max(under + (1.0 - lit) * select(above, 1.0, grounded), 1e-6);
}

// The table's shade, before it is summed: for the line of each texel what the layers take of the sun's light along it,
// above each of the four altitudes.
@compute @workgroup_size(8, 8, 1)
fn gwGodRaysShade(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let radius = gwParams.planetRadius;
    let sun = gwGodRaysSun();
    let bounds = gwLayerBounds();
    let distance = gwGodRaysDistance(f32(id.x) / f32(size.x - 1u));
    let turn = (f32(id.y) + 0.5) / f32(size.y) * 2.0 * GW_PI;
    let foot = vec3f(distance * cos(turn), distance * sin(turn), radius + gwParams.observerAltitude);
    let altitudes = vec4f(radius + bounds.x) + (bounds.y - bounds.x) * vec4f(0.0, 0.25, 0.5, 0.75);
    var tau = vec4f(0.0);
    for (var i = 0u; i < GW_LAYER_COUNT; i = i + 1u) {
        if (gwLayered.layer[i].enabled == 0u) {
            continue;
        }
        let base = gwLayered.layer[i].base - select(0.0, GW_LAYER_SCUD_DROP, i == 0u && gwLayerUnderFront());
        let top = gwSphere(foot, sun, radius + gwLayered.layer[i].base + gwLayered.layer[i].depth);
        if (!top.hits) {
            continue;
        }
        // Up through the layer towards the sun: from its base, or from where a line that stays above it is lowest.
        let bottom = gwSphere(foot, sun, radius + base);
        let start = select(-dot(foot, sun), bottom.far, bottom.hits);
        let steps = select(GW_GOD_RAYS_STEPS.x, GW_GOD_RAYS_STEPS.y, gwLayered.layer[i].kind >= 2u);
        let stride = (top.far - start) / f32(steps);
        for (var k = 0u; k < steps; k = k + 1u) {
            let p = foot + sun * (start + (f32(k) + 0.5) * stride);
            tau = tau + gwLayerDensity(p, false, i).x * stride * step(altitudes, vec4f(length(p)));
        }
    }
    gwOutputStore(id.xy, vec4f(1.0) - vec4f(1.0) / (vec4f(1.0) + 0.75 * (1.0 - GW_LAYER_FORWARD) * tau));
}

// The table: each row of the shade summed outwards, into its mean from the middle to every column.
@compute @workgroup_size(1, 64, 1)
fn gwGodRaysMeans(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.y >= size.y) {
        return;
    }
    var last = textureLoad(gwGodRaysTable, vec2u(0u, id.y), 0);
    var sum = vec4f(0.0);
    var reached = 0.0;
    gwOutputStore(vec2u(0u, id.y), last);
    for (var x = 1u; x < size.x; x = x + 1u) {
        let to = gwGodRaysDistance(f32(x) / f32(size.x - 1u));
        let here = textureLoad(gwGodRaysTable, vec2u(x, id.y), 0);
        sum = sum + 0.5 * (last + here) * (to - reached);
        gwOutputStore(vec2u(x, id.y), sum / to);
        last = here;
        reached = to;
    }
}
