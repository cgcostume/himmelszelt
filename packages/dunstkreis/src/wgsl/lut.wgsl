// Mappings between physical parameters and LUT texture coordinates. Requires `atmosphere.wgsl` and
// `common.wgsl`. Like those, this declares no bindings and takes the struct by value.
//
// The transmittance mapping is Bruneton's, shared by both variants. It is not a linear remap of (r, mu):
// it is built around the distance to the top of the atmosphere, which concentrates resolution near the
// horizon where the sky's gradient is steep, and it is exactly invertible, which is what lets the precompute
// pass and the sampling path agree.

// Texels sample at their centres, so a unit-range value has to be squeezed into [0.5/n, 1 - 0.5/n] to line
// up with them. Getting this wrong shifts every LUT lookup by half a texel, which shows up as a seam at the
// horizon rather than as an obvious error.
fn dkUnitToTextureCoord(x: f32, n: f32) -> f32 {
    return 0.5 / n + x * (1.0 - 1.0 / n);
}

fn dkTextureToUnitCoord(u: f32, n: f32) -> f32 {
    return (u - 0.5 / n) / (1.0 - 1.0 / n);
}

// The transmittance table is indexed by the true direction light arrives from, the sun's, not by the local direction
// of the ray it arrives along: refraction bends one into the other. So it reaches below the geometric horizon, down to
// where no bent ray can come from, by an upper bound on the bending: twice the horizon's refraction, 1.1 times.
fn dkRefractionMargin(a: DkAtmosphere) -> f32 {
    return 1.1 * a.refractivity * sqrt(2.0 * DK_PI * a.Rg / a.HR);
}

// The lowest true mu the table holds at radius r: the geometric horizon, lowered by the margin. Its sine and cosine as
// polynomials, since WGSL's are only good to 2^-11.
fn dkTransmittanceMuMin(a: DkAtmosphere, r: f32) -> f32 {
    let m = dkRefractionMargin(a);
    return -dkRho(a, r) / r * (1.0 - 0.5 * m * m) - a.Rg / r * (m - m * m * m / 6.0);
}

// (r, mu) -> uv in the transmittance LUT.
fn dkTransmittanceUv(a: DkAtmosphere, r: f32, mu: f32, size: vec2f) -> vec2f {
    let H = dkHorizonDistanceAtTop(a);
    let rho = dkRho(a, r);

    let d = dkDistanceToTopAtmosphereBoundary(a, r, mu);
    let dMin = a.Rt - r;
    let dMax = dkDistanceToTopAtmosphereBoundary(a, r, dkTransmittanceMuMin(a, r));

    let xMu = select(0.0, (d - dMin) / max(dMax - dMin, 1e-6), dMax > dMin);
    let xR = rho / max(H, 1e-6);

    return vec2f(dkUnitToTextureCoord(xMu, size.x), dkUnitToTextureCoord(xR, size.y));
}

// uv in the transmittance LUT -> (r, mu, altitude). The exact inverse of the above, with the altitude from rho rather
// than from the radius, which f32 resolves to only ~0.5 m.
fn dkTransmittanceRMu(a: DkAtmosphere, uv: vec2f, size: vec2f) -> vec3f {
    let xMu = dkTextureToUnitCoord(uv.x, size.x);
    let xR = dkTextureToUnitCoord(uv.y, size.y);

    let H = dkHorizonDistanceAtTop(a);
    let rho = H * clamp(xR, 0.0, 1.0);
    let r = sqrt(rho * rho + a.Rg * a.Rg);

    let dMin = a.Rt - r;
    let dMax = dkDistanceToTopAtmosphereBoundary(a, r, dkTransmittanceMuMin(a, r));
    let d = dMin + clamp(xMu, 0.0, 1.0) * (dMax - dMin);

    var mu = 1.0;
    if (d > 0.0) {
        mu = (H * H - rho * rho - d * d) / (2.0 * r * d);
    }

    return vec3f(r, clamp(mu, -1.0, 1.0), rho * rho / (r + a.Rg));
}

// Hillaire's multiple-scattering LUT is indexed by the sun's elevation and the observer's altitude, both
// linearly: the table is small and smooth, so there is nothing to concentrate resolution on.
fn dkMultiScatteringUv(a: DkAtmosphere, r: f32, muS: f32, size: vec2f) -> vec2f {
    let xMuS = clamp(muS * 0.5 + 0.5, 0.0, 1.0);
    let xR = clamp((r - a.Rg) / max(a.Rt - a.Rg, 1e-6), 0.0, 1.0);

    return vec2f(dkUnitToTextureCoord(xMuS, size.x), dkUnitToTextureCoord(xR, size.y));
}

fn dkMultiScatteringRMuS(a: DkAtmosphere, uv: vec2f, size: vec2f) -> vec2f {
    let xMuS = dkTextureToUnitCoord(uv.x, size.x);
    let xR = dkTextureToUnitCoord(uv.y, size.y);

    return vec2f(a.Rg + clamp(xR, 0.0, 1.0) * (a.Rt - a.Rg), clamp(xMuS, 0.0, 1.0) * 2.0 - 1.0);
}

// The sky-view LUT is indexed by view direction, in a frame whose azimuth is measured from the sun. The vertical axis
// is the angle from the visible horizon, split there and square-rooted on each side, spending most of the resolution
// within a few degrees of it, which is where nearly all of the sky's variation lives. Measured from the horizon rather
// than through acos and cos, which WGSL promises only to 2^-11: enough to put the rows next to it on the wrong side.
fn dkSkyViewUv(a: DkAtmosphere, h: f32, mu: f32, cosLightAzimuth: f32, size: vec2f) -> vec2f {
    let horizon = dkHorizonMu(a, h);
    let horizonSin = sqrt(max(1.0 - horizon * horizon, 0.0));
    let zenithHorizonAngle = acos(clamp(horizon, -1.0, 1.0));
    let viewSin = sqrt(max(1.0 - mu * mu, 0.0));
    // The angle below the horizon, negative above it: atan2 is accurate relative to its result, so also close to 0.
    let below = atan2(viewSin * horizon - mu * horizonSin, mu * horizon + viewSin * horizonSin);

    var y: f32;
    if (below < 0.0) {
        y = (1.0 - sqrt(-below / max(zenithHorizonAngle, 1e-6))) * 0.5;
    } else {
        y = sqrt(below / max(DK_PI - zenithHorizonAngle, 1e-6)) * 0.5 + 0.5;
    }

    // The sky is symmetric about the sun's meridian, so only half a turn of azimuth has to be stored. The sun
    // sits at x = 0, where the square root makes x linear in the angle from it: resolution for the Mie glow.
    let x = sqrt(clamp(0.5 - cosLightAzimuth * 0.5, 0.0, 1.0));

    return vec2f(dkUnitToTextureCoord(x, size.x), dkUnitToTextureCoord(y, size.y));
}

// uv in the sky-view LUT -> (mu, cos of the azimuth from the sun). The exact inverse of the above, with the angle from
// the horizon's sine and cosine as polynomials where it is small.
fn dkSkyViewMuAzimuth(a: DkAtmosphere, h: f32, uv: vec2f, size: vec2f) -> vec2f {
    let x = dkTextureToUnitCoord(uv.x, size.x);
    let y = dkTextureToUnitCoord(uv.y, size.y);

    let horizon = dkHorizonMu(a, h);
    let horizonSin = sqrt(max(1.0 - horizon * horizon, 0.0));
    let zenithHorizonAngle = acos(clamp(horizon, -1.0, 1.0));

    var below: f32;
    if (y < 0.5) {
        let t = 1.0 - y * 2.0;
        below = -zenithHorizonAngle * t * t;
    } else {
        let t = (y - 0.5) * 2.0;
        below = (DK_PI - zenithHorizonAngle) * t * t;
    }
    let b2 = below * below;
    var cosBelow = cos(below);
    var sinBelow = sin(below);
    if (abs(below) < 0.3) {
        cosBelow = 1.0 - b2 * (0.5 - b2 * (1.0 / 24.0 - b2 / 720.0));
        sinBelow = below * (1.0 - b2 * (1.0 / 6.0 - b2 * (1.0 / 120.0 - b2 / 5040.0)));
    }

    return vec2f(horizon * cosBelow - horizonSin * sinBelow, 1.0 - clamp(x * x, 0.0, 1.0) * 2.0);
}
