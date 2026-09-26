// Hillaire's sky-view LUT, recomputed per frame. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`,
// `sampling.wgsl`, `raymarch.wgsl` and `quality.wgsl`. A pass, so it declares its bindings.
//
// Cheap enough to rebuild every frame (a 192x108 table, 30 steps each) and it turns the sky pass into a
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

@compute @workgroup_size(8, 8)
fn dkPrecomputeSkyView(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2f(textureDimensions(dkSkyViewOut));
    if (f32(id.x) >= size.x || f32(id.y) >= size.y) {
        return;
    }

    let a = dkAtmosphere;
    let h = clamp(dkParams.observerAltitude, 0.0, a.Rt - a.Rg);
    let uv = (vec2f(f32(id.x), f32(id.y)) + 0.5) / size;

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
        DK_SAMPLES_SKY_VIEW, false,
    );
    // Alpha holds how far the ray bent on its way out, as the sine of the angle: the sky pass turns the view ray by
    // it to find where the sun disc shows. Nothing for a ray ending on the ground.
    let bend = select(length(cross(direction, ray.direction)), 0.0, ray.hitsGround);
    // In cd/m², which half floats hold from 6e-5, deep into twilight, up to 65504, above the sky around the sun.
    textureStore(dkSkyViewOut, vec2i(id.xy), vec4f(min(ray.luminance, vec3f(65504.0)), bend));
}
