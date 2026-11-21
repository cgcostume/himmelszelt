// A lens's own light around a small, very bright source, the Sun: the starburst its aperture's blades diffract. A point
// spread per steradian, so times the source's illuminance at the lens in lux it is cd/m², to add to a pixel's light
// before it is exposed, as the veil in glare.wgsl is, which at a two-hundredth of its strength is the glow the lens's
// glass scatters. It knows neither what stands in front of the source, nor the lens's barrel, which shades a source out
// of the frame: whoever calls dims the illuminance by both.
// Binding-free. A source of some size, and everything else bright in the image, is bloom's, in bloom.comp.wgsl.

// What the starburst's spikes fall from, in radians: the wavelength over the aperture's width, 550 nm over 5 mm, f/5.6
// at 28 mm. A smaller aperture draws longer spikes.
const HD_STARBURST_SCALE: f32 = 1.1e-4;

// The starburst in cd/m² per lux at the lens: every straight edge of the aperture diffracts the light into a line across
// it, falling with the square of the angle along it, longer for red than for blue. Two parallel edges share a line, so
// an even count of `blades` draws as many spikes and an odd one twice as many. `offset` is the pixel's place from the
// source in the image plane, where a lens draws the lines straight, in radians; `radius` the source's angular radius,
// which spreads each line as wide as the source and flat within it. The first line is turned 10° from the image's
// horizontal. A sixth of the light or less, the rest being the source's own image.
fn hdStarburst(offset: vec2f, radius: f32, blades: u32) -> vec3f {
    let lines = select(blades, blades / 2u, blades % 2u == 0u);
    if (lines == 0u) {
        return vec3f(0.0);
    }
    let apart = 3.141592653589793 / f32(lines);
    let turn = vec2f(cos(apart), sin(apart));
    let sigma = 0.7 * radius;
    var spike = vec2f(0.98481, 0.17365);
    var sum = 0.0;
    for (var k = 0u; k < lines; k = k + 1u) {
        let along = dot(offset, spike);
        let across = offset.x * spike.y - offset.y * spike.x;
        sum = sum + exp(-across * across / (2.0 * sigma * sigma)) / (along * along + radius * radius);
        spike = vec2f(spike.x * turn.x - spike.y * turn.y, spike.x * turn.y + spike.y * turn.x);
    }
    // Each line an equal share of the light, 1 over the plane together: sqrt(2 pi) sigma pi per line.
    return vec3f(1.109, 1.0, 0.845) * (HD_STARBURST_SCALE * sum / (f32(lines) * 7.8748 * sigma));
}
