// The air's shimmer, after the Moon is drawn: the image as a camera takes it in one short exposure, moved about by the
// turbulence and its colors spread by the air's dispersion. A pass of its own over the Moon alone, linear, from the
// layer pass (`NB_LAYER`): each pixel reads red, green and blue where the air moved them from, then finishes the pixel
// as the Moon pass would, over the background, exposed and tone mapped. The ground and the sky behind the Moon stay
// put. Requires `moon.comp.wgsl` with all it requires, and the output binding from `moonOutput` for the target's format.

// Turbulence tilts the light arriving, and the image wanders: by an rms angle that grows with the air crossed as the
// Fried parameter shrinks, r0 ~ airmass^-3/5, the tilt ~ r0^-5/6. How far apart on the sky two points still wander
// together is the lens' width over the distance to the turbulence, which grows with the air crossed too: some
// 4 arcseconds overhead for a 10 cm lens, a fraction of one on the horizon. The air also bends blue more than red, by
// about a hundredth of the refraction, so near the horizon each color shows a little higher than the one redder than
// it, and a point's red and blue images lie apart by more than the turbulence's cells: its colored rims flicker each on
// its own, as a star low in the sky flashes in colors. All of it given per disc, from the air between the observer and
// the Moon.
// The turbulence: Kolmogorov's, five octaves of waves, each half the size, its tilt as the size to the sixth, blown
// across the sky by the wind and changing as it goes; `cell` its finest wavelength and `rms` the tilt along each axis,
// in radians on the sky. No wave moves the image by more than NB_FOLD of its own wavelength: an octave's three waves
// together steeper than one would fold the image over itself into hairs and noise, where a camera sees a blur.
// `parts` weighs the two largest octaves, which move patches of the image as a whole, and the three smaller, which
// make it boil; its third the wind's drift across the sky, in radians a second.
// A wave at most this share of its wavelength: a slope of a quarter each, three to an octave.
const NB_FOLD: f32 = 0.04;
// sqrt(2 / sum of the octaves' squared weights): three waves of each, 2^((4 - octave) / 6).
const NB_TURBULENCE_NORM: f32 = 0.2823;
fn nbTurbulence(q: vec2f, t: f32, cell: f32, rms: f32, parts: vec3f) -> vec2f {
    var d = vec2f(0.0);
    let blown = q - vec2f(0.8, 0.6) * parts.z * t;
    for (var i = 0u; i < 15u; i = i + 1u) {
        let octave = f32(i / 3u);
        let size = cell * exp2(4.0 - octave);
        let angle = f32(i) * 2.399963 + 0.4;
        let dir = vec2f(cos(angle), sin(angle));
        let a = min(rms * NB_TURBULENCE_NORM * pow(size / cell, 1.0 / 6.0), size * NB_FOLD) * select(parts.y, parts.x, octave < 2.0);
        let phase = dot(blown, dir) * (6.2831853 / size) + f32(i) * 1.7 + t * (3.0 + 2.0 * octave + 0.37 * f32(i));
        d = d + a * vec2f(sin(phase), cos(phase * 0.93 + f32(i)));
    }
    return d;
}

// Red's, green's and blue's rays for a pixel's ray: moved by the turbulence, and spread apart towards the zenith.
fn nbShimmered(ray: vec3f, pixelAngle: f32) -> array<vec3f, 3> {
    let w = nbParams.shimmer;
    var up = vec3f(0.0, 0.0, 1.0) - ray.z * ray;
    up = select(vec3f(0.0, 1.0, 0.0), normalize(up), length(up) > 1e-5);
    let right = cross(ray, up);
    // Where the ray points on the sky, east and up of the Moon in the plane that touches the sky there: dot products
    // with fixed axes. Azimuth and altitude from atan2 and asin would do, but GPUs may take those to a few thousand
    // units in the last place, which near the Moon's tiny disc is noise from one pixel to the next.
    let m = nbParams.direction;
    let east = normalize(select(vec3f(1.0, 0.0, 0.0), cross(vec3f(0.0, 0.0, 1.0), m), abs(m.z) < 0.999));
    let q = vec2f(dot(ray, east), dot(ray, cross(m, east)));
    // The cells no finer than a few pixels, which would only alias.
    let d = nbTurbulence(q, w.y, max(w.w, 4.0 * pixelAngle), w.x, nbParams.shimmerParts.xyz);
    let moved = normalize(ray + right * d.x + up * d.y);
    // The rays are bent back by green's refraction alone. Red is bent 0.36% less, so its image sits lower: its ray
    // goes up by the difference before the bend is taken off; blue, bent 0.78% more, sits higher, its ray goes down.
    // Edlen's refractivity of air at 610, 550 and 465 nm, sRGB's primaries.
    let spread = w.z;
    return array<vec3f, 3>(
        normalize(moved + up * spread * 0.0036),
        moved,
        normalize(moved - up * spread * 0.0078),
    );
}

// The layer at a point in pixels, between its four nearest, clamped at its edges.
fn nbLayerAt(position: vec2f) -> vec4f {
    let size = vec2i(textureDimensions(nbLayer));
    let p = position - 0.5;
    let base = vec2i(floor(p));
    let t = p - floor(p);
    let a = textureLoad(nbLayer, clamp(base, vec2i(0), size - 1), 0);
    let b = textureLoad(nbLayer, clamp(base + vec2i(1, 0), vec2i(0), size - 1), 0);
    let c = textureLoad(nbLayer, clamp(base + vec2i(0, 1), vec2i(0), size - 1), 0);
    let d = textureLoad(nbLayer, clamp(base + vec2i(1, 1), vec2i(0), size - 1), 0);
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

@compute @workgroup_size(8, 8, 1)
fn nbShimmer(@builtin(global_invocation_id) id: vec3u) {
    let size = nbOutputSize();
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let pixel = vec2f(id.xy) + 0.5;
    let ray = nbPixelRay(pixel, size);
    var luminance = vec3f(0.0);
    var coverage = 0.0;
    // The ground hides the Moon below the horizon, wherever the air moved it from.
    if (ray.z >= nbParams.horizonZ) {
        // A ray moved on the sky is a point moved on the target, through the target's axes there, a pixel each.
        let across = nbPixelRay(pixel + vec2f(1.0, 0.0), size) - ray;
        let down = nbPixelRay(pixel + vec2f(0.0, 1.0), size) - ray;
        let rays = nbShimmered(ray, length(across));
        var read: array<vec4f, 3>;
        for (var c = 0u; c < 3u; c = c + 1u) {
            let moved = rays[c] - ray;
            read[c] = nbLayerAt(pixel + vec2f(dot(moved, across) / dot(across, across), dot(moved, down) / dot(down, down)));
        }
        luminance = vec3f(read[0].r, read[1].g, read[2].b);
        coverage = read[1].a;
    }
    nbOutputStore(id.xy, nbFinish(luminance, coverage, id.xy));
}
