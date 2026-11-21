// An image's ground as more than a picture at infinity. Binding-free, over ENU directions, to look up in any map.
//
// Grounded: the image laid on one smooth surface about where it was taken, `captureHeight` above the origin. Under the
// camera that took it lies the plane, z = 0, as far as `reach`; at the horizon and above it, a sphere of `radius`. In
// between, the image recedes from the one to the other, by how far below its horizon it lies. A camera that moves then
// moves over the ground, and what stands on the plane stands on the image, while what lies far off stays far off.
// Lifted horizon: the image stretched about its azimuths so that its horizon shows `lift` radians higher, the poles
// staying where they are, for a horizon that is not where the image has it.

// Where either stretches the image, `rbStretchedLods` picks mip levels that hide the streaks under an even blur.

// How far outside the surface the point `u` capture heights^-1 along a ray lies, below zero inside it. The surface is
// given by the inverse of its distance along every lookup, in capture heights: the plane's, the lookup's part downwards,
// from `edge` down, the dome's from the horizon up, and between them the one faded into the other.
fn rbGroundedGap(u: f32, offset: vec3f, direction: vec3f, edge: f32, dome: f32) -> f32 {
    let p = direction + u * offset;
    let n = length(p);
    let down = -p.z / n;
    return mix(dome, down, smoothstep(0.0, edge, down)) * n - u;
}

// Where to look up in the image what a ray from `eye`, above the plane and inside the dome, sees along the unit
// `direction`: towards the point it meets on the surface, from where the image was taken. The ground is flat up to
// `reach` from the origin, about half the dome's radius at most, which leaves the image room to rise into the dome
// without a crease, and the sky `radius` away; 1e9 for either is as good as without end.
// With both, it is the plane without bound, which smears whatever rises from it. With a small `reach` under a far dome,
// the ground falls away past its reach like a hilltop, and the horizon stays at infinity.
fn rbGroundedDirection(eye: vec3f, direction: vec3f, captureHeight: f32, reach: f32, radius: f32) -> vec3f {
    let offset = (eye - vec3f(0.0, 0.0, captureHeight)) / captureHeight;
    let dome = captureHeight / radius;
    let within = 1.0 / (dome * dome) - dot(offset, offset);
    if (eye.z <= 0.0 || within <= 0.0) {
        return direction;
    }
    // Every distance along the ray as its inverse, so that a sky without end is a plain zero.
    let b = dot(offset, direction);
    let root = sqrt(b * b + within);
    let sphere = select((root + b) / within, 1.0 / (root - b), b < 0.0);
    let onDome = normalize(direction + sphere * offset);
    if (onDome.z >= 0.0) {
        return onDome;
    }
    let edge = max(captureHeight / length(vec2f(captureHeight, reach)), 2.0 * dome);
    var near = sphere;
    var far = max(direction.z, 0.0) / max(-offset.z, 1e-9);
    if (direction.z < 0.0) {
        let plane = -direction.z * captureHeight / eye.z;
        let onPlane = normalize(direction + plane * offset);
        if (-onPlane.z >= edge) {
            return onPlane;
        }
        near = max(sphere, plane);
        far = min(sphere, plane);
    }
    // Between the two the ray leaves the surface: the first step that finds it outside, then the crossing itself.
    var a = near;
    var fa = min(rbGroundedGap(a, offset, direction, edge, dome), 0.0);
    var c = far;
    var fc = 0.0;
    for (var i = 1; i <= 8; i++) {
        c = mix(near, far, f32(i) / 8.0);
        fc = rbGroundedGap(c, offset, direction, edge, dome);
        if (fc >= 0.0) {
            break;
        }
        a = c;
        fa = fc;
    }
    var u = c;
    var side = 0;
    for (var i = 0; i < 6; i++) {
        if (fc <= fa) {
            break;
        }
        u = (a * fc - c * fa) / (fc - fa);
        let f = rbGroundedGap(u, offset, direction, edge, dome);
        if (f < 0.0) {
            a = u;
            fa = f;
            fc *= select(1.0, 0.5, side < 0);
            side = -1;
        } else {
            c = u;
            fc = f;
            fa *= select(1.0, 0.5, side > 0);
            side = 1;
        }
    }
    return normalize(direction + u * offset);
}

// Where to look up in the image what shows along the unit `direction` with its horizon lifted, |lift| below pi / 2. The
// two stretches, below and above, are faded into one another over `blend` radians either side of the new horizon.
fn rbLiftedHorizonDirection(direction: vec3f, lift: f32, blend: f32) -> vec3f {
    let quarter = 1.5707963267948966;
    let h = length(direction.xy);
    if (h <= 0.0) {
        return direction;
    }
    let elevation = asin(clamp(direction.z, -1.0, 1.0));
    let above = (elevation - lift) * quarter / (quarter - lift);
    let below = (elevation + quarter) * quarter / (lift + quarter) - quarter;
    let t = select(select(0.0, 1.0, elevation >= lift), smoothstep(lift - blend, lift + blend, elevation), blend > 0.0);
    let mapped = mix(below, above, t);
    return vec3f(direction.xy / h * cos(mapped), sin(mapped));
}

// The mip levels along an equirectangular image's u and v to read it at, for any azimuth at its left edge: the image
// blurred to its coarser axis on screen, evenly rather than in streaks, where either stretch magnifies it one way and
// shrinks it the other, and filtered as usual where it does not. `center` is the direction a pixel looks up in the
// image, `alongX` and `alongY` those its neighbours to the side and below look up, `size` the image's size in texels.
fn rbStretchedLods(center: vec3f, alongX: vec3f, alongY: vec3f, size: vec2f) -> vec2f {
    let tau = 6.283185307179586;
    let c = vec2f(atan2(center.x, center.y), asin(clamp(center.z, -1.0, 1.0)));
    var x = vec2f(atan2(alongX.x, alongX.y), asin(clamp(alongX.z, -1.0, 1.0))) - c;
    var y = vec2f(atan2(alongY.x, alongY.y), asin(clamp(alongY.z, -1.0, 1.0))) - c;
    x.x -= tau * round(x.x / tau);
    y.x -= tau * round(y.x / tau);
    let texels = max(abs(x), abs(y)) * size / vec2f(tau, 0.5 * tau);
    let pixels = clamp(1.0 / min(texels.x, texels.y), 1.0, 65536.0);
    return max(vec2f(0.0), log2(max(texels * pixels, vec2f(1e-6))));
}
