// Transmittance LUT precompute. Requires `atmosphere.wgsl`, `common.wgsl`,
// `lut.wgsl` and `quality.wgsl`.
//
// Unlike those snippets, this is a pass: it owns an entry point and therefore has to declare its bindings.
// The composable pieces stay binding-free; only the pipelines this package builds itself fix indices.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var dkTransmittanceOut: texture_storage_2d<rgba16float, write>;

struct DkTraceToTop {
    transmittance: vec4f,
    // The cosine of the direction the ray leaves the atmosphere in, in its start's frame.
    exitMu: f32,
}

// Follows a ray from altitude h with the local cosine mu up and out of the atmosphere, bent by the air, and integrates
// its optical depth by the midpoint rule. DK_SAMPLES_TRANSMITTANCE is an override, so the loop bound is a constant.
fn dkTraceToTop(a: DkAtmosphere, h: f32, mu: f32) -> DkTraceToTop {
    var path = dkPathStart(mu);
    let total = dkPathRemainingStart(a, h, path, false);
    var depth = vec4f(0.0);
    for (var i = 0u; i < DK_SAMPLES_TRANSMITTANCE; i = i + 1u) {
        var remaining = total * f32(DK_SAMPLES_TRANSMITTANCE - i) / f32(DK_SAMPLES_TRANSMITTANCE);
        if (DK_REFRACTION) {
            remaining = dkPathRemaining(a, h, path, false);
        }
        let ds = remaining / f32(DK_SAMPLES_TRANSMITTANCE - i);
        let step = dkPathAdvance(a, h, path, ds);
        depth = depth + dkExtinction(a, step.altitude) * ds;
        path = step.next;
    }
    return DkTraceToTop(exp(-depth), path.direction.y);
}

// How close the traced ray's exit direction has to come to the true one, in its cosine: 0.2 arcseconds at the horizon,
// where the table is finest, and no texel moved by more than 0.2% against a bisection three times as fine.
const DK_EXIT_MU_TOLERANCE: f32 = 1e-6;

// Sunlight arriving from the true direction trueMu, at altitude h: along the ray that leaves the atmosphere in that
// direction. Bent rays arrive a little higher than they left, so the local direction is solved for, between trueMu
// and the margin above it, by the Illinois variant of regula falsi: the exit direction rises smoothly with the start
// direction, so it converges in a few traces where a bisection took 16. Below the lowest ray that still clears the
// ground, the planet hides the sun.
fn dkTransmittanceTowards(a: DkAtmosphere, h: f32, trueMu: f32) -> vec4f {
    let horizon = dkHorizonMu(a, h) + 1e-6;
    if (dkGroundRefractivity(a) <= 0.0) {
        return select(vec4f(0.0), dkTraceToTop(a, h, trueMu).transmittance, trueMu >= horizon);
    }
    // The bracket: f(mu) = exitMu(mu) - trueMu, below zero at the low end, above at the high end.
    var low = horizon;
    var lowTrace = dkTraceToTop(a, h, low);
    if (lowTrace.exitMu > trueMu) {
        return vec4f(0.0);
    }
    if (trueMu > horizon) {
        low = trueMu;
        lowTrace = dkTraceToTop(a, h, low);
    }
    var fLow = lowTrace.exitMu - trueMu;
    if (fLow >= 0.0) {
        return lowTrace.transmittance;
    }
    var high = min(trueMu + dkRefractionMargin(a), 1.0);
    var trace = dkTraceToTop(a, h, high);
    var fHigh = trace.exitMu - trueMu;
    if (fHigh <= 0.0) {
        return trace.transmittance;
    }
    var side = 0;
    for (var i = 0u; i < 8u; i = i + 1u) {
        let mu = (low * fHigh - high * fLow) / (fHigh - fLow);
        trace = dkTraceToTop(a, h, mu);
        let f = trace.exitMu - trueMu;
        if (abs(f) < DK_EXIT_MU_TOLERANCE) {
            break;
        }
        if (f < 0.0) {
            low = mu;
            fLow = f;
            // The Illinois step: an end kept twice in a row has its value halved, so the secant does not stall there.
            fHigh = select(fHigh, 0.5 * fHigh, side == -1);
            side = -1;
        } else {
            high = mu;
            fHigh = f;
            fLow = select(fLow, 0.5 * fLow, side == 1);
            side = 1;
        }
    }
    return trace.transmittance;
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
    textureStore(dkTransmittanceOut, vec2i(id.xy), transmittance);
}
