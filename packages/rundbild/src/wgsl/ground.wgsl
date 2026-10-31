// An image's ground as more than a picture at infinity. Binding-free, over ENU directions, to look up in any map.
//
// Flat ground: everything below the horizon lies on a plane, z = 0, the image taken from `captureHeight` above it at the
// origin. A camera that moves then moves over the ground, and what stands on the plane stands on the image. Whatever
// truly rises above the ground, trees or a house, is smeared flat, the more the further the camera leaves the origin.
// Lifted horizon: the image stretched about its azimuths so that its horizon shows `lift` radians higher, the poles
// staying where they are, for a horizon that is not where the image has it.

// Both go over softly across `blend` radians around their horizon: the plane's stretch would otherwise set in at once.

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
