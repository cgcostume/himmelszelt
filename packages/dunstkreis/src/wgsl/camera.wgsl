// The camera's rays, binding-free: a clip-space point turned back into a direction by an inverse view-projection matrix,
// and a projection bent towards a fisheye. Shared with `@himmelszelt/gewoelk`, whose clouds have to sit on the same rays
// as the sky.

// The direction through a clip-space point: from the eye, which a perspective projection maps to (0, 0, c, 0), to the
// point halfway into the depth range. So any perspective works: depth in [0, 1] or [-1, 1], reversed, with an infinite
// far plane. A view with translation works too, but costs f32 precision, so leave it out, as for a skybox.
fn dkUnproject(inverseViewProjection: mat4x4f, ndc: vec2f) -> vec3f {
    let eye = inverseViewProjection[2];
    let point = inverseViewProjection * vec4f(ndc, 0.5, 1.0);
    return normalize(point.xyz / point.w - eye.xyz / eye.w);
}

// The camera ray through a clip-space point. The matrix gives the camera's axis and its image plane; the image plane's
// radius rho then maps to the angle theta from the axis by a general perspective: the sphere of directions projected
// from a point d behind the eye, rho = (d + 1) sin(theta) / (d + cos(theta)). d = 0 is the matrix's own rectilinear
// projection, theta = atan(rho); d = 1 is stereographic, theta = 2 atan(rho / 2), which shows the whole sky as a disc
// looking up and a small planet looking down.
fn dkProjectRay(inverseViewProjection: mat4x4f, ndc: vec2f, d: f32) -> vec3f {
    let view = dkUnproject(inverseViewProjection, ndc);
    if (d <= 0.0) {
        return view;
    }
    let center = dkUnproject(inverseViewProjection, vec2f(0.0));
    let along = dot(view, center);
    let offset = view - center * along;
    let rho = length(offset) / along;
    if (rho < 1e-7) {
        return center;
    }
    let k = rho / (d + 1.0);
    let cosTheta = (sqrt(1.0 + k * k * (1.0 - d * d)) - k * k * d) / (1.0 + k * k);
    let sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));
    return center * cosTheta + normalize(offset) * sinTheta;
}
