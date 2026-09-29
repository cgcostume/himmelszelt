// Cube maps, indexed by ENU directions (x east, y north, z up) the way WebGPU samples them: `textureSample(cube, s, d)`
// with an ENU direction d returns what was written for d. A y-up engine converts its direction first, (x, -z, y).
// Binding-free.
//
// A cubified cube map, osgHimmel's `cubify` after petrocket's sphere-to-cube mapping, lays its texels out over the
// sphere far more evenly: the largest texel spans 1.31 times the smallest one's solid angle, not 5.1 times, so the
// corners are no longer sharper than the face centers. Write it through `dkSphereFromCube` and sample it with
// `dkCubeFromSphere(d)` instead of d; hardware filtering, seamless across the edges, and the mip levels work as before.

// The point on the cube through any point of a face, in texels from its corner, faces in WebGPU's order +x, -x, +y, -y,
// +z, -z. One coordinate is ±1, the others within [-1, 1].
fn dkCubePointAt(face: u32, position: vec2f, size: u32) -> vec3f {
    let st = position / f32(size) * 2.0 - 1.0;
    let s = st.x;
    let t = st.y;
    switch face {
        case 0u: { return vec3f(1.0, -t, -s); }
        case 1u: { return vec3f(-1.0, -t, s); }
        case 2u: { return vec3f(s, 1.0, t); }
        case 3u: { return vec3f(s, -1.0, -t); }
        case 4u: { return vec3f(s, -t, 1.0); }
        default: { return vec3f(-s, -t, -1.0); }
    }
}

// The direction through the center of a texel of a cube face.
fn dkCubeDirection(face: u32, pixel: vec2u, size: u32) -> vec3f {
    return dkCubeDirectionAt(face, vec2f(pixel) + 0.5, size);
}

// The same through any point of a face.
fn dkCubeDirectionAt(face: u32, position: vec2f, size: u32) -> vec3f {
    return normalize(dkCubePointAt(face, position, size));
}

// The unit direction a point on the cube stands for in a cubified cube map.
fn dkSphereFromCube(p: vec3f) -> vec3f {
    let q = p * p;
    return p * sqrt(max(vec3f(1.0) - 0.5 * (q.yzx + q.zxy) + q.yzx * q.zxy / 3.0, vec3f(0.0)));
}

// The inverse on the face whose axis is z: the point on it, x and y, that stands for the unit direction d.
fn dkCubifyFace(d: vec3f) -> vec3f {
    let xx2 = d.x * d.x * 2.0;
    let yy2 = d.y * d.y * 2.0;
    let difference = vec2f(xx2 - yy2, yy2 - xx2);
    let ii = (difference.y - 3.0) * (difference.y - 3.0);
    let root = 3.0 - sqrt(max(ii - 12.0 * xx2, 0.0));
    let v = sqrt(max(difference + root, vec2f(0.0))) * 0.7071067811865476;
    return sign(d) * vec3f(v, 1.0);
}

// What a cubified cube map is sampled with for the unit direction d, the inverse of dkSphereFromCube: the point on the
// cube, on the face of d's largest component.
fn dkCubeFromSphere(d: vec3f) -> vec3f {
    let f = abs(d);
    if (f.y >= f.x && f.y >= f.z) {
        return dkCubifyFace(d.xzy).xzy;
    }
    if (f.x >= f.z) {
        return dkCubifyFace(d.yzx).zxy;
    }
    return dkCubifyFace(d);
}
