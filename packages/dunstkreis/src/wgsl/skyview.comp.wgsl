// Hillaire's sky-view LUT, recomputed per frame. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`,
// `sampling.wgsl`, `raymarch.wgsl`, `goldenset.wgsl` and `quality.wgsl`. A pass, so it declares its bindings.
//
// The ground below the horizon is lit by the sky as well as the sun, in three steps: the table with the ground lit by
// the sun alone, then `dkGroundIrradiance` gathers the sky's light on the ground from the table's upper half, then,
// with DK_GROUND_LIGHT, the lower half again with both. The sky's rays never reach the ground, so the upper half does
// not depend on the lower one.
//
// Cheap enough to rebuild every frame (a 192x108 table, 30 samples each) and it turns the sky pass into a
// single texture fetch per pixel. The sun's position is baked into it, so it has to follow the sun; the
// transmittance and multiple-scattering tables above it do not, and are only rebuilt when the model changes.

struct DkSkyViewParams {
    // Unit vector towards the sun in the observer's local frame, z up. The true direction: the table is indexed by
    // the apparent view direction, and the bending between the two is traced.
    sunDirection: vec3f,
    // Observer altitude above the ground, in km. Not the radius, which f32 resolves to only ~0.5 m.
    observerAltitude: f32,
}

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyViewParams;
@group(0) @binding(2) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var dkMultiScatteringLut: texture_2d<f32>;
@group(0) @binding(4) var dkLutSampler: sampler;
@group(0) @binding(5) var dkSkyViewOut: texture_storage_2d<rgba16float, write>;
// The sky's irradiance on the ground in lux, rgb, gathered by dkGroundIrradiance.
@group(0) @binding(6) var<storage, read_write> dkGroundLight: vec4f;
// The table just built, read back by dkGroundIrradiance.
@group(0) @binding(7) var dkSkyViewIn: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn dkPrecomputeSkyView(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2f(textureDimensions(dkSkyViewOut));
    if (f32(id.x) >= size.x || f32(id.y) >= size.y) {
        return;
    }

    let a = dkAtmosphere;
    let h = clamp(dkParams.observerAltitude, 0.0, a.Rt - a.Rg);
    let uv = (vec2f(f32(id.x), f32(id.y)) + 0.5) / size;
    // The second run only redoes the ground, the table's lower half.
    if (DK_GROUND_LIGHT && uv.y < 0.5) {
        return;
    }

    let muAzimuth = dkSkyViewMuAzimuth(a, h, uv, size);
    let mu = muAzimuth.x;
    let cosAzimuth = muAzimuth.y;

    // Rebuild a view direction in the frame the table is indexed in: z up, azimuth measured from the sun.
    let sinView = sqrt(max(1.0 - mu * mu, 0.0));
    let sinAzimuth = sqrt(max(1.0 - cosAzimuth * cosAzimuth, 0.0));
    let direction = vec3f(sinView * cosAzimuth, sinView * sinAzimuth, mu);

    // The sun placed in that same frame, at azimuth zero by construction.
    let muS = clamp(dkParams.sunDirection.z, -1.0, 1.0);
    let sunDirection = vec3f(sqrt(max(1.0 - muS * muS, 0.0)), 0.0, muS);

    let ray = dkRaymarchSky(
        a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, vec3f(0.0, 0.0, 1.0), h, direction, sunDirection,
        DK_SAMPLES_SKY_VIEW, true,
    );
    // Alpha holds how far the ray bent on its way out, as the sine of the angle: the sky pass turns the view ray by
    // it to find where the sun disc shows. Nothing for a ray ending on the ground.
    let bend = select(length(cross(direction, ray.direction)), 0.0, ray.hitsGround);
    var luminance = ray.luminance;
    if (DK_GROUND_LIGHT && ray.hitsGround) {
        // The sky's light on the ground, reflected diffusely by its albedo and dimmed by the air on the way here.
        luminance = luminance + ray.transmittance * a.groundAlbedo / DK_PI * dkGroundLight.rgb;
    }
    // In cd/m², which half floats hold from 6e-5, deep into twilight, up to 65504, above the sky around the sun.
    textureStore(dkSkyViewOut, vec2i(id.xy), vec4f(min(luminance, vec3f(65504.0)), bend));
}

// The sky's irradiance on the ground: its luminance over the hemisphere above, cosine-weighted, from the golden set's
// points on a disc lifted onto the hemisphere (Malley's method), so the plain mean times pi is the irradiance. Read
// from the table, so from the observer's altitude: close enough near the ground, too dark high up, where less sky is
// above than above the ground.
@compute @workgroup_size(1)
fn dkGroundIrradiance() {
    let a = dkAtmosphere;
    let h = clamp(dkParams.observerAltitude, 0.0, a.Rt - a.Rg);
    let size = vec2f(textureDimensions(dkSkyViewIn));
    var sum = vec3f(0.0);
    for (var i = 0u; i < DK_GROUND_SAMPLES; i = i + 1u) {
        var point: vec2f;
        if (DK_GROUND_SAMPLES == 8u) {
            point = dkGoldenSet8[i] * 2.0;
        } else {
            point = dkGoldenSet64[i % 64u] * 2.0;
        }
        let r2 = min(dot(point, point), 1.0);
        let mu = sqrt(1.0 - r2);
        let cosAzimuth = select(1.0, point.x / sqrt(r2), r2 > 1e-8);
        let uv = dkSkyViewUv(a, h, mu, cosAzimuth, size);
        sum = sum + textureSampleLevel(dkSkyViewIn, dkLutSampler, vec2f(uv.x, min(uv.y, 0.5 - 0.5 / size.y)), 0.0).rgb;
    }
    dkGroundLight = vec4f(DK_PI * sum / f32(DK_GROUND_SAMPLES), 0.0);
}
