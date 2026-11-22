// The aircraft at the young ends of the contrails, drawn into the frame behind the clouds: a photograph of one from
// below, nose up, laid over the sky as exposed, so the clouds in front of it hide it and the frame's light dims it.

struct Plane {
    // Where its middle shows, in pixels, and where its nose and its right wing's tip show from there: it lies flat up
    // there, so the two are neither square nor alike long.
    at: vec2f,
    nose: vec2f,
    wing: vec2f,
    // How much of it shows, 0 to 1: it comes and goes with its trail, and fades into the air far off.
    shown: f32,
    pad: f32,
}
struct Planes {
    // What a white surface up there sends back, as exposed.
    light: vec3f,
    count: u32,
    plane: array<Plane, 16>,
}
@group(0) @binding(0) var<uniform> planes: Planes;
@group(0) @binding(1) var planesBehind: texture_2d<f32>;
@group(0) @binding(2) var planePhoto: texture_2d<f32>;
@group(0) @binding(3) var planeSampler: sampler;
@group(0) @binding(4) var planesOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn planesOver(@builtin(global_invocation_id) id: vec3u) {
    let size = textureDimensions(planesOut);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    var color = textureLoad(planesBehind, vec2i(id.xy), 0).rgb;
    let texels = f32(textureDimensions(planePhoto).x);
    for (var i = 0u; i < planes.count; i = i + 1u) {
        let p = planes.plane[i];
        let d = vec2f(id.xy) + 0.5 - p.at;
        let area = p.wing.x * p.nose.y - p.wing.y * p.nose.x;
        if (abs(area) < 1e-6) {
            continue;
        }
        // The pixel in the aircraft's own frame, from its middle: 1 at the wing's tip and at the nose.
        let own = vec2f(d.x * p.nose.y - d.y * p.nose.x, p.wing.x * d.y - p.wing.y * d.x) / area;
        if (any(abs(own) > vec2f(1.0))) {
            continue;
        }
        // The level whose texels are a pixel along the shorter of the two.
        let across = 2.0 * max(min(length(p.nose), length(p.wing)), 0.5);
        let photo = textureSampleLevel(planePhoto, planeSampler, vec2f(own.x, -own.y) * 0.5 + 0.5, log2(max(texels / across, 1.0)));
        color = mix(color, photo.rgb * planes.light, photo.a * p.shown);
    }
    textureStore(planesOut, vec2i(id.xy), vec4f(color, 1.0));
}
