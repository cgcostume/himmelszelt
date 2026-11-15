// An image's ground as more than a picture at infinity. Binding-free, over ENU directions, to look up in any map.
//
// Flat ground: everything below the horizon lies on a plane, z = 0, the image taken from `captureHeight` above it at the
// origin. A camera that moves then moves over the ground, and what stands on the plane stands on the image. Whatever
// truly rises above the ground, trees or a house, is smeared flat, the more the further the camera leaves the origin.
// Lifted horizon: the image stretched about its azimuths so that its horizon shows `lift` radians higher, the poles
// staying where they are, for a horizon that is not where the image has it.

// Both go over softly across `blend` radians around their horizon: the plane's stretch would otherwise set in at once.
// Where they stretch the image, `rbStretchedLods` picks mip levels that hide the streaks under an even blur.

// Where to look up in the image what a ray from `eye`, above the plane, sees along the unit `direction`. The plane's
// lookup is faded in over the `blend` radians below the horizon, so what lies in them does not lie quite on the plane.
fn rbFlatGroundDirection(eye: vec3f, direction: vec3f, captureHeight: f32, blend: f32) -> vec3f {
    if (direction.z >= 0.0 || eye.z <= 0.0) {
        return direction;
    }
    let hit = eye.xy + direction.xy * (-eye.z / direction.z);
    let onPlane = normalize(vec3f(hit, -captureHeight));
    let t = select(1.0, smoothstep(0.0, blend, asin(clamp(-direction.z, 0.0, 1.0))), blend > 0.0);
    return normalize(mix(direction, onPlane, t));
}

// Grounded dome: the image's ground on a disc of the plane and its sky on a sphere of `radius` about where it was taken,
// `captureHeight` above the disc's center, as three.js' GroundedSkybox and Unreal's HDRI Backdrop lay it out. Where to
// look up in the image what a ray from `eye`, inside the dome, sees along the unit `direction`: towards the point it
// meets, from where the image was taken. The disc meets the sphere without a seam, and nothing stretches without bound.
fn rbGroundedDomeDirection(eye: vec3f, direction: vec3f, captureHeight: f32, radius: f32) -> vec3f {
    let offset = eye - vec3f(0.0, 0.0, captureHeight);
    let b = dot(offset, direction);
    let disc = b * b - dot(offset, offset) + radius * radius;
    if (disc < 0.0) {
        return direction;
    }
    var t = sqrt(disc) - b;
    if (direction.z < 0.0 && eye.z > 0.0) {
        t = min(t, -eye.z / direction.z);
    }
    return select(direction, normalize(offset + direction * t), t > 0.0);
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
