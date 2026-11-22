// An image's ground as more than a picture at infinity. Binding-free, over ENU directions, to look up in any map.
//
// Grounded: the image laid on one smooth surface about where it was taken, `captureHeight` above the origin. Under the
// camera that took it lies the plane, z = 0, as far as `reach`; from the plane's level up, a sphere of `radius`. In
// between, the image recedes from the one to the other, by how far below its horizon it lies, never beyond the sphere:
// the ground rounds into the dome's foot. A camera that moves then moves over the ground, and what stands on the plane
// stands on the image, while what lies far off stays far off.
// Lifted horizon: the image stretched about its azimuths so that its horizon shows `lift` radians higher, the poles
// staying where they are, for a horizon that is not where the image has it.

// Where either stretches the image, `rbStretchedLods` picks mip levels that hide the streaks under an even blur.

// How far outside the surface the point `u` capture heights^-1 along a ray lies, below zero inside it. The surface is
// given by the inverse of its distance along every lookup, in capture heights: the plane's, the lookup's part downwards,
// from `edge` down; the dome's down to `foot` downwards; and between them the cubic that leaves the one and meets the
// other at the same slope, so it stays within the dome. With `foot` where the plane would cross the dome, `dome`
// downwards, it stays at the plane's level or under it; with `foot` higher up, the dome's wall rounds into the ground.
fn rbGroundedGap(u: f32, offset: vec3f, direction: vec3f, foot: f32, dome: f32, edge: f32) -> f32 {
    let p = direction + u * offset;
    let n = length(p);
    let down = -p.z / n;
    let t = clamp((down - foot) / max(edge - foot, 1e-9), 0.0, 1.0);
    let between = dome + t * t * ((edge - dome) * (3.0 - 2.0 * t) + (edge - foot) * (t - 1.0));
    return select(between, down, down >= edge) * n - u;
}

// Where to look up in the image what a ray from `eye`, above the plane and inside the dome, sees along the unit
// `direction`: towards the point it meets on the surface, from where the image was taken. The ground is flat up to
// `reach` from the origin, about half the dome's radius at most, which leaves the image room to round into the dome's
// foot without a crease, and the sky `radius` away; 1e9 for either is as good as without end.
// With both, it is the plane without bound, which smears whatever rises from it. With a small `reach` under a far dome,
// the ground falls away past its reach like a hilltop, and the horizon stays at infinity.
fn rbGroundedDirection(eye: vec3f, direction: vec3f, captureHeight: f32, reach: f32, radius: f32) -> vec3f {
    return rbGroundedDirectionRounded(eye, direction, captureHeight, reach, radius, 0.0);
}

// As rbGroundedDirection, with the dome's foot `rounding`, from -1 to 1: 0 as there, the ground dipping under the
// plane's level past its reach and rising into the dome where the plane would cross it; towards -1 the plane reaching on
// up to that line, a hard corner at -1; towards 1 the wall rounding into the ground from higher up, a fillet within the
// dome that begins at `rounding` capture heights above the plane, at 1 at the horizon, which stays where it is. The
// fillet takes that corner from the dome, so the eye belongs inside it. Within the reach it is still the one
// intersection, unless the ray passes the fillet's height beyond the plane's edge.
fn rbGroundedDirectionRounded(
    eye: vec3f,
    direction: vec3f,
    captureHeight: f32,
    reach: f32,
    radius: f32,
    rounding: f32,
) -> vec3f {
    let offset = (eye - vec3f(0.0, 0.0, captureHeight)) / captureHeight;
    let dome = captureHeight / radius;
    let within = 1.0 / (dome * dome) - dot(offset, offset);
    if (eye.z <= 0.0 || within <= 0.0) {
        return direction;
    }
    let rounded = clamp(rounding, -1.0, 1.0);
    let foot = dome * (1.0 - max(rounded, 0.0));
    let reached = max(captureHeight / length(vec2f(captureHeight, reach)), 2.0 * dome);
    let edge = select(reached, mix(dome, reached, 1.0 + rounded), rounded < 0.0);
    // The fillet lies under `top` and further out than the plane's edge: a ray kept out of there meets it nowhere.
    let top = captureHeight * max(rounded, 0.0);
    let flat = captureHeight * sqrt(max(1.0 - edge * edge, 0.0)) / edge;
    let entry = eye + direction * (max(eye.z - top, 0.0) / max(-direction.z, 1e-9));
    let rise = eye + direction * (max(top - eye.z, 0.0) / max(direction.z, 1e-9));
    // Every distance along the ray as its inverse, so that a sky without end is a plain zero.
    let b = dot(offset, direction);
    let root = sqrt(b * b + within);
    let sphere = select((root + b) / within, 1.0 / (root - b), b < 0.0);
    let onDome = normalize(direction + sphere * offset);
    // Down to the foot the surface is the dome, and a ray from above the fillet meets nothing before it.
    if (-onDome.z <= foot && (eye.z >= top || max(length(eye.xy), length(rise.xy)) <= flat)) {
        return onDome;
    }
    var near = sphere;
    var far = max(direction.z, 0.0) / max(-offset.z, 1e-9);
    var plane = 0.0;
    if (direction.z < 0.0) {
        plane = -direction.z * captureHeight / eye.z;
        let onPlane = normalize(direction + plane * offset);
        if (-onPlane.z >= edge && (top <= 0.0 || length(entry.xy) <= flat)) {
            return onPlane;
        }
        near = max(sphere, plane);
        far = min(sphere, plane);
    }
    // Between the two the ray leaves the surface: the first step that finds it outside, then the crossing itself.
    var a = near;
    var fa = 0.0;
    var c = far;
    var fc = 0.0;
    var found = false;
    if (top > 0.0) {
        // Rounded, it may leave before it comes down to the plane: from where it comes down to the fillet's height, or
        // from the eye, to the plane, the dome, or where it rises out of that height, in even steps of distance.
        var end = 1.0 / sphere;
        if (direction.z < 0.0) {
            end = min(end, 1.0 / plane);
        } else {
            end = min(end, max(top - eye.z, 0.0) / max(direction.z, 1e-9) / captureHeight);
        }
        let start = max(max(eye.z - top, 0.0) / max(-direction.z, 1e-9) / captureHeight, 1e-4 * end);
        a = 1.0 / start;
        fa = min(rbGroundedGap(a, offset, direction, foot, dome, edge), 0.0);
        for (var i = 1; i <= 8; i++) {
            c = 1.0 / mix(start, end, f32(i) / 8.0);
            fc = rbGroundedGap(c, offset, direction, foot, dome, edge);
            if (fc >= 0.0) {
                found = true;
                break;
            }
            a = c;
            fa = fc;
        }
        // Past that height inside the dome there is nothing to meet but the dome; below the plane, on as unrounded.
        if (!found && (direction.z >= 0.0 || plane <= sphere)) {
            return onDome;
        }
    }
    if (!found) {
        a = near;
        fa = min(rbGroundedGap(a, offset, direction, foot, dome, edge), 0.0);
        c = far;
        fc = 0.0;
        for (var i = 1; i <= 8; i++) {
            c = mix(near, far, f32(i) / 8.0);
            fc = rbGroundedGap(c, offset, direction, foot, dome, edge);
            if (fc >= 0.0) {
                break;
            }
            a = c;
            fa = fc;
        }
    }
    var u = c;
    var side = 0;
    for (var i = 0; i < 6; i++) {
        if (fc <= fa) {
            break;
        }
        u = (a * fc - c * fa) / (fc - fa);
        let f = rbGroundedGap(u, offset, direction, foot, dome, edge);
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
