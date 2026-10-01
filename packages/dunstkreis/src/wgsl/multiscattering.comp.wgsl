// Hillaire's multiple-scattering LUT precompute. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`,
// `sampling.wgsl`, `quality.wgsl` and `workgroupSum(64, ...)` from `reduce.ts`, first. A pass, so it declares its
// bindings.
//
// This is what replaces Bruneton's 4D inscatter table and its ping-pong over scattering orders. The trick is
// to assume multiply scattered light is isotropic, which makes each order a fixed fraction of the one before
// it, so the whole infinite series collapses into a geometric sum: L2 / (1 - f). A 64x64 texture then holds
// every order at once, and there is nothing to iterate.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var dkLutSampler: sampler;
@group(0) @binding(3) var dkMultiScatteringOut: texture_storage_2d<rgba16float, write>;

// Directions sampled per axis, so 64 in total, one per invocation of a texel's workgroup. Hillaire's own value.
const DK_MS_DIRECTIONS: u32 = 8u;

struct DkMultiScatterSample {
    // Second-order scattered light: what arrives after exactly one further bounce.
    luminance: vec3f,
    // The fraction of light a bounce hands on to the next order, the ratio of the geometric series.
    transfer: vec3f,
}

// Raymarches one direction, accumulating both terms. Isotropic throughout: no phase function appears, which
// is precisely the assumption that makes the series summable.
fn dkIntegrateMultiScattering(a: DkAtmosphere, h: f32, direction: vec3f, sunDirection: vec3f)
    -> DkMultiScatterSample {
    let isotropicPhase = 1.0 / (4.0 * DK_PI);
    let up = vec3f(0.0, 0.0, 1.0);
    let horizontal = dkPathHorizontal(up, direction);
    let hitsGround = dkIntersectsGround(a, h, direction.z);

    var result: DkMultiScatterSample;
    result.luminance = vec3f(0.0);
    result.transfer = vec3f(0.0);

    var path = dkPathStart(direction.z);
    var throughput = vec3f(1.0);
    for (var i = 0u; i < DK_SAMPLES_MULTI_SCATTERING; i = i + 1u) {
        let ds = dkPathRemaining(a, h, path, hitsGround) / f32(DK_SAMPLES_MULTI_SCATTERING - i);
        let step = dkPathAdvance(a, h, path, ds);
        path = step.next;

        let altitude = dkPathAltitude(a, h, step.middle.position);
        let pointUp = dkPathToWorld(dkPathUp(a, h, step.middle.position), up, horizontal);
        let muS = clamp(dot(pointUp, sunDirection), -1.0, 1.0);

        let scattering = a.betaR * dkDensityRayleigh(a, altitude) + a.betaMSca * dkDensityMie(a, altitude);
        let extinction = max(dkExtinction(a, altitude), vec3f(1e-9));
        let stepTransmittance = exp(-extinction * ds);

        // Zero where the planet shadows the sample, which the table knows.
        let sunTransmittance = dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, altitude, muS);

        // Integrated across the step analytically rather than as a point sample, so few samples suffice. The
        // sunlight scatters towards the ray with the isotropic phase; the transfer term is light scattered
        // from unit incoming radiance over the whole sphere, whose phase integrates to 1 (Hillaire eq. 7).
        let inScatter = sunTransmittance * scattering * isotropicPhase;
        result.luminance = result.luminance + throughput * (inScatter - inScatter * stepTransmittance) / extinction;
        result.transfer = result.transfer + throughput * (scattering - scattering * stepTransmittance) / extinction;

        throughput = throughput * stepTransmittance;
    }

    // Light that reached the ground bounces back up, diffusely and with the ground's albedo.
    if (hitsGround) {
        let groundUp = dkPathToWorld(dkPathUp(a, h, path.position), up, horizontal);
        let muSGround = clamp(dot(groundUp, sunDirection), -1.0, 1.0);
        if (muSGround > 0.0) {
            let toSun = dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, 0.0, muSGround);
            result.luminance = result.luminance
                + throughput * toSun * muSGround * a.groundAlbedo / DK_PI;
        }
    }

    return result;
}

// One workgroup per texel, as in Hillaire's own: its 64 invocations trace a direction each, and the sums over them are
// shared. Rather than one invocation tracing all 64, which leaves the GPU nearly idle on a table this small.
@compute @workgroup_size(64)
fn dkPrecomputeMultiScattering(
    @builtin(workgroup_id) texel: vec3u,
    @builtin(local_invocation_index) index: u32,
) {
    let a = dkAtmosphere;
    let size = vec2f(textureDimensions(dkMultiScatteringOut));
    let uv = (vec2f(texel.xy) + 0.5) / size;
    let altitudeMuS = dkMultiScatteringAltitudeMuS(a, uv, size);
    let h = altitudeMuS.x;
    let muS = altitudeMuS.y;
    let sunDirection = vec3f(sqrt(max(1.0 - muS * muS, 0.0)), 0.0, muS);

    // Uniform over the sphere: azimuth linear, polar angle inverted through the cosine, so that equal-area patches get
    // equal numbers of samples rather than clustering at the poles.
    let i = index % DK_MS_DIRECTIONS;
    let j = index / DK_MS_DIRECTIONS;
    let azimuth = 2.0 * DK_PI * (f32(i) + 0.5) / f32(DK_MS_DIRECTIONS);
    let cosPolar = 1.0 - 2.0 * (f32(j) + 0.5) / f32(DK_MS_DIRECTIONS);
    let sinPolar = sqrt(max(1.0 - cosPolar * cosPolar, 0.0));
    let direction = vec3f(sinPolar * cos(azimuth), sinPolar * sin(azimuth), cosPolar);
    let sample = dkIntegrateMultiScattering(a, h, direction, sunDirection);

    // Both are integrals over the sphere with the isotropic phase, 4 pi / N per direction times 1 / (4 pi):
    // plain averages over the directions (Hillaire eqs. 5 and 7).
    let directions = f32(DK_MS_DIRECTIONS * DK_MS_DIRECTIONS);
    let luminance = dkWorkgroupSum(vec4f(sample.luminance, 0.0), index).rgb / directions;
    let transfer = dkWorkgroupSum(vec4f(sample.transfer, 0.0), index).rgb / directions;

    // The geometric series over all remaining orders. Clamped below 1 because a transfer of 1 would mean a
    // perfectly conserving atmosphere and an infinite sum.
    let series = 1.0 / (1.0 - min(transfer, vec3f(0.999)));
    if (index == 0u) {
        textureStore(dkMultiScatteringOut, vec2i(texel.xy), vec4f(dkMultiScatteringEncode(luminance * series), 1.0));
    }
}
