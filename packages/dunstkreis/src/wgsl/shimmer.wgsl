// The air's shimmer on an image from beyond it: a layer drawn without it, the Moon, the Sun's disc, a planet, a
// satellite, as a camera takes it in one short exposure, moved about by the turbulence and its colors spread by the
// air's dispersion. Requires `air.wgsl`, `seeing.wgsl` and reisszeug's `turbulence.wgsl` under the prefix `dk`, which
// `wgsl.shimmer` holds with this. Binding-free: the layer, its sampler, the air table and the
// scales come in as arguments, so a pass of your own can shimmer its layer and finish the pixel in one go;
// `shimmerlayer.comp.wgsl` is the pass that does only this.

// What sets the shimmer, next to the seeing.
struct DkShimmer {
    // Towards the body where it shows, ENU: the turbulence's scales are taken there, one for the whole layer. The
    // layer holds nothing further from it than `reach`, as the chord between the two unit vectors, 2 sin of half the
    // angle: the cosine of an arcminute is 1 in f32.
    direction: vec3f,
    reach: f32,
    // The turbulence's clock in seconds.
    time: f32,
    // The two parts of the motion, 1 each as the air does: the large waves, which move patches of the image as a
    // whole, and the small, which make it boil.
    motion: f32,
    boiling: f32,
    // How far apart the colors are spread, 1 as the air does.
    dispersion: f32,
}

// Turbulence tilts the light arriving, and the image wanders: by an rms angle that grows with the root of the
// turbulence crossed. How far apart on the sky two points still wander together is the lens' width seen from the
// turbulence: some 9 arcseconds overhead for a 10 cm lens, a fraction of one on the horizon.
// Red's, green's and blue's rays for a pixel's ray, moved by the turbulence and spread apart towards the zenith, and
// the blur of what the pixels cannot follow, its rms in radians.
struct DkShimmered {
    red: vec3f,
    green: vec3f,
    blue: vec3f,
    blur: f32,
}

// The turbulence's amount at the ray sets how far it moves, so a limb deep in the air trembles and one above it holds
// still; its scales are those at the body, the same for every pixel, or the waves would shear across the layer.
fn dkShimmered(air: texture_2d<f32>, seeing: DkSeeing, shimmer: DkShimmer, ray: vec3f, pixelAngle: f32) -> DkShimmered {
    var up = vec3f(0.0, 0.0, 1.0) - ray.z * ray;
    up = select(vec3f(0.0, 1.0, 0.0), normalize(up), length(up) > 1e-5);
    let right = cross(ray, up);
    // Where the ray points on the sky, east and up of the body in the plane that touches the sky there: dot products
    // with fixed axes. Azimuth and altitude from atan2 and asin would do, but GPUs may take those to a few thousand
    // units in the last place, which across a tiny disc is noise from one pixel to the next.
    let body = shimmer.direction;
    let east = normalize(select(vec3f(1.0, 0.0, 0.0), cross(vec3f(0.0, 0.0, 1.0), body), abs(body.z) < 0.999));
    let onSky = vec2f(dot(ray, east), dot(ray, cross(body, east)));
    let there = dkAirTowards(air, body).seeing;
    let here = dkAirTowards(air, ray);
    let far = max(there.y, 1.0);
    let parts = vec3f(shimmer.motion, shimmer.boiling, dkSeeingSpeed(seeing, there.z) / far);
    let rms = seeing.tilt * sqrt(max(here.seeing.x, 0.0));
    // Waves finer than a few pixels would only alias: they blur.
    let turbulence = dkTurbulence(onSky, shimmer.time, seeing.aperture / far, 4.0 * pixelAngle, rms, parts);
    let moved = normalize(ray + right * turbulence.x + up * turbulence.y);
    // The layer is drawn by green's refraction. Red is bent less, so its image sits lower: its ray goes up by the
    // difference; blue, bent more, sits higher, its ray goes down. By the bend's difference as it shows, squeezed like
    // everything else here.
    let spread = here.bend * here.dilution * shimmer.dispersion;
    let red = normalize(moved + up * spread * (DK_AIR_DISPERSION.g - DK_AIR_DISPERSION.r));
    let blue = normalize(moved - up * spread * (DK_AIR_DISPERSION.b - DK_AIR_DISPERSION.g));
    return DkShimmered(red, moved, blue, sqrt(turbulence.z));
}

// The layer at a point in pixels, between its four nearest, clamped at its edges by the sampler.
fn dkShimmerLayerAt(layer: texture_2d<f32>, layerSampler: sampler, position: vec2f) -> vec4f {
    return textureSampleLevel(layer, layerSampler, position / vec2f(textureDimensions(layer)), 0.0);
}

// The layer around a point blurred by a Gaussian of `sigma` pixels: DK_SHIMMER_TAPS of equal weight on a golden
// spiral, each as far out as a Gaussian puts its share of the light, the same for every pixel, so the blur does not
// flicker.
const DK_SHIMMER_TAPS: u32 = 16u;
fn dkShimmerLayerBlurred(layer: texture_2d<f32>, layerSampler: sampler, position: vec2f, sigma: f32) -> vec4f {
    if (sigma < 0.35) {
        return dkShimmerLayerAt(layer, layerSampler, position);
    }
    var sum = vec4f(0.0);
    for (var i = 0u; i < DK_SHIMMER_TAPS; i = i + 1u) {
        let r = sigma * sqrt(-2.0 * log(1.0 - (f32(i) + 0.5) / f32(DK_SHIMMER_TAPS)));
        let angle = f32(i) * 2.399963;
        sum = sum + dkShimmerLayerAt(layer, layerSampler, position + r * vec2f(cos(angle), sin(angle)));
    }
    return sum / f32(DK_SHIMMER_TAPS);
}

// Where a ray moved on the sky lands on the target, in pixels: through the target's axes at `pixel`, a pixel each.
fn dkShimmerLanding(moved: vec3f, ray: vec3f, pixel: vec2f, across: vec3f, down: vec3f) -> vec2f {
    let offset = moved - ray;
    return pixel + vec2f(dot(offset, across) / dot(across, across), dot(offset, down) / dot(down, down));
}

// The layer at a pixel as the air shows it: its light, linear and premultiplied, and its coverage. `pixel` is the
// pixel's center in pixels, `ray` the ray through it, `across` and `down` what the ray gains a pixel to the right and
// a pixel down. Nothing below the horizon, wherever the air moved the image from; the layer as it is beyond `reach`.
fn dkShimmerLayer(
    layer: texture_2d<f32>,
    layerSampler: sampler,
    air: texture_2d<f32>,
    seeing: DkSeeing,
    shimmer: DkShimmer,
    pixel: vec2f,
    ray: vec3f,
    across: vec3f,
    down: vec3f,
) -> vec4f {
    if (dkAirAbove(ray, dkAirRange(air).x) < 0.0) {
        return vec4f(0.0);
    }
    if (distance(ray, shimmer.direction) > shimmer.reach) {
        return dkShimmerLayerAt(layer, layerSampler, pixel);
    }
    let pixelAngle = length(across);
    let rays = dkShimmered(air, seeing, shimmer, ray, pixelAngle);
    let sigma = rays.blur / pixelAngle;
    let redAt = dkShimmerLanding(rays.red, ray, pixel, across, down);
    let greenAt = dkShimmerLanding(rays.green, ray, pixel, across, down);
    let blueAt = dkShimmerLanding(rays.blue, ray, pixel, across, down);
    let red = dkShimmerLayerBlurred(layer, layerSampler, redAt, sigma);
    let green = dkShimmerLayerBlurred(layer, layerSampler, greenAt, sigma);
    let blue = dkShimmerLayerBlurred(layer, layerSampler, blueAt, sigma);
    return vec4f(red.r, green.g, blue.b, green.a);
}
