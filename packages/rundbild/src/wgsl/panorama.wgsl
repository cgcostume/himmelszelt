// Panoramas: the sphere of directions laid out on one 2D texture, indexed by ENU directions (x east, y north, z up), uv
// from the texture's top left corner, [0, 1] each way. Binding-free. Four projections:
//
// Equirectangular (1), as HDRIs are shared: the azimuth across, north at the left edge, east a quarter in, south in the
// middle and west three quarters in, the zenith angle down, the zenith at the top and the nadir at the bottom, 2:1.
// Seen from inside, as the sky is: facing south, east is on the left.
// Octahedral (2): the sphere onto an octahedron, unfolded into a square, the zenith in the middle, the upper hemisphere
// in the inner diamond and the lower one folded into the corners.
// Fisheye (3), as an all-sky camera sees the upper hemisphere: azimuthal equidistant, the zenith in the middle, the
// horizon on the inscribed circle, the distance from the middle in proportion to the zenith angle.
// Sphere map (4), as a mirror ball shows the whole sphere: the zenith in the middle, the horizon at 0.71 of the radius
// and the nadir all round the inscribed circle, the distance from the middle sin(zenith angle / 2), equal in area.
// Octahedral, fisheye and sphere map are laid out as a sky chart held overhead: north at the top, east on the left.
// The fisheye takes a direction below the horizon to its top left corner, beyond the circle, where the sky pass stores
// the ground; its other texels beyond the circle hold the horizon, as the sphere map's hold the nadir, so a filtered
// lookup at the rim blends into what lies there.
//
// `azimuthOffset`, in radians, turns each about the zenith: it is the azimuth at the equirectangular's left edge and at
// the top of the others, 0 for north.

const RB_EQUIRECTANGULAR: u32 = 1u;
const RB_OCTAHEDRAL: u32 = 2u;
const RB_FISHEYE: u32 = 3u;
const RB_SPHERE_MAP: u32 = 4u;

const RB_PANORAMA_PI: f32 = 3.141592653589793;

// d turned so that the azimuth `azimuthOffset` points along y, and the azimuth 90° further along x.
fn rbPanoramaLocal(d: vec3f, azimuthOffset: f32) -> vec3f {
    let c = cos(azimuthOffset);
    let s = sin(azimuthOffset);
    return vec3f(c * d.x - s * d.y, s * d.x + c * d.y, d.z);
}

// The inverse of rbPanoramaLocal.
fn rbPanoramaWorld(l: vec3f, azimuthOffset: f32) -> vec3f {
    let c = cos(azimuthOffset);
    let s = sin(azimuthOffset);
    return vec3f(c * l.x + s * l.y, c * l.y - s * l.x, l.z);
}

fn rbSignNotZero(v: vec2f) -> vec2f {
    return select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0));
}

fn rbEquirectangularUv(d: vec3f, azimuthOffset: f32) -> vec2f {
    let l = rbPanoramaLocal(d, azimuthOffset);
    let zenithAngle = acos(clamp(l.z, -1.0, 1.0)) / RB_PANORAMA_PI;
    return vec2f(fract(atan2(l.x, l.y) / (2.0 * RB_PANORAMA_PI)), zenithAngle);
}

fn rbEquirectangularDirection(uv: vec2f, azimuthOffset: f32) -> vec3f {
    let azimuth = uv.x * 2.0 * RB_PANORAMA_PI;
    let zenithAngle = uv.y * RB_PANORAMA_PI;
    let l = vec3f(sin(zenithAngle) * sin(azimuth), sin(zenithAngle) * cos(azimuth), cos(zenithAngle));
    return rbPanoramaWorld(l, azimuthOffset);
}

fn rbOctahedralUv(d: vec3f, azimuthOffset: f32) -> vec2f {
    let l = rbPanoramaLocal(d, azimuthOffset);
    let p = l / (abs(l.x) + abs(l.y) + abs(l.z));
    let q = select(p.xy, (1.0 - abs(p.yx)) * rbSignNotZero(p.xy), p.z < 0.0);
    return 0.5 - 0.5 * q;
}

fn rbOctahedralDirection(uv: vec2f, azimuthOffset: f32) -> vec3f {
    let q = 1.0 - 2.0 * uv;
    let z = 1.0 - abs(q.x) - abs(q.y);
    let xy = select(q, (1.0 - abs(q.yx)) * rbSignNotZero(q), z < 0.0);
    return rbPanoramaWorld(normalize(vec3f(xy, z)), azimuthOffset);
}

fn rbFisheyeUv(d: vec3f, azimuthOffset: f32) -> vec2f {
    let l = rbPanoramaLocal(d, azimuthOffset);
    if (l.z < 0.0) {
        return vec2f(0.0);
    }
    let r = min(acos(clamp(l.z, -1.0, 1.0)) / (0.5 * RB_PANORAMA_PI), 1.0);
    let h = length(l.xy);
    return 0.5 - 0.5 * select(vec2f(0.0), l.xy / h * r, h > 0.0);
}

// Past the inscribed circle, the horizon at the azimuth.
fn rbFisheyeDirection(uv: vec2f, azimuthOffset: f32) -> vec3f {
    let q = 1.0 - 2.0 * uv;
    let r = min(length(q), 1.0);
    let zenithAngle = r * 0.5 * RB_PANORAMA_PI;
    let xy = select(vec2f(0.0), normalize(q) * sin(zenithAngle), r > 0.0);
    return rbPanoramaWorld(vec3f(xy, cos(zenithAngle)), azimuthOffset);
}

fn rbSphereMapUv(d: vec3f, azimuthOffset: f32) -> vec2f {
    let l = rbPanoramaLocal(d, azimuthOffset);
    let h = length(l.xy);
    let r = sqrt(max(0.5 - 0.5 * l.z, 0.0));
    return 0.5 - 0.5 * select(vec2f(0.0, -1.0), l.xy / h, h > 0.0) * r;
}

// Past the inscribed circle, the nadir.
fn rbSphereMapDirection(uv: vec2f, azimuthOffset: f32) -> vec3f {
    var q = 1.0 - 2.0 * uv;
    let r = length(q);
    if (r > 1.0) {
        q = q / r;
    }
    let rr = min(r * r, 1.0);
    return rbPanoramaWorld(vec3f(q * 2.0 * sqrt(1.0 - rr), 1.0 - 2.0 * rr), azimuthOffset);
}

// The texture coordinates of the unit direction d in a panorama of `projection`, one of the constants above.
fn rbPanoramaUv(projection: u32, d: vec3f, azimuthOffset: f32) -> vec2f {
    switch projection {
        case 2u: { return rbOctahedralUv(d, azimuthOffset); }
        case 3u: { return rbFisheyeUv(d, azimuthOffset); }
        case 4u: { return rbSphereMapUv(d, azimuthOffset); }
        default: { return rbEquirectangularUv(d, azimuthOffset); }
    }
}

// The unit direction at texture coordinates uv of a panorama of `projection`.
fn rbPanoramaDirection(projection: u32, uv: vec2f, azimuthOffset: f32) -> vec3f {
    switch projection {
        case 2u: { return rbOctahedralDirection(uv, azimuthOffset); }
        case 3u: { return rbFisheyeDirection(uv, azimuthOffset); }
        case 4u: { return rbSphereMapDirection(uv, azimuthOffset); }
        default: { return rbEquirectangularDirection(uv, azimuthOffset); }
    }
}
