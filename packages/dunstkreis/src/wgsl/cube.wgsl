// Cube maps, indexed by ENU directions (x east, y north, z up) the way WebGPU samples them: `textureSample(cube, s, d)`
// with an ENU direction d returns what was written for d. A y-up engine converts its direction first, (x, -z, y).
// Binding-free.

// The direction through the center of a texel of a cube face, faces in WebGPU's order +x, -x, +y, -y, +z, -z.
fn dkCubeDirection(face: u32, pixel: vec2u, size: u32) -> vec3f {
    return dkCubeDirectionAt(face, vec2f(pixel) + 0.5, size);
}

// The same through any point of a face, in texels from its corner.
fn dkCubeDirectionAt(face: u32, position: vec2f, size: u32) -> vec3f {
    let st = position / f32(size) * 2.0 - 1.0;
    let s = st.x;
    let t = st.y;
    var direction: vec3f;
    switch face {
        case 0u: { direction = vec3f(1.0, -t, -s); }
        case 1u: { direction = vec3f(-1.0, -t, s); }
        case 2u: { direction = vec3f(s, 1.0, t); }
        case 3u: { direction = vec3f(s, -1.0, -t); }
        case 4u: { direction = vec3f(s, -t, 1.0); }
        default: { direction = vec3f(-s, -t, -1.0); }
    }
    return normalize(direction);
}
