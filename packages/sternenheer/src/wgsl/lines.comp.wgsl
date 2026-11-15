// The constellations' lines onto the target: every line in pieces short enough to stay straight on a bent projection,
// each along the great circle between its two stars as the air lifts them, binned into the tiles it crosses, so the
// compose pass looks only at the pieces near each pixel. Requires `params.wgsl`, `camera.wgsl` (dunstkreis') and
// `stars.wgsl`.

@group(0) @binding(0) var<uniform> shParams: ShParams;
@group(0) @binding(1) var<storage, read> shCatalog: array<f32>;
// Per line: the constellation's index, its two stars' indices in the catalog, and a zero.
@group(0) @binding(2) var<storage, read> shLines: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> shPieces: array<ShPiece>;
@group(0) @binding(4) var<storage, read_write> shLineCounts: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> shLineEntries: array<u32>;
@group(0) @binding(6) var<storage, read> shFaint: array<u32>;
@group(0) @binding(7) var<storage, read> shFaintColors: array<vec4f>;

// A star's direction as it shows, and whether it shows above the horizon.
fn shShown(direction: vec3f) -> vec4f {
    var shown = direction;
    var up = direction.z >= shParams.horizonZ;
    if ((shParams.flags & SH_FLAG_AIR) != 0u) {
        shown = shLift(direction);
        up = up && shAltitude(shown) >= shParams.airHorizon;
    }
    return vec4f(shown, f32(up));
}

fn shLineTile(pixel: vec2f) -> vec2i {
    return vec2i(floor(pixel / f32(shParams.tileSize)));
}

@compute @workgroup_size(64, 1, 1)
fn shLinePieces(@builtin(global_invocation_id) id: vec3u) {
    let index = id.x / SH_LINE_PIECES;
    let piece = id.x % SH_LINE_PIECES;
    if (index >= arrayLength(&shLines)) {
        return;
    }
    shPieces[id.x] = ShPiece(vec2f(0.0), vec2f(0.0), vec2f(0.0), vec2f(0.0), 0.0, 0.0, 0.0, 0.0);
    let stars = shLines[index];
    if (((shParams.constellations[stars.x >> 5u] >> (stars.x & 31u)) & 1u) == 0u) {
        return;
    }
    let first = shShown(shStarDirection(stars.y));
    let second = shShown(shStarDirection(stars.z));
    if (first.w == 0.0 || second.w == 0.0) {
        return;
    }
    let a = shProject(normalize(mix(first.xyz, second.xyz, f32(piece) / f32(SH_LINE_PIECES))));
    let b = shProject(normalize(mix(first.xyz, second.xyz, f32(piece + 1u) / f32(SH_LINE_PIECES))));
    if (a.z <= 0.0 || b.z <= 0.0) {
        return;
    }
    // The stars the line stops short of, far away where the projection does not reach them.
    let starA = shProject(first.xyz);
    let starB = shProject(second.xyz);
    let reach = shParams.lineWidth + 1.0;
    let size = vec2f(f32(shParams.width), f32(shParams.height));
    if (any(max(a.xy, b.xy) < vec2f(-reach)) || any(min(a.xy, b.xy) > size + reach)) {
        return;
    }
    shPieces[id.x] = ShPiece(a.xy, b.xy, select(vec2f(-1e9), starA.xy, starA.z > 0.0), select(vec2f(-1e9), starB.xy, starB.z > 0.0), 1.0, 0.0, 0.0, 0.0);
    // Along the piece in steps of half a tile: into every tile a step's box touches that the step before did not.
    let tilesY = i32((shParams.height + shParams.tileSize - 1u) / shParams.tileSize);
    let last = vec2i(i32(shParams.tilesX) - 1, tilesY - 1);
    let steps = clamp(u32(ceil(length(b.xy - a.xy) / (0.5 * f32(shParams.tileSize)))), 1u, 512u);
    var before0 = vec2i(1, 1);
    var before1 = vec2i(0, 0);
    for (var s = 0u; s < steps; s = s + 1u) {
        let p0 = mix(a.xy, b.xy, f32(s) / f32(steps));
        let p1 = mix(a.xy, b.xy, f32(s + 1u) / f32(steps));
        let t0 = shLineTile(min(p0, p1) - reach);
        let t1 = shLineTile(max(p0, p1) + reach);
        if (any(t1 < vec2i(0)) || any(t0 > last)) {
            continue;
        }
        let low = max(t0, vec2i(0));
        let high = min(t1, last);
        for (var y = low.y; y <= high.y; y = y + 1) {
            for (var x = low.x; x <= high.x; x = x + 1) {
                let tile = vec2i(x, y);
                if (all(tile >= before0) && all(tile <= before1)) {
                    continue;
                }
                let t = u32(y) * shParams.tilesX + u32(x);
                let slot = atomicAdd(&shLineCounts[t], 1u);
                if (slot < SH_LINE_CAPACITY) {
                    shLineEntries[t * SH_LINE_CAPACITY + slot] = id.x;
                }
            }
        }
        before0 = low;
        before1 = high;
    }
}
