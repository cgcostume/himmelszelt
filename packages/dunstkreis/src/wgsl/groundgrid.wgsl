// The ground's grid, for orientation, speed and height in a view one flies through: thin lines every 10 km, 1 km,
// 100 m and on down to 1 mm. Binding-free; requires `camera.wgsl`. Lengths in km, directions ENU.

const DK_GROUND_GRID_LEVELS: u32 = 8u;

// How far along the ray `v` from an observer `observer` km over a planet of `radius` km the ground lies, negative where
// the ray misses it. From the height itself rather than from the radii's squares, whose difference f32 loses a meter up.
fn dkGroundGridDistance(observer: f32, radius: f32, v: vec3f) -> f32 {
    let b = (radius + observer) * v.z;
    let c = observer * (2.0 * radius + observer);
    let h = b * b - c;
    if (v.z >= 0.0 || h < 0.0) {
        return -1.0;
    }
    return c / (sqrt(h) - b);
}

// Where the ground is hit, in km east and north of the point under the observer, along the arc.
fn dkGroundGridPoint(radius: f32, v: vec3f, t: f32) -> vec2f {
    let across = v.xy * t;
    let s = min(length(across) / radius, 1.0);
    return across * select(1.0 + s * s / 6.0, asin(s) / max(s, 1e-6), s > 1e-3);
}

fn dkGroundGridRay(inverseViewProjection: mat4x4f, projectionDistance: f32, position: vec2f, size: vec2u) -> vec3f {
    let uv = position / vec2f(size);
    return dkProjectRay(inverseViewProjection, vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0), clamp(projectionDistance, 0.0, 1.0));
}

// The grid through the pixel at `position` of a view `size` pixels large, 0 to 1: lines a pixel wide whichever way they
// run, from how fast east and north change across the screen there. A level is there once its cells are a few pixels
// across the way the pixel reaches farthest on the ground, and fainter while they are small: one measure for its lines
// both ways, so none run on as streaks where those crossing them have closed up. 0 off the ground. `offsets` holds how
// far the observer has flown per level as a share of that level's cell, two levels a vector, the coarsest first:
// `groundGridOffsets` on the CPU.
fn dkGroundGrid(inverseViewProjection: mat4x4f, projectionDistance: f32, observer: f32, radius: f32, offsets: array<vec4f, 4>, position: vec2f, size: vec2u) -> f32 {
    let v = dkGroundGridRay(inverseViewProjection, projectionDistance, position, size);
    let t = dkGroundGridDistance(observer, radius, v);
    if (t <= 0.0) {
        return 0.0;
    }
    let vx = dkGroundGridRay(inverseViewProjection, projectionDistance, position + vec2f(1.0, 0.0), size);
    let vy = dkGroundGridRay(inverseViewProjection, projectionDistance, position + vec2f(0.0, 1.0), size);
    let tx = dkGroundGridDistance(observer, radius, vx);
    let ty = dkGroundGridDistance(observer, radius, vy);
    if (tx <= 0.0 || ty <= 0.0) {
        return 0.0;
    }
    let g = dkGroundGridPoint(radius, v, t);
    let dx = dkGroundGridPoint(radius, vx, tx) - g;
    let dy = dkGroundGridPoint(radius, vy, ty) - g;
    // How fast east and north change per pixel, and the pixel's longest reach on the ground, all in km.
    let slope = max(sqrt(dx * dx + dy * dy), vec2f(1e-12));
    let spread = dot(dx, dx) + dot(dy, dy);
    let area = dx.x * dy.y - dx.y * dy.x;
    let reach = sqrt(0.5 * (spread + sqrt(max(spread * spread - 4.0 * area * area, 0.0))));
    var amount = 0.0;
    var cell = 10.0;
    for (var k = 0u; k < DK_GROUND_GRID_LEVELS; k = k + 1u) {
        // Pixels across a cell where it is narrowest and where it is widest: below four the lines have run together.
        let across = cell / reach;
        if (across > 4.0) {
            let offset = select(offsets[k / 2u].xy, offsets[k / 2u].zw, (k & 1u) == 1u);
            let away = abs(fract(g / cell + offset + 0.5) - 0.5);
            let line = clamp(1.0 - away * cell / slope, vec2f(0.0), vec2f(1.0));
            let wide = cell * reach / max(abs(area), 1e-24);
            let seen = smoothstep(4.0, 16.0, across) * mix(0.45, 1.0, smoothstep(30.0, 300.0, wide));
            amount = max(amount, max(line.x, line.y) * seen);
        }
        cell = cell * 0.1;
    }
    return amount;
}
