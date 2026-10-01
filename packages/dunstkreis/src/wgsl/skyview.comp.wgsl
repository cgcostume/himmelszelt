// Hillaire's sky-view LUT, recomputed per frame. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`,
// `sampling.wgsl`, `raymarch.wgsl`, `frame.wgsl`, `quality.wgsl`, `features.wgsl` and `workgroupSum(64, ...)` from
// `reduce.ts`, first. A pass, so it declares its bindings.
//
// The ground below the horizon is lit by the sky as well as the sun, in three steps: the table's upper half, the sky,
// with DK_SKY_VIEW_ROWS 1; then `dkGroundIrradiance` gathers the sky's light on the ground from it; then the lower
// half with both, DK_SKY_VIEW_ROWS 2. The sky's rays never reach the ground, so the upper half does not depend on the
// lower one. Without the sky's light on the ground, one dispatch writes all of it, DK_SKY_VIEW_ROWS 0.
//
// Cheap enough to rebuild every frame (a 128x256 table, 30 samples each) and it turns the sky pass into a
// single texture fetch per pixel. The sun's position is baked into it, so it has to follow the sun; the
// transmittance and multiple-scattering tables above it do not, and are only rebuilt when the model changes.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(2) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(3) var dkMultiScatteringLut: texture_2d<f32>;
@group(0) @binding(4) var dkLutSampler: sampler;
@group(0) @binding(5) var dkSkyViewOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var<storage, read_write> dkMetering: DkMetering;
// The table just built, read back by dkGroundIrradiance.
@group(0) @binding(7) var dkSkyViewIn: texture_2d<f32>;

// The table's rows above the horizon: those whose centers lie in its upper half.
fn dkSkyRows(height: u32) -> u32 {
    return height / 2u;
}

@compute @workgroup_size(8, 8)
fn dkPrecomputeSkyView(@builtin(global_invocation_id) id: vec3u) {
    let texels = textureDimensions(dkSkyViewOut);
    let row = select(id.y, id.y + dkSkyRows(texels.y), DK_SKY_VIEW_ROWS == 2u);
    if (id.x >= texels.x || row >= texels.y || (DK_SKY_VIEW_ROWS == 1u && row >= dkSkyRows(texels.y))) {
        return;
    }

    let a = dkAtmosphere;
    let h = clamp(dkParams.observerAltitude, 0.0, a.Rt - a.Rg);
    let size = vec2f(texels);
    let uv = (vec2f(f32(id.x), f32(row)) + 0.5) / size;

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
    // How far the ray bent on its way out, as the sine of the angle, the same for every azimuth: one per row. Nothing
    // for a ray ending on the ground.
    if (id.x == 0u) {
        dkMetering.bend[row] = select(length(cross(direction, ray.direction)), 0.0, ray.hitsGround);
    }
    var luminance = ray.luminance;
    if (DK_SKY_VIEW_ROWS == 2u && ray.hitsGround) {
        // The sky's light on the ground, reflected diffusely by its albedo and dimmed by the air on the way here.
        luminance = luminance + ray.transmittance * a.groundAlbedo / DK_PI * dkMetering.groundLight;
    }
    // At the four wavelengths, in units `toRgb` turns into cd/m², which half floats hold from 6e-5, deep into twilight,
    // up to 65504, above the sky around the sun.
    textureStore(dkSkyViewOut, vec2i(i32(id.x), i32(row)), min(luminance, vec4f(65504.0)));
}

// The sky's irradiance on the ground, ∫ L μ dω over the hemisphere above: the table's upper half summed texel by
// texel, each texel's luminance times the cosine-weighted solid angle it covers above the horizontal, ∫ μ dμ dφ over
// its extent, on both sides of the sun's meridian, which the table holds once. Exact for the table, where points spread
// over the hemisphere hit or miss the thin band of glow twilight leaves at the horizon. Read from the table, so from the
// observer's altitude: close enough near the ground, too dark high up, where less sky is above than above the ground.
@compute @workgroup_size(64)
fn dkGroundIrradiance(@builtin(local_invocation_index) index: u32) {
    let a = dkAtmosphere;
    let h = clamp(dkParams.observerAltitude, 0.0, a.Rt - a.Rg);
    let texels = textureDimensions(dkSkyViewIn);
    let last = vec2f(texels - 1u);
    let zenithHorizon = acos(clamp(dkHorizonMu(a, h), -1.0, 1.0));
    var sum = vec4f(0.0);
    for (var k = index; k < texels.x * dkSkyRows(texels.y); k = k + 64u) {
        let texel = vec2u(k % texels.x, k / texels.x);
        // The texel's extent in the table's unit coordinates, where its center is at texel / (size - 1).
        let low = clamp((vec2f(texel) - 0.5) / last, vec2f(0.0), vec2f(1.0, 0.5));
        let high = clamp((vec2f(texel) + 0.5) / last, vec2f(0.0), vec2f(1.0, 0.5));
        // The azimuth from the sun, x = sin(φ / 2); the zenith angle, the horizon's times 1 - t² with t = 1 - 2y.
        let azimuth = 2.0 * (asin(high.x) - asin(low.x));
        let t = 1.0 - 2.0 * vec2f(low.y, high.y);
        let mu = max(cos(zenithHorizon * (1.0 - t * t)), vec2f(0.0));
        // ∫ μ dμ = (μ0² - μ1²) / 2, twice for both sides of the meridian.
        let weight = azimuth * (mu.x * mu.x - mu.y * mu.y);
        sum = sum + textureLoad(dkSkyViewIn, texel, 0) * weight;
    }
    let total = dkWorkgroupSum(sum, index);
    if (index == 0u) {
        dkMetering.groundLight = total;
    }
}
