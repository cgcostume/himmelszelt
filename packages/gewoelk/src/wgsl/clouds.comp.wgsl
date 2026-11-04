// The cloudscape along every pixel's ray, written premultiplied with the transmittance behind it, at the size of the
// target, which may be smaller than the frame; the sheets are left to the compose pass, at the frame's. It is marched
// as Nubis3 marches its voxel clouds: steps the signed distance long outside the clouds and adaptive inside,
// the density up-rezzed from the dimensional profile by the detail noise, the light summed per voxel beforehand.
// Requires `noise.wgsl`, `params.wgsl`, `camera.wgsl`, `sheet.wgsl` and the output binding.

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

// Whether a background is bound, the sky in cd/m² the far clouds fade into.
override GW_BACKGROUND: bool = true;

// Steps a ray takes at most through the cloudscape, and detailed density samples towards the sun per step: Nubis3's
// two, whose remaining light comes from the summed grid.
override GW_MAX_STEPS: u32 = 256u;
override GW_NEAR_LIGHT_SAMPLES: u32 = 2u;
// Orders of scattering of the sun's light, the first the single scattering, each a `multiScatter` share of the one before.
override GW_SCATTERING_OCTAVES: u32 = 8u;
// Below this transmittance a ray is done.
const GW_MIN_TRANSMITTANCE: f32 = 0.01;

// Interleaved gradient noise (Jimenez 2014), a different frame of it each frame.
fn gwJitter(pixel: vec2u, frame: u32) -> f32 {
    let p = vec2f(pixel) + 5.588238 * f32(frame % 64u);
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// A point in the cloudscape: over which point of the ground, east and north of the observer along the surface, and
// how high above the base, each in km. Taken once per point, as the arc tangent it costs is read many times.
struct GwPoint {
    ground: vec2f,
    height: f32,
}

fn gwPointAt(p: vec3f) -> GwPoint {
    return GwPoint(gwGround(p), length(p) - gwParams.planetRadius - gwParams.cloudscape.base);
}

// A point in the cloudscape's unit cube: east and north wrapped by the extent, the height over the slab's.
fn gwVolumeCoordinate(x: GwPoint) -> vec3f {
    let volume = gwParams.cloudscape;
    return vec3f(fract((x.ground - volume.drift) / volume.extent), x.height / volume.height);
}

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
        // nothing changes at a threshold of 0.
        let kept = select(0.0, smoothstep(-0.15, 0.0, after - min(before, 0.0)), n > 0.0);
        stays = kept * smoothstep(0.0, 0.3, left);
    }
    return vec2f(stays, 1.0 - max(1.0 - left, thinned));
}

// Nubis3's up-rez: the detail noise read at the point, wispy and billowy composites blended by the type, the profile
// thinned and eroded by the result, scaled and sharpened.
fn gwDensity(m: vec4f, x: GwPoint, thinning: vec2f) -> GwSample {
    let volume = gwParams.cloudscape;
    let profile = m.r * thinning.x;
    if (profile <= 0.0) {
        return GwSample(0.0, 0.0, 0.0, 1.0);
    }
    // Read at the height above the base, not above the planet's center: a sampler's fixed-point texel coordinates
    // overflow some ten thousand tiles out.
    let local = vec3f(x.ground - volume.drift, x.height);
    // Wrapped here, in full float precision, before the sampler's coarser coordinates see it.
    let tile = local / volume.noiseScale;
    let noise = textureSampleLevel(gwDetail, gwVolumeSampler, vec3f(fract(tile.xy), tile.z), 0.0);
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
// The sun's light through the cloudscape at `p`, 1 to 0, from the light grid: the slices at the sun's elevation there.
fn gwSunThrough(p: vec3f, sun: vec3f) -> f32 {
    let volume = gwParams.cloudscape;
    let q = gwVolumeCoordinate(gwPointAt(p));
    let span = volume.lightElevations;
    let slice = clamp((gwElevation(sun, p / length(p)) - span.x) / max(span.y - span.x, 1e-6), 0.0, 1.0) * 3.0;
    let summed = dot(textureSampleLevel(gwLight, gwVolumeSampler, q, 0.0), max(1.0 - abs(slice - vec4f(0.0, 1.0, 2.0, 3.0)), vec4f(0.0)));
    return exp(-volume.extinction * summed);
}

fn gwCloudscape(o: vec3f, v: vec3f, sun: vec3f, t0: f32, t1: f32, jitter: f32, uv: vec2f, sky: vec3f) -> GwLayer {
    let volume = gwParams.cloudscape;
    // The air in front of the clouds lies in their shadow where the deck closes towards the sun: its light, the sun's
    // forward glow above all, dimmed by what the deck lets through where the ray meets it, a share kept for the sky's.
    let shade = mix(0.3, 1.0, gwSunThrough(o + v * max(t0, 0.0), sun));
    let extinction = volume.extinction;
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
    // Jittered by up to the smallest step, so the bands a fixed start would draw turn into fine noise and no more.
    var t = t0 + jitter * gwParams.jitter * volume.stepMin;
    for (var i = 0u; i < GW_MAX_STEPS; i = i + 1u) {
        if (t >= t1 || layer.transmittance < GW_MIN_TRANSMITTANCE) {
            break;
        }
        let p = o + v * t;
        // Beyond the clearing nothing is left, and a ray from the observer only gets farther from it.
        let x = gwPointAt(p);
        let left = gwClearingOver(x.ground);
        if (left <= 0.0) {
            break;
        }
        let q = gwVolumeCoordinate(x);
        let m = gwModelingAt(q);
        let sdf = gwSignedDistance(m, q);
        let adaptive = max(volume.stepMin, volume.stepGrowth * sqrt(max(t, 0.0)));
        let step = max(sdf, adaptive);
        if (sdf < 0.0) {
            let thinning = gwThinning(x, left);
            let sample = gwDensity(m, x, thinning);
            if (sample.full > 1e-4) {
                // The light grid's slices interpolated at the sun's elevation over this point.
                let up = p / length(p);
                let elevation = gwElevation(sun, up);
                let slice = clamp((elevation - volume.lightElevations.x) / max(volume.lightElevations.y - volume.lightElevations.x, 1e-6), 0.0, 1.0) * 3.0;
                // Read a voxel on towards the sun: the near samples below cover the first one, the grid the rest.
                let beyond = gwVolumeCoordinate(gwPointAt(p + sun * cell));
                let toSun = sample.kept * dot(textureSampleLevel(gwLight, gwVolumeSampler, beyond, 0.0), max(1.0 - abs(slice - vec4f(0.0, 1.0, 2.0, 3.0)), vec4f(0.0)));
                let open = sample.kept * textureSampleLevel(gwAmbient, gwVolumeSampler, q, 0.0).rg * volume.height;
                // Nubis3's two detailed samples towards the sun, within the first voxel: a quarter and three quarters
                // of it on, each standing for half of it.
                var near = 0.0;
                for (var k = 0u; k < GW_NEAR_LIGHT_SAMPLES; k = k + 1u) {
                    let pk = p + sun * (f32(k) + 0.5) * cell / f32(GW_NEAR_LIGHT_SAMPLES);
                    let xk = gwPointAt(pk);
                    near = near + gwDensity(gwModelingAt(gwVolumeCoordinate(xk)), xk, thinning).full * cell / f32(GW_NEAR_LIGHT_SAMPLES);
                }
                let tauSun = extinction * (near + toSun);
                // The sun's light scattered once, and the orders after it as octaves (Wrenninge 2013, Hillaire 2016):
                // order k with a^k of the scattering, through b^k of the depth, with c^k of the lobe. Energy is kept
                // for a <= b only, so the depth's factor is never below the share's.
                var orders = 0.0;
                var share = 1.0;
                var depth = 1.0;
                let thinning = max(0.5, volume.multiScatter);
                for (var k = 0u; k < min(GW_SCATTERING_OCTAVES, 8u); k = k + 1u) {
                    orders = orders + share * exp(-tauSun * depth) * phases[k];
                    share = share * volume.multiScatter;
                    depth = depth * thinning;
                }
                let sunlight = mix(gwSunAt(0u, elevation), gwSunAt(1u, elevation), clamp(q.z, 0.0, 1.0));
                let direct = sunlight * orders;
                // The sky's light from above and the ground's from below, each a hemisphere of even radiance E / pi,
                // half of which an isotropic phase scatters our way; strongest at the surface, after Nubis3's profile,
                // and relaxed in depth, where it arrives after many bounces.
                let surface = mix(0.35, 1.0, pow(1.0 - sample.profile, 0.5));
                let fromSky = gwParams.skyIrradiance * exp(-extinction * open.r * 0.25);
                let fromGround = gwParams.groundIrradiance * exp(-extinction * open.g * 0.25);
                let ambient = surface * (fromSky + fromGround) / (2.0 * GW_PI);
                let sigmaT = extinction * sample.full;
                let sigmaS = sigmaT * volume.albedo;
                let scattered = sigmaS * (direct + ambient);
                let through = exp(-sigmaT * step);
                // Seen through the air between, at this step's own distance, as gwFaded sees a whole layer.
                var air = gwAirAt(uv, t, sky);
                air.luminance = air.luminance * shade;
                let covered = layer.transmittance * (1.0 - through);
                layer.luminance = layer.luminance + covered * (air.transmittance * scattered / sigmaT + air.luminance);
                layer.transmittance = layer.transmittance * through;
            }
        }
        t = t + step;
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
            let sky = gwAirLight(behind, GW_BACKGROUND);
            let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
            result = gwCloudscape(o, v, sun, shell.near, t1, gwJitter(id.xy, gwParams.frame), uv, sky);
        }
    }
    gwOutputStore(id.xy, vec4f(result.luminance, result.transmittance));
}
