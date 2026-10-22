// Panoramas: the sphere of directions laid out on one 2D texture, indexed by ENU directions (x east, y north, z up), uv
// from the texture's top left corner, [0, 1] each way. Binding-free. Three projections:
//
// Equirectangular (1), as HDRIs are shared: the azimuth across, north at the left edge, east a quarter in, south in the
// middle and west three quarters in, the zenith angle down, the zenith at the top and the nadir at the bottom, 2:1; or
// with `upperHalf` the horizon at the bottom, 4:1. Seen from inside, as the sky is: facing south, east is on the left.
// Octahedral (2): the sphere onto an octahedron, unfolded into a square, the zenith in the middle, the upper hemisphere
// in the inner diamond and the lower one folded into the corners.
// Fisheye (3), as an all-sky camera sees the upper hemisphere: azimuthal equidistant, the zenith in the middle, the
// horizon on the inscribed circle, the distance from the middle in proportion to the zenith angle.
// Octahedral and fisheye are laid out as a sky chart held overhead: north at the top, east on the left. The
// equirectangular's upper half takes a direction below the horizon to the horizon at its azimuth; the fisheye takes it to
// its top left corner, beyond the circle, where the sky pass stores the ground.
//
// `azimuthOffset`, in radians, turns each about the zenith: it is the azimuth at the equirectangular's left edge and at
// the top of the others, 0 for north.

const DK_EQUIRECTANGULAR: u32 = 1u;
const DK_OCTAHEDRAL: u32 = 2u;
const DK_FISHEYE: u32 = 3u;

const DK_PANORAMA_PI: f32 = 3.141592653589793;

// d turned so that the azimuth `azimuthOffset` points along y, and the azimuth 90° further along x.
fn dkPanoramaLocal(d: vec3f, azimuthOffset: f32) -> vec3f {
    let c = cos(azimuthOffset);
    let s = sin(azimuthOffset);
    return vec3f(c * d.x - s * d.y, s * d.x + c * d.y, d.z);
}

// The inverse of dkPanoramaLocal.
fn dkPanoramaWorld(l: vec3f, azimuthOffset: f32) -> vec3f {
    let c = cos(azimuthOffset);
    let s = sin(azimuthOffset);
    return vec3f(c * l.x + s * l.y, c * l.y - s * l.x, l.z);
}

fn dkSignNotZero(v: vec2f) -> vec2f {
    return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0));
}

fn dkEquirectangularUv(d: vec3f, azimuthOffset: f32, upperHalf: bool) -> vec2f {
    let l = dkPanoramaLocal(d, azimuthOffset);
    let zenithAngle = acos(clamp(l.z, -1.0, 1.0)) / select(DK_PANORAMA_PI, 0.5 * DK_PANORAMA_PI, upperHalf);
    return vec2f(fract(atan2(l.x, l.y) / (2.0 * DK_PANORAMA_PI)), min(zenithAngle, 1.0));
}

fn dkEquirectangularDirection(uv: vec2f, azimuthOffset: f32, upperHalf: bool) -> vec3f {
    let azimuth = uv.x * 2.0 * DK_PANORAMA_PI;
    let zenithAngle = uv.y * select(DK_PANORAMA_PI, 0.5 * DK_PANORAMA_PI, upperHalf);
    let l = vec3f(sin(zenithAngle) * sin(azimuth), sin(zenithAngle) * cos(azimuth), cos(zenithAngle));
    return dkPanoramaWorld(l, azimuthOffset);
}

fn dkOctahedralUv(d: vec3f, azimuthOffset: f32) -> vec2f {
    let l = dkPanoramaLocal(d, azimuthOffset);
    let p = l / (abs(l.x) + abs(l.y) + abs(l.z));
    let q = select(p.xy, (1.0 - abs(p.yx)) * dkSignNotZero(p.xy), p.z < 0.0);
    return 0.5 - 0.5 * q;
}

fn dkOctahedralDirection(uv: vec2f, azimuthOffset: f32) -> vec3f {
    let q = 1.0 - 2.0 * uv;
    let z = 1.0 - abs(q.x) - abs(q.y);
    let xy = select(q, (1.0 - abs(q.yx)) * dkSignNotZero(q), z < 0.0);
    return dkPanoramaWorld(normalize(vec3f(xy, z)), azimuthOffset);
}

fn dkFisheyeUv(d: vec3f, azimuthOffset: f32) -> vec2f {
    let l = dkPanoramaLocal(d, azimuthOffset);
    if (l.z < 0.0) {
        return vec2f(0.0);
    }
    let r = min(acos(clamp(l.z, -1.0, 1.0)) / (0.5 * DK_PANORAMA_PI), 1.0);
    let h = length(l.xy);
    return 0.5 - 0.5 * select(vec2f(0.0), l.xy / h * r, h > 0.0);
}

// Past the inscribed circle, the horizon at the azimuth.
fn dkFisheyeDirection(uv: vec2f, azimuthOffset: f32) -> vec3f {
    let q = 1.0 - 2.0 * uv;
    let r = min(length(q), 1.0);
    let zenithAngle = r * 0.5 * DK_PANORAMA_PI;
    let xy = select(vec2f(0.0), normalize(q) * sin(zenithAngle), r > 0.0);
    return dkPanoramaWorld(vec3f(xy, cos(zenithAngle)), azimuthOffset);
}

// The texture coordinates of the unit direction d in a panorama of `projection`, one of the constants above.
fn dkPanoramaUv(projection: u32, d: vec3f, azimuthOffset: f32, upperHalf: bool) -> vec2f {
    switch projection {
        case 2u: { return dkOctahedralUv(d, azimuthOffset); }
        case 3u: { return dkFisheyeUv(d, azimuthOffset); }
        default: { return dkEquirectangularUv(d, azimuthOffset, upperHalf); }
    }
}

// The unit direction at texture coordinates uv of a panorama of `projection`.
fn dkPanoramaDirection(projection: u32, uv: vec2f, azimuthOffset: f32, upperHalf: bool) -> vec3f {
    switch projection {
        case 2u: { return dkOctahedralDirection(uv, azimuthOffset); }
        case 3u: { return dkFisheyeDirection(uv, azimuthOffset); }
        default: { return dkEquirectangularDirection(uv, azimuthOffset, upperHalf); }
    }
}
