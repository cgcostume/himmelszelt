// Transmittance LUT precompute, shared by both variants. Requires `atmosphere.wgsl`, `common.wgsl`,
// `lut.wgsl` and `quality.wgsl`.
//
// Unlike those snippets, this is a pass: it owns an entry point and therefore has to declare its bindings.
// The composable pieces stay binding-free; only the pipelines this package builds itself fix indices.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var dkTransmittanceOut: texture_storage_2d<rgba16float, write>;

struct DkTraceToTop {
    transmittance: vec3f,
    // The cosine of the direction the ray leaves the atmosphere in, in its start's frame.
    exitMu: f32,
}

// Follows a ray from altitude h with the local cosine mu up and out of the atmosphere, bent by the air, and integrates
// its optical depth by the midpoint rule. DK_SAMPLES_TRANSMITTANCE is an override, so the loop bound is a constant.
fn dkTraceToTop(a: DkAtmosphere, h: f32, mu: f32) -> DkTraceToTop {
    var path = dkPathStart(mu);
    var depth = vec3f(0.0);
    for (var i = 0u; i < DK_SAMPLES_TRANSMITTANCE; i = i + 1u) {
        let ds = dkPathRemaining(a, h, path, false) / f32(DK_SAMPLES_TRANSMITTANCE - i);
        let step = dkPathAdvance(a, h, path, ds);
        depth = depth + dkExtinction(a, dkPathAltitude(a, h, step.middle.position)) * ds;
        path = step.next;
    }
    return DkTraceToTop(exp(-depth), path.direction.y);
}

// Sunlight arriving from the true direction trueMu, at altitude h: along the ray that leaves the atmosphere in that
// direction. Bent rays arrive a little higher than they left, so the local direction is found by bisection, between
// trueMu and the margin above it. Below the lowest ray that still clears the ground, the planet hides the sun.
fn dkTransmittanceTowards(a: DkAtmosphere, h: f32, trueMu: f32) -> vec3f {
    let horizon = dkHorizonMu(a, h) + 1e-6;
    if (a.refractivity <= 0.0) {
        return select(vec3f(0.0), dkTraceToTop(a, h, trueMu).transmittance, trueMu >= horizon);
    }
    if (dkTraceToTop(a, h, horizon).exitMu > trueMu) {
        return vec3f(0.0);
    }
    var low = max(trueMu, horizon);
    var high = min(trueMu + dkRefractionMargin(a), 1.0);
    for (var i = 0u; i < 16u; i = i + 1u) {
        let middle = 0.5 * (low + high);
        if (dkTraceToTop(a, h, middle).exitMu < trueMu) {
            low = middle;
        } else {
            high = middle;
        }
    }
    return dkTraceToTop(a, h, 0.5 * (low + high)).transmittance;
}

@compute @workgroup_size(8, 8)
fn dkPrecomputeTransmittance(@builtin(global_invocation_id) id: vec3u) {
    let size = vec2f(textureDimensions(dkTransmittanceOut));
    if (f32(id.x) >= size.x || f32(id.y) >= size.y) {
        return;
    }

    let uv = (vec2f(f32(id.x), f32(id.y)) + 0.5) / size;
    let rMu = dkTransmittanceRMu(dkAtmosphere, uv, size);

    let transmittance = dkTransmittanceTowards(dkAtmosphere, rMu.z, rMu.y);
    textureStore(dkTransmittanceOut, vec2i(id.xy), vec4f(transmittance, 1.0));
}
