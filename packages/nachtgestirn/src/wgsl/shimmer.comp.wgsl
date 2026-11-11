// The air's shimmer, after the Moon is drawn: the image as a camera takes it in one short exposure, moved about by the
// turbulence and its colors spread by the air's dispersion. A pass of its own over the Moon alone, linear, from the
// layer pass (`NG_LAYER`): each pixel reads red, green and blue where the air moved them from, then finishes the pixel
// as the Moon pass would, over the background, exposed and tone mapped. The ground and the sky behind the Moon stay
// put. Requires `moon.comp.wgsl` with all it requires, and the output binding from `moonOutput` for the target's format.

// The layer read between its texels, clamped at its edges.
@group(0) @binding(10) var ngLayerSampler: sampler;

// The turbulence ------------------------------------------------------------------------------------------------------

// Turbulence tilts the light arriving, and the image wanders: by an rms angle that grows with the air crossed as the
// Fried parameter shrinks, r0 ~ airmass^-3/5, the tilt ~ r0^-5/6. How far apart on the sky two points still wander
// together is the lens' width over the distance to the turbulence, which grows with the air crossed too: some
// 4 arcseconds overhead for a 10 cm lens, a fraction of one on the horizon. The air also bends blue more than red, by
// about a hundredth of the refraction, so near the horizon each color shows a little higher than the one redder than
// it, and a point's red and blue images lie apart by more than the turbulence's cells: its colored rims flicker each on
// its own, as a star low in the sky flashes in colors. All of it given per disc, from the air between the observer and
// the Moon.
// The turbulence: Kolmogorov's, eight octaves of waves, each half the size, from `cell` up to the outer scale, some
// 128 lens widths, its tilt as the size to the sixth, blown across the sky by the wind and changing as it goes; `rms`
// the tilt along each axis, in radians on the sky. A camera resolves only waves of `resolved` and longer, and no wave
// moving the image by more than NG_FOLD of its own wavelength: an octave's three waves together steeper than one would
// fold the image over itself into hairs and noise. What the pixels cannot follow, the finer waves and the steep ones'
// excess, they average into a blur instead, as each pixel gathers light moved about within it: its variance, in square
// radians, the third returned. `parts` weighs the three largest octaves, which move patches of the image as a whole,
// and the five smaller, which make it boil; its third the wind's drift across the sky, in radians a second.
// A wave at most this share of its wavelength: a slope of a quarter each, three to an octave.
const NG_FOLD: f32 = 0.04;
const NG_OCTAVES: u32 = 8u;
// sqrt(2 / sum of the octaves' squared weights): three waves of each, 2^((7 - octave) / 6).
const NG_TURBULENCE_NORM: f32 = 0.18;
fn ngTurbulence(onSky: vec2f, time: f32, cell: f32, resolved: f32, rms: f32, parts: vec3f) -> vec3f {
    var moved = vec2f(0.0);
    var blur = 0.0;
    let blown = onSky - vec2f(0.8, 0.6) * parts.z * time;
    for (var i = 0u; i < 3u * NG_OCTAVES; i = i + 1u) {
        let octave = f32(i / 3u);
        let size = cell * exp2(f32(NG_OCTAVES - 1u) - octave);
        let weight = select(parts.y, parts.x, octave < 3.0);
        let full = rms * NG_TURBULENCE_NORM * pow(size / cell, 1.0 / 6.0) * weight;
        let amplitude = select(0.0, min(full, size * NG_FOLD * weight), size >= resolved);
        blur = blur + 0.5 * (full * full - amplitude * amplitude);
        if (amplitude > 0.0) {
            let angle = f32(i) * 2.399963 + 0.4;
            let across = vec2f(cos(angle), sin(angle));
            let drift = time * (3.0 + 1.25 * octave + 0.37 * f32(i));
            let phase = dot(blown, across) * (6.2831853 / size) + f32(i) * 1.7 + drift;
            moved = moved + amplitude * vec2f(sin(phase), cos(phase * 0.93 + f32(i)));
        }
    }
    return vec3f(moved, blur);
}

// Red's, green's and blue's rays for a pixel's ray, moved by the turbulence and spread apart towards the zenith, and the
// blur of what the pixels cannot follow, its rms.
struct NgShimmered {
    red: vec3f,
    green: vec3f,
    blue: vec3f,
    blur: f32,
}

fn ngShimmered(ray: vec3f, pixelAngle: f32) -> NgShimmered {
    let shimmer = ngParams.shimmer;
    var up = vec3f(0.0, 0.0, 1.0) - ray.z * ray;
    up = select(vec3f(0.0, 1.0, 0.0), normalize(up), length(up) > 1e-5);
    let right = cross(ray, up);
    // Where the ray points on the sky, east and up of the Moon in the plane that touches the sky there: dot products
    // with fixed axes. Azimuth and altitude from atan2 and asin would do, but GPUs may take those to a few thousand
    // units in the last place, which near the Moon's tiny disc is noise from one pixel to the next.
    let toMoon = ngParams.direction;
    let east = normalize(select(vec3f(1.0, 0.0, 0.0), cross(vec3f(0.0, 0.0, 1.0), toMoon), abs(toMoon.z) < 0.999));
    let onSky = vec2f(dot(ray, east), dot(ray, cross(toMoon, east)));
    // Waves finer than a few pixels would only alias: they blur.
    let turbulence = ngTurbulence(onSky, shimmer.y, shimmer.w, 4.0 * pixelAngle, shimmer.x, ngParams.shimmerParts.xyz);
    let moved = normalize(ray + right * turbulence.x + up * turbulence.y);
    // The rays are bent back by green's refraction alone. Red is bent 0.36% less, so its image sits lower: its ray
    // goes up by the difference before the bend is taken off; blue, bent 0.78% more, sits higher, its ray goes down.
    // Edlen's refractivity of air at 610, 550 and 465 nm, sRGB's primaries.
    let spread = shimmer.z;
    let red = normalize(moved + up * spread * 0.0036);
    let blue = normalize(moved - up * spread * 0.0078);
    return NgShimmered(red, moved, blue, sqrt(turbulence.z));
}

// The layer -----------------------------------------------------------------------------------------------------------

// The layer at a point in pixels, between its four nearest, clamped at its edges.
fn ngLayerAt(position: vec2f) -> vec4f {
    return textureSampleLevel(ngLayer, ngLayerSampler, position / vec2f(textureDimensions(ngLayer)), 0.0);
}

// The layer around a point blurred by a Gaussian of `sigma` pixels: NG_BLUR_TAPS of equal weight on a golden spiral,
// each as far out as a Gaussian puts its share of the light, the same for every pixel, so the blur does not flicker.
const NG_BLUR_TAPS: u32 = 16u;
fn ngLayerBlurred(position: vec2f, sigma: f32) -> vec4f {
    if (sigma < 0.35) {
        return ngLayerAt(position);
    }
    var sum = vec4f(0.0);
    for (var i = 0u; i < NG_BLUR_TAPS; i = i + 1u) {
        let r = sigma * sqrt(-2.0 * log(1.0 - (f32(i) + 0.5) / f32(NG_BLUR_TAPS)));
        let angle = f32(i) * 2.399963;
        sum = sum + ngLayerAt(position + r * vec2f(cos(angle), sin(angle)));
    }
    return sum / f32(NG_BLUR_TAPS);
}

// The pass ------------------------------------------------------------------------------------------------------------

// Where a ray moved on the sky lands on the target, in pixels: through the target's axes at `pixel`, a pixel each.
fn ngLanding(moved: vec3f, ray: vec3f, pixel: vec2f, across: vec3f, down: vec3f) -> vec2f {
    let offset = moved - ray;
    return pixel + vec2f(dot(offset, across) / dot(across, across), dot(offset, down) / dot(down, down));
}

@compute @workgroup_size(8, 8, 1)
fn ngShimmer(@builtin(global_invocation_id) id: vec3u) {
    let size = ngOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let pixel = vec2f(id.xy) + 0.5;
    let ray = ngPixelRay(pixel, size);
    let across = ngPixelRay(pixel + vec2f(1.0, 0.0), size) - ray;
    let down = ngPixelRay(pixel + vec2f(0.0, 1.0), size) - ray;
    let pixelAngle = length(across);
    // As far as the layer holds the Moon, and the air moves it and blurs it, its waves together at most ten times its
    // rms tilt, and spreads its colors.
    let shimmer = ngParams.shimmer;
    let parts = ngParams.shimmerParts;
    let moves = 10.0 * shimmer.x * max(parts.x, parts.y) + 0.01 * shimmer.z;
    let reach = ngParams.angularRadius * 1.3 + 4.0 * pixelAngle + moves;

    var luminance = vec3f(0.0);
    var coverage = 0.0;
    // The ground hides the Moon below the horizon, wherever the air moved it from.
    if (ray.z >= ngParams.horizonZ && ngRayOf(ngUnbend(ray)).angle < reach) {
        let rays = ngShimmered(ray, pixelAngle);
        let sigma = rays.blur / pixelAngle;
        let red = ngLayerBlurred(ngLanding(rays.red, ray, pixel, across, down), sigma);
        let green = ngLayerBlurred(ngLanding(rays.green, ray, pixel, across, down), sigma);
        let blue = ngLayerBlurred(ngLanding(rays.blue, ray, pixel, across, down), sigma);
        luminance = vec3f(red.r, green.g, blue.b);
        coverage = green.a;
    }
    ngOutputStore(id.xy, ngFinish(luminance, coverage, id.xy));
}
