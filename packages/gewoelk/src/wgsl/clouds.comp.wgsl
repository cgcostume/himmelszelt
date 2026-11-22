// The cloudscape along every pixel's ray, written premultiplied with the transmittance behind it, at the size of the
// target, which may be smaller than the frame; the sheets are left to the compose pass, at the frame's. It is marched
// as Nubis3 marches its voxel clouds: steps the signed distance long outside the clouds and adaptive inside,
// the density up-rezzed from the dimensional profile by the detail noise, the light summed per voxel beforehand.
// Requires `wgsl.noise`, `params.wgsl`, `camera.wgsl`, `aerial.wgsl`, `sheet.wgsl`, `layerread.wgsl` and the output binding.

@group(0) @binding(0) var<uniform> gwParams: GwParams;
@group(0) @binding(1) var gwMap: texture_2d_array<f32>;
@group(0) @binding(2) var gwVolumeSampler: sampler;
@group(0) @binding(3) var gwModeling: texture_3d<f32>;
@group(0) @binding(4) var gwLight: texture_3d<f32>;
@group(0) @binding(5) var gwDetail: texture_3d<f32>;
@group(0) @binding(6) var<uniform> gwSunlight: GwSunlight;
@group(0) @binding(7) var gwAmbient: texture_3d<f32>;
@group(0) @binding(8) var gwBackground: texture_2d<f32>;
@group(0) @binding(9) var gwAerialLuminance: texture_3d<f32>;
@group(0) @binding(10) var gwAerialTransmittance: texture_3d<f32>;
@group(0) @binding(11) var gwClampSampler: sampler;
@group(0) @binding(12) var<storage, read> gwDeck: array<f32>;
@group(0) @binding(13) var gwDetailSampler: sampler;
// The layered model's deep layer beside the cloudscape, read by `layerread.wgsl` for the shade it casts: off where
// the pass has none.
@group(0) @binding(14) var<uniform> gwLayered: GwLayered;
@group(0) @binding(15) var gwLayerMaps: texture_2d_array<f32>;
@group(0) @binding(16) var gwLayerSampler: sampler;
// How far away what a pixel shows is, for a composition that orders the cloudscape with other clouds: x the distances
// in km summed by their shares of the pixel, y those shares, so that their quotient, the mean distance, can be read
// between pixels.
@group(1) @binding(1) var gwCloudsDepth: texture_storage_2d<rgba16float, write>;

// How far forwards the droplets of a deep layer scatter, for what light it lets through to what lies under it, and how
// much of the sky's light on a cloud a deep layer overhead takes with the sun's.
const GW_DEEP_FORWARD: f32 = 0.85;
const GW_DEEP_SKY: f32 = 0.7;

// What the deep layer lets through of the sun's light on its way to `p`, all of it without one: by its column where
// that way crosses its base, as the layered model shades the air. A sun at the horizon counts as one a little up.
fn gwDeepPassed(p: vec3f, sun: vec3f) -> f32 {
    if (gwLayered.layer[GW_LAYER_DEEP].enabled == 0u) {
        return 1.0;
    }
    let up = normalize(p);
    let towards = normalize(sun + up * 2.0 * max(0.1 - dot(sun, up), 0.0));
    let slant = 1.0 / max(dot(towards, up), 0.05);
    return gwDiffused(gwLayerOver(GW_LAYER_DEEP, p, towards, slant) * slant, GW_DEEP_FORWARD);
}

// How much of the cloudscape is left at `p` beside the deep layer, all of it without one: none inside that layer's
// cloud, by its column, where the deep layer's own march draws what is there, and a cloud of the cloudscape wholly
// within would else show through by the order of their distances. It goes as the deep layer's density comes in.
fn gwDeepOutside(p: vec3f) -> f32 {
    let l = gwLayered.layer[GW_LAYER_DEEP];
    let altitude = length(p) - gwParams.planetRadius;
    if (l.enabled == 0u || altitude <= l.base || altitude >= l.base + l.depth) {
        return 1.0;
    }
    let near = gwLayerGround(p);
    let m = gwLayerColumn(GW_LAYER_DEEP, near + gwLayered.observer - gwLayered.shear * (altitude - l.base));
    let thinned = gwLayerCleared(near);
    let value = clamp((m.r - thinned) / max(1.0 - thinned, 1e-3), 0.0, 1.0);
    let span = gwLayerSpan(l.depth, value);
    let h = (altitude - l.base) / l.depth;
    let inside = min(h - span.x, span.y - h) * l.depth * step(1e-3, value);
    return 1.0 - clamp(inside / clamp(0.1 * l.depth, 0.15, 0.6), 0.0, 1.0);
}

// What the march met along a ray: the distances of its steps, each by its share of the pixel, and those shares.
var<private> gwMet: vec2f;

// Whether a background is bound, the sky in cd/m² the far clouds fade into.
override GW_BACKGROUND: bool = true;

// Steps a ray takes at most through the cloudscape, and detailed density samples towards the sun per step: Nubis3's
// two, whose remaining light comes from the summed grid.
override GW_MAX_STEPS: u32 = 256u;
override GW_NEAR_LIGHT_SAMPLES: u32 = 2u;
// The distance within which the detail noise is read a second time, `GW_NEAR_DETAIL_FINER` times finer, in km, 0 for
// never: detail for an observer among the clouds, where the noise's texels would show, at one more read a sample there.
override GW_NEAR_DETAIL: f32 = 0.0;
const GW_NEAR_DETAIL_FINER: f32 = 5.0;
// Orders of scattering of the sun's light, the first the single scattering, each a `multiScatter` share of the one before.
override GW_SCATTERING_OCTAVES: u32 = 8u;
// Below this transmittance a ray is done.
const GW_MIN_TRANSMITTANCE: f32 = 0.01;

struct GwSample {
    // The up-rezzed density, 0 to 1, and the profile's, for the lighting.
    full: f32,
    profile: f32,
    kind: f32,
    // The share of the volume's clouds the clearing and the variation leave around here, for the light grid, which
    // still holds them all.
    kept: f32,
}

// The modeling data at a unit-cube point, and the signed distance in km it encodes.
fn gwModelingAt(q: vec3f) -> vec4f {
    return textureSampleLevel(gwModeling, gwVolumeSampler, q, 0.0);
}

fn gwSignedDistance(m: vec4f, q: vec3f) -> f32 {
    let volume = gwParams.cloudscape;
    var d = m.a * volume.sdfRange;
    if (m.r > 0.0) {
        d = -m.r * volume.profileDepth;
    }
    // Above or below the slab, the nearest cloud is at least that far away.
    let outside = max(max(-q.z, q.z - 1.0), 0.0) * volume.height;
    return select(d, max(d, outside), outside > 0.0);
}

// How far the clouds are thinned out at a point: the share of its profile that stays, and of the volume's clouds
// around, for the light grid, which still holds them all. Changing little within a voxel, it holds for the light's
// near samples too.
fn gwThinning(x: GwPoint, left: f32) -> vec2f {
    let volume = gwParams.cloudscape;
    // Towards the clearing the map's coverage falls: its threshold rises, so small clouds go first and large ones
    // shrink from their edges in, keeping their density. Read at the point, as the volume repeats but the clearing not.
    // The broad variation thins them the same way, where its field is up: drifting with the clouds, never repeating.
    let drifted = x.ground - volume.drift;
    var thinned = 0.0;
    if (volume.variation > 0.0) {
        // The map's raw field again, turned by 37° and stretched to the variation's size, so its repeats never line up
        // with the volume's.
        let g = drifted / max(volume.variationScale, 1.0);
        let turned = vec2f(0.7986 * g.x - 0.6018 * g.y, 0.6018 * g.x + 0.7986 * g.y);
        let field = textureSampleLevel(gwMap, gwVolumeSampler, turned, 0, 0.0).b;
        thinned = volume.variation * smoothstep(0.3, 0.7, field);
    }
    var stays = 1.0;
    if (left < 1.0 || thinned > 0.0) {
        let uv = drifted / volume.extent;
        let column = textureSampleLevel(gwMap, gwVolumeSampler, uv, 0, 0.0);
        // The map's value lowered by the threshold, and the cloud it makes as the voxels were made, lower and narrower:
        // a point stays where it lies within that smaller mound, so the cloud shrinks along its own dome, not cut by a
        // plane. The last remnants thin out too, so none ends as a hard little block on the horizon.
        let threshold = max(1.0 - left, thinned);
        let n = clamp((column.r - threshold) / max(1.0 - threshold, 1e-3), 0.0, 1.0);
        let scale = max(volume.towerScale, 1.0);
        let h = clamp(x.height / volume.height, 0.0, 1.0) * scale;
        let o = clamp(volume.offset, 0.0, 0.9);
        let reach = mix(0.6, scale, column.a);
        let before = min(h - o * (1.0 - column.r), o + column.r * (1.0 - o) * reach - h);
        let after = min(h - o * (1.0 - n), o + n * (1.0 - o) * reach - h);
        // Measured from where the surface was, so the billows that heap it beyond the mound shrink with it, and
        // nothing changes at a threshold of 0. A remnant fades with what is left of its mound, else it would end as a
        // flat slab with vertical walls.
        let kept = smoothstep(-0.15, 0.0, after - min(before, 0.0)) * smoothstep(0.0, 0.3, n / max(column.r, 1e-3));
        stays = kept * smoothstep(0.0, 0.3, left);
    }
    return vec2f(stays, 1.0 - max(1.0 - left, thinned));
}

// Nubis3's up-rez: the detail noise read at the point, wispy and billowy composites blended by the type, the profile
// thinned and eroded by the result, scaled and sharpened. `t` is the distance from the eye, for the finer noise near it.
fn gwDensity(m: vec4f, x: GwPoint, thinning: vec2f, t: f32) -> GwSample {
    let volume = gwParams.cloudscape;
    let profile = m.r * thinning.x;
    if (profile <= 0.0) {
        return GwSample(0.0, 0.0, 0.0, 1.0);
    }
    // Read at the height above the base, not above the planet's center: a sampler's fixed-point texel coordinates
    // overflow some ten thousand tiles out.
    let local = vec3f(x.ground - volume.drift, x.height - volume.detailShift);
    // Wrapped here, in full float precision, before the sampler's coarser coordinates see it; the sampler repeats in
    // all three axes, so the filter runs across a tile's edge.
    var noise = textureSampleLevel(gwDetail, gwDetailSampler, fract(local / volume.noiseScale), 0.0);
    if (t < GW_NEAR_DETAIL) {
        // The same noise again, finer and offset, lifting and lowering the first about its mean: it fades in from the
        // far end of its reach, so no ring shows where it begins.
        let finer = textureSampleLevel(gwDetail, gwDetailSampler, fract(local * GW_NEAR_DETAIL_FINER / volume.noiseScale + 0.37), 0.0);
        let far = clamp((t / max(GW_NEAR_DETAIL, 1e-6) - 0.4) / 0.6, 0.0, 1.0);
        noise = noise * mix(0.6 + 0.8 * finer, vec4f(1.0), far * far * (3.0 - 2.0 * far));
    }
    let wispy = mix(noise.r, noise.g, profile);
    let billowy = mix(noise.b * 0.3, noise.a * 0.3, pow(profile, 0.25));
    // Billowy rather than wispy for the most part: the map's type field only shifts the blend.
    let composite = mix(wispy, billowy, 0.35 + 0.65 * m.g) * volume.detail;
    var density = clamp((profile - composite) / max(1.0 - composite, 1e-3), 0.0, 1.0);
    let scale = pow(clamp(m.b, 0.0, 1.0), 4.0);
    density = density * scale;
    // Sharpened less than Nubis3 does, whose voxels are eight times finer: softer edges at this scale.
    density = pow(density, mix(0.65, 0.9, max(1e-3, scale)));
    return GwSample(density, profile * m.b, m.g, thinning.y);
}

// The cloudscape along the ray from `t0` to `t1`.
fn gwCloudscape(o: vec3f, v: vec3f, sun: vec3f, t0: f32, t1: f32, jitter: f32, uv: vec2f, sky: vec3f) -> GwLayer {
    let volume = gwParams.cloudscape;
    // The air in front of the clouds lies in the deck's shadow, as the sky beside them does (see gwAirUnderDeck).
    let extinction = volume.extinction;
    let groundShade = gwGroundShade(sun);
    // Each order's lobe, the same all along the ray.
    let cosTheta = dot(v, sun);
    var phases: array<f32, 8>;
    var lobe = 1.0;
    for (var k = 0u; k < min(GW_SCATTERING_OCTAVES, 8u); k = k + 1u) {
        phases[k] = 0.8 * gwHenyeyGreenstein(cosTheta, volume.forwardG * lobe) + 0.2 * gwHenyeyGreenstein(cosTheta, volume.backwardG * lobe);
        lobe = lobe * 0.5;
    }
    let cell = volume.height / f32(textureDimensions(gwModeling).z);
    var layer = GwLayer(vec3f(0.0), 1.0);
    // Jittered by up to a step as long as the first, so the bands a fixed start would draw turn into fine noise: far
    // off, where the steps have grown, by as much more.
    var t = t0 + jitter * gwParams.jitter * max(volume.stepMin, volume.stepGrowth * sqrt(max(t0, 0.0)));
    // Whether the ray got to its end, and if not, whether it was still in the cloud its last step met, and the light
    // that step added per share it covered: see after the march.
    var ended = false;
    var within = false;
    var last = vec3f(0.0);
    for (var i = 0u; i < GW_MAX_STEPS; i = i + 1u) {
        if (t >= t1 || layer.transmittance < GW_MIN_TRANSMITTANCE) {
            ended = true;
            break;
        }
        let p = o + v * t;
        // Beyond the clearing nothing is left. A ray that leaves it only gets farther from it; one that starts outside
        // a clearing centered elsewhere strides on to its edge, as far as it is off over the ground at least.
        let x = gwPointAt(p);
        let left = gwClearingOver(x.ground);
        if (left <= 0.0) {
            let off = x.ground - gwParams.clearingCenter;
            if (dot(off, v.xy) >= 0.0) {
                ended = true;
                break;
            }
            within = false;
            t = t + max(length(off) - gwParams.cloudscape.clearing, max(volume.stepMin, volume.stepGrowth * sqrt(max(t, 0.0))));
            continue;
        }
        let q = gwVolumeCoordinate(x);
        let m = gwModelingAt(q);
        let sdf = gwSignedDistance(m, q);
        let adaptive = max(volume.stepMin, volume.stepGrowth * sqrt(max(t, 0.0)));
        var step = max(sdf, adaptive);
        within = within && sdf < 0.0;
        if (sdf < 0.0) {
            let thinning = gwThinning(x, left);
            var sample = gwDensity(m, x, thinning, t);
            if (sample.full > 1e-4) {
                sample.full = sample.full * gwDeepOutside(p);
            }
            // Thinned away, by the clearing or the variation: the distance field still holds the cloud, but nothing of
            // it is left here. Not within a cloud then, and on by a voxel or more, or a ray would creep through what
            // is not there until its steps run out, short of the clouds behind.
            if (thinning.x <= 0.0) {
                within = false;
                step = max(step, max(cell, 4.0 * adaptive));
            }
            if (sample.full > 1e-4) {
                // The light grid's slices interpolated at the sun's elevation over this point.
                let up = p / length(p);
                let elevation = gwElevation(sun, up);
                let slice = clamp((elevation - volume.lightElevations.x) / max(volume.lightElevations.y - volume.lightElevations.x, 1e-6), 0.0, 1.0) * 3.0;
                // Read a voxel on towards the sun: the near samples below cover the first one, the grid the rest.
                let beyond = gwVolumeCoordinate(gwPointAt(p + sun * cell));
                // The clouds on the way to the sun thin out towards the clearing as those in sight do: a clearing on the
                // sun's side lets its light in under the deck. The grid holds them all, so its sum counts by the mean
                // of what the clearing leaves along the way through the slab, against what it leaves here.
                let rise = dot(sun, up);
                let run = sqrt(max(1.0 - rise * rise, 1e-6));
                let way = min(select(x.height, volume.height - x.height, rise > 0.0) * run / max(abs(rise), 1e-3), 2.0 * volume.clearing);
                let heading = normalize(sun.xy + vec2f(0.0, 1e-6));
                var towards = 0.0;
                for (var k = 0u; k < 4u; k = k + 1u) {
                    towards = towards + 0.25 * gwClearingOver(x.ground + heading * way * (f32(k) + 0.5) / 4.0);
                }
                let cleared = min(1.0, towards / max(left, 0.05));
                let toSun = sample.kept * cleared * dot(textureSampleLevel(gwLight, gwVolumeSampler, beyond, 0.0), max(1.0 - abs(slice - vec4f(0.0, 1.0, 2.0, 3.0)), vec4f(0.0)));
                // What the thinning leaves of the clouds around lets through more of the sky's and the ground's light.
                let open = mix(vec2f(1.0), textureSampleLevel(gwAmbient, gwVolumeSampler, q, 0.0).rg, sample.kept);
                // Nubis3's two detailed samples towards the sun, within the first voxel: a quarter and three quarters
                // of it on, each standing for half of it.
                var near = 0.0;
                for (var k = 0u; k < GW_NEAR_LIGHT_SAMPLES; k = k + 1u) {
                    let pk = p + sun * (f32(k) + 0.5) * cell / f32(GW_NEAR_LIGHT_SAMPLES);
                    let xk = gwPointAt(pk);
                    near = near + gwDensity(gwModelingAt(gwVolumeCoordinate(xk)), xk, thinning, t).full * cell / f32(GW_NEAR_LIGHT_SAMPLES);
                }
                let tauSun = extinction * (near + toSun);
                // The sun's light scattered once, and the orders after it as octaves (Wrenninge 2013, Hillaire 2016):
                // order k with a^k of the scattering, through b^k of the depth, with c^k of the lobe. Energy is kept
                // for a <= b only, so the depth's factor is never below the share's.
                // A sun that grazes the layer lights a level face of it, a base from below once it has set, through a
                // skin of 1 / sine of its height less depth than the sums along its ray have: far thinner than a voxel,
                // so the grid holds such a face as dark. The same light spread over the depth the grid resolves, the
                // sine of it through the sine of the depth, keeps the face's light: taken where it leaves more.
                let level = max(abs(dot(sun, up)), 0.0047);
                let grazing = level * (1.0 - smoothstep(0.1, 0.3, level));
                var orders = 0.0;
                var faced = 0.0;
                var share = 1.0;
                var depth = 1.0;
                let thinning = max(0.5, volume.multiScatter);
                for (var k = 0u; k < min(GW_SCATTERING_OCTAVES, 8u); k = k + 1u) {
                    orders = orders + share * exp(-tauSun * depth) * phases[k];
                    faced = faced + share * exp(-tauSun * level * depth) * phases[k];
                    share = share * volume.multiScatter;
                    depth = depth * thinning;
                }
                orders = max(orders, grazing * faced);
                // Deep inside, the octaves die out long before the light does: it diffuses, isotropic by then.
                if (volume.multiScatter > 0.0) {
                    let diffused = max(gwDiffused(tauSun, volume.forwardG), grazing * gwDiffused(tauSun * level, volume.forwardG));
                    orders = max(orders, volume.multiScatter * diffused / (4.0 * GW_PI));
                }
                let sunlight = mix(gwSunAt(0u, elevation), gwSunAt(1u, elevation), clamp(q.z, 0.0, 1.0));
                let passed = gwDeepPassed(p, sun);
                let direct = sunlight * orders * passed;
                // The sky's light from above and the ground's from below, each a hemisphere of even radiance E / pi,
                // half of which an isotropic phase scatters our way, through the clouds around as the ambient grid has
                // it. Not dimmed by the profile as well, as Nubis3's is: that counted the depth twice, and drew the
                // walls between sky-lit tops and ground-lit bases as dark bands.
                let fromSky = gwParams.skyIrradiance * open.r * mix(1.0, passed, GW_DEEP_SKY);
                // The ground's light from below, dimmed where the deck shades the ground.
                let fromGround = gwParams.groundIrradiance * groundShade * open.g;
                let ambient = (fromSky + fromGround) / (2.0 * GW_PI);
                let sigmaT = extinction * sample.full;
                let sigmaS = sigmaT * volume.albedo;
                let scattered = sigmaS * (direct + ambient);
                let through = exp(-sigmaT * step);
                // Seen through the air between, at this step's own distance, as gwFaded sees a whole layer.
                let air = gwAirUnderDeck(uv, o, v, t, sky);
                let covered = layer.transmittance * (1.0 - through);
                last = air.transmittance * scattered / sigmaT + air.luminance;
                within = true;
                layer.luminance = layer.luminance + covered * last;
                gwMet = gwMet + covered * vec2f(t, 1.0);
                layer.transmittance = layer.transmittance * through;
            }
        }
        t = t + step;
    }
    // Out of steps within a cloud, e.g. along a deck seen from below: what is left of it is taken as opaque, lit as its
    // last step was, rather than letting the sky behind show through.
    if (!ended && within) {
        gwMet = gwMet + layer.transmittance * vec2f(t, 1.0);
        layer.luminance = layer.luminance + layer.transmittance * last;
        layer.transmittance = 0.0;
    }
    // What the march gave up on below the last percent is opaque, as Nubis3 remaps it: no layer behind shows through.
    layer.transmittance = max(layer.transmittance - GW_MIN_TRANSMITTANCE, 0.0) / (1.0 - GW_MIN_TRANSMITTANCE);
    return layer;
}

@compute @workgroup_size(8, 8, 1)
fn gwClouds(@builtin(global_invocation_id) id: vec3u) {
    let size = gwOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let v = gwPixelRay(vec2f(id.xy) + 0.5, size);
    let o = vec3f(0.0, 0.0, gwParams.planetRadius + gwParams.observerAltitude);
    let sun = normalize(gwParams.sunDirection);
    let volume = gwParams.cloudscape;
    var result = GwLayer(vec3f(0.0), 1.0);
    gwMet = vec2f(0.0);
    if (volume.enabled != 0u) {
        let r0 = gwParams.planetRadius + volume.base;
        let shell = gwShell(o, v, r0, r0 + volume.height, gwParams.planetRadius);
        if (shell.hits) {
            // Beyond a few fades nothing shows: the march ends there.
            let t1 = min(shell.far, shell.near + 4.0 * gwParams.fade);
            var behind = vec3f(0.0);
            if (GW_BACKGROUND) {
                let full = textureDimensions(gwBackground);
                let at = min(vec2u((vec2f(id.xy) + 0.5) / vec2f(size) * vec2f(full)), full - 1u);
                behind = textureLoad(gwBackground, at, 0).rgb;
            }
            let sky = gwAirLight(o, v, behind, GW_BACKGROUND);
            let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
            result = gwCloudscape(o, v, sun, shell.near, t1, gwJitter(id.xy, gwParams.frame), uv, sky);
        }
    }
    gwOutputStore(id.xy, vec4f(result.luminance, result.transmittance));
    textureStore(gwCloudsDepth, vec2i(id.xy), vec4f(gwMet, 0.0, 0.0));
}
