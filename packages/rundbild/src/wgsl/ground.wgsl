// An image's ground as more than a picture at infinity. Binding-free, over ENU directions, to look up in any map.
//
// Grounded: the image laid on one smooth surface about where it was taken, `captureHeight` above the origin. Under the
// camera that took it lies the plane, z = 0, as far as `reach`; the horizon and the sky lie on a sphere of `radius`.
// In between the ground rises from the plane into the sphere's wall, never under the plane and never beyond the sphere,
// so the dome has a rounded foot rather than a crease. A camera that moves then moves over the ground, and what stands
// on the plane stands on the image, while what lies far off stays far off.
// Lifted horizon: the image stretched about its azimuths so that its horizon shows `lift` radians higher, the poles
// staying where they are, for a horizon that is not where the image has it.

// Where either stretches the image, `rbStretchedLods` picks mip levels that hide the streaks under an even blur.

// How far outside the surface the point `u` capture heights^-1 along a ray lies, below zero inside it. The surface is
// given by its distance along every lookup from where the image was taken, in capture heights: the plane's, from the
// lookup `edge` down, `edge` and `foot` as the sines of how far below the horizon; the dome's down to `foot`; and
// between them, in the meridian through the lookup, the conic from the plane's edge, bend.x out, to where it meets the
// dome, bend.z the sine of how high up that is seen from the capture point: a rational quadratic Bezier curve whose
// control point lies on the plane bend.y out, where the dome's tangent there comes down to it, of the weight bend.w.
// A negative weight stands for a dome without end, whose ground falls away from the plane's edge as the cubic
// t^2 (2 - t) of the inverse distance, from the horizon.
fn rbGroundedGap(u: f32, offset: vec3f, direction: vec3f, foot: f32, dome: f32, edge: f32, bend: vec4f) -> f32 {
    let p = direction + u * offset;
    let n = length(p);
    let down = -p.z / n;
    var inverse = down;
    if (bend.w < 0.0) {
        let t = clamp((down - foot) / max(edge - foot, 1e-9), 0.0, 1.0);
        inverse = select(dome + (edge - dome) * t * t * (2.0 - t), down, down >= edge);
    } else if (down <= foot) {
        inverse = dome;
    } else if (down < edge) {
        // The curve's parameter where the lookup crosses it: its three points' sides of the lookup, weighed.
        let across = length(p.xy) / n;
        let r = 1.0 / dome;
        let meets = vec2f(r * sqrt(max(1.0 - bend.z * bend.z, 0.0)), 1.0 + r * bend.z);
        let a0 = across - bend.x * down;
        let a1 = across - bend.y * down;
        let a2 = -(meets.x * down + (meets.y - 1.0) * across);
        let qa = a0 - 2.0 * bend.w * a1 + a2;
        let qb = 2.0 * (bend.w * a1 - a0);
        let q = -0.5 * (qb + select(-1.0, 1.0, qb >= 0.0) * sqrt(max(qb * qb - 4.0 * qa * a0, 0.0)));
        var t = a0 / q;
        if ((t < 0.0 || t > 1.0) && abs(qa) > 1e-12) {
            t = q / qa;
        }
        t = clamp(t, 0.0, 1.0);
        let weights = vec3f((1.0 - t) * (1.0 - t), 2.0 * bend.w * t * (1.0 - t), t * t);
        let point = vec2f(bend.x * weights.x + bend.y * weights.y + meets.x * weights.z, meets.y * weights.z);
        inverse = 1.0 / length(point / (weights.x + weights.y + weights.z) - vec2f(0.0, 1.0));
    }
    return inverse * n - u;
}

// How high up the dome, in radians seen from the capture point, the ground meets it for a bend `soft` of the widest,
// from 0 to 1, under a dome of `radius`. The widest meets the dome where the image's horizon does, at `horizon` radians
// as rbLiftedHorizonDirection lifts it, 0 for none: a quarter circle as high as the capture point for a level horizon,
// more for a lifted one, less for a lowered one, and none once that horizon comes down to where the plane meets the
// dome. 0 is the hard corner there.
fn rbGroundedMeets(captureHeight: f32, radius: f32, soft: f32, horizon: f32) -> f32 {
    let r = radius / captureHeight;
    let rises = sin(horizon);
    let widest = clamp((1.0 + r * rises) / (1.0 + rises), 0.0, 0.5 * (r + 1.0));
    let up = clamp(soft, 0.0, 1.0) * widest;
    return asin(clamp((up - 1.0) / (r - up), -1.0, 1.0));
}

// The longest reach for a bend that meets the dome `meets` radians up: that of the circle which touches both, the bend
// rbGroundedDirection lays at that reach. A shorter reach draws it out into a flatter arc.
fn rbGroundedReach(captureHeight: f32, radius: f32, meets: f32) -> f32 {
    let r = radius / captureHeight;
    let rises = clamp(sin(meets), -1.0 / r, 0.99);
    let up = (1.0 + r * rises) / (1.0 + rises);
    return captureHeight * sqrt(max((r - 1.0) * (r + 1.0 - 2.0 * up), 0.0));
}

// Where to look up in the image what a ray from `eye`, inside the surface, sees along the unit `direction`: towards the
// point it meets on the surface, from where the image was taken. The ground is flat up to `reach` from the origin, and
// the sky lies `radius` away. In between the ground rises into the dome, in every meridian along a conic that leaves
// the plane level at the reach and meets the dome at its slope `meets` radians up, as seen from the capture point:
// at the reach rbGroundedReach gives, the one circle that touches both, and for a shorter one a flatter arc from
// further in to the same point on the dome. rbGroundedMeets gives the height for a share of the widest bend, which
// meets the dome where the image's horizon does; as low as where the plane meets the dome, it is a hard corner. The
// ground never sinks under the plane and never leaves the sphere, and above the bend the sky lies on it. 1e9 for either
// is as good as without end: with both, it is the plane without bound, which smears whatever rises from it; under a
// dome without end the ground falls away past its reach like a hilltop instead, `meets` unused, and the horizon stays at
// infinity. Within the reach the ray costs the one intersection, unless it passes through the bend's height beyond it.
fn rbGroundedDirection(
    eye: vec3f,
    direction: vec3f,
    captureHeight: f32,
    reach: f32,
    radius: f32,
    meets: f32,
) -> vec3f {
    let offset = (eye - vec3f(0.0, 0.0, captureHeight)) / captureHeight;
    let dome = captureHeight / radius;
    let within = 1.0 / (dome * dome) - dot(offset, offset);
    if (eye.z <= 0.0 || within <= 0.0) {
        return direction;
    }
    // The lookups to the plane's edge and to the bend's foot on the dome, as the sines of how far below the horizon,
    // the bend's points and weight in capture heights, and how high it reaches.
    var edge = captureHeight / length(vec2f(captureHeight, reach));
    var foot = dome;
    var bend = vec4f(0.0, 0.0, 0.0, -1.0);
    var top = 0.0;
    var flat = reach;
    if (radius < 1e9) {
        let r = 1.0 / dome;
        let rises = clamp(sin(meets), -dome, 0.99);
        let longest = rbGroundedReach(captureHeight, radius, meets) / captureHeight;
        let along = clamp(reach / captureHeight, 0.0, longest);
        // Where the dome's tangent comes down to the plane, and the weight that makes the bend the circle at its longest.
        let control = (r + rises) / sqrt(1.0 - rises * rises);
        bend = vec4f(along, control, rises, cos(0.5 * asin(rises) + 0.7853981633974483));
        edge = 1.0 / length(vec2f(1.0, along));
        foot = -rises;
        top = captureHeight * (1.0 + r * rises);
        flat = captureHeight * along;
        // A hard corner: the plane on up to the dome.
        if (top <= 1e-6 * captureHeight) {
            edge = foot;
            flat = captureHeight * longest;
        }
    }
    // The bend lies under `top` and further out than the plane's edge: a ray kept out of there meets it nowhere.
    let entry = eye + direction * (max(eye.z - top, 0.0) / max(-direction.z, 1e-9));
    let rise = eye + direction * (max(top - eye.z, 0.0) / max(direction.z, 1e-9));
    // Every distance along the ray as its inverse, so that a sky without end is a plain zero.
    let b = dot(offset, direction);
    let root = sqrt(b * b + within);
    let sphere = select((root + b) / within, 1.0 / (root - b), b < 0.0);
    let onDome = normalize(direction + sphere * offset);
    // Down to the foot the surface is the dome, and a ray from above the bend meets nothing before it.
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
        // With a bend, it may leave before it comes down to the plane: from where it comes down to the bend's height,
        // or from the eye, to the plane, the dome, or where it rises out of that height, in even steps of distance.
        var end = 1.0 / sphere;
        if (direction.z < 0.0) {
            end = min(end, 1.0 / plane);
        } else {
            end = min(end, max(top - eye.z, 0.0) / max(direction.z, 1e-9) / captureHeight);
        }
        let start = max(max(eye.z - top, 0.0) / max(-direction.z, 1e-9) / captureHeight, 1e-4 * end);
        a = 1.0 / start;
        fa = min(rbGroundedGap(a, offset, direction, foot, dome, edge, bend), 0.0);
        for (var i = 1; i <= 8; i++) {
            c = 1.0 / mix(start, end, f32(i) / 8.0);
            fc = rbGroundedGap(c, offset, direction, foot, dome, edge, bend);
            if (fc >= 0.0) {
                found = true;
                break;
            }
            a = c;
            fa = fc;
        }
        // Out of that height inside the dome there is nothing to meet but the dome, and the plane is the surface.
        if (!found) {
            return select(onDome, normalize(direction + plane * offset), direction.z < 0.0 && plane > sphere);
        }
    }
    if (!found) {
        a = near;
        fa = min(rbGroundedGap(a, offset, direction, foot, dome, edge, bend), 0.0);
        c = far;
        fc = 0.0;
        for (var i = 1; i <= 8; i++) {
            c = mix(near, far, f32(i) / 8.0);
            fc = rbGroundedGap(c, offset, direction, foot, dome, edge, bend);
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
        let f = rbGroundedGap(u, offset, direction, foot, dome, edge, bend);
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
