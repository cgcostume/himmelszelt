// The Moon's surface, binding-free: where a point of the disc lies on the Moon and in its maps, the directions along
// the surface there, the sRGB curves, and how much of one disc another covers, as Earth covers the Sun's.

const NG_PI: f32 = 3.141592653589793;

// A point on the unit sphere in the Moon's own frame as selenographic longitude, east positive, and latitude.
fn ngSelenographic(point: vec3f) -> vec2f {
    return vec2f(atan2(point.y, point.x), asin(clamp(point.z, -1.0, 1.0)));
}

// Where that longitude and latitude are in an equirectangular map centered on 0° longitude, east to the right and
// north up, as NASA's CGI Moon Kit lays the Moon out.
fn ngMapUv(lonLat: vec2f) -> vec2f {
    return vec2f(lonLat.x / (2.0 * NG_PI) + 0.5, 0.5 - lonLat.y / NG_PI);
}

// The directions east and north along the surface at a point of the unit sphere in the Moon's frame, and the cosine
// of its latitude, the radius of its parallel.
struct NgLocal {
    east: vec3f,
    north: vec3f,
    parallel: f32,
}

fn ngLocal(point: vec3f) -> NgLocal {
    let parallel = max(length(point.xy), 1e-4);
    let east = vec3f(-point.y, point.x, 0.0) / parallel;
    return NgLocal(east, cross(point, east), parallel);
}

// A ray's footprint on the Moon's unit sphere, in its own frame: two axes along the surface, the short one across the
// line of sight and the long one along it, stretched where the surface is seen at a slant.
struct NgFootprint {
    across: vec3f,
    along: vec3f,
}

// How far in a map's uv a step `step` along the surface is: east stretched by the parallels' shrinking.
fn ngUvStep(local: NgLocal, step: vec3f) -> vec2f {
    return vec2f(dot(step, local.east) / local.parallel / (2.0 * NG_PI), -dot(step, local.north) / NG_PI);
}

fn ngLinearToSrgb(c: vec3f) -> vec3f {
    let low = c * 12.92;
    let high = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
    return select(high, low, c <= vec3f(0.0031308));
}

fn ngSrgbToLinear(c: vec3f) -> vec3f {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3f(2.4));
    return select(high, low, c <= vec3f(0.04045));
}

// The area two discs of radii a and b share, their centers d apart.
fn ngLens(a: f32, b: f32, d: f32) -> f32 {
    if (d >= a + b) {
        return 0.0;
    }
    if (d <= abs(a - b)) {
        return NG_PI * min(a, b) * min(a, b);
    }
    let x = (d * d + a * a - b * b) / (2.0 * d);
    let y = sqrt(max(a * a - x * x, 0.0));
    return a * a * acos(clamp(x / a, -1.0, 1.0)) + b * b * acos(clamp((d - x) / b, -1.0, 1.0)) - d * y;
}
