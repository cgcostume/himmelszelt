// Veiling glare: the eye scatters a little of the light of anything bright across the whole retina, a veil that lies
// over everything near it, and over the Sun it is most of what is seen. CIE's general disability glare equation
// (CIE 146:2002, after Vos and van den Berg), measured on people: the veil's luminance per lux the source throws into
// the eye, by the angle to it in degrees, from 0.1° to 100°, the eye's age in years and its pigment, 0 for very dark
// eyes, 0.5 brown, 1 blue-green, 1.2 light blue. A camera's lens veils likewise, with a flare and a tail of its own that
// no one equation fits; scaled down, this stands in for it. Binding-free. A point source only: a bright place of some
// size is bloom's, in bloom.comp.wgsl.

// The veil in cd/m² per lux at the eye, at `angle` degrees from the source.
fn hdVeilingGlare(angle: f32, age: f32, pigment: f32) -> f32 {
    let theta = clamp(angle, 0.1, 100.0);
    let aging = 1.0 + pow(age / 62.5, 4.0);
    return 10.0 / (theta * theta * theta) + (5.0 / (theta * theta) + 0.1 * pigment / theta) * aging + 0.0025 * pigment;
}

// The veil of a source at `sourceDirection` whose illuminance at the eye is `illuminance`, lux per channel, over a
// pixel looking along `direction`, both unit vectors: in cd/m², to add to the pixel's light before it is exposed.
fn hdVeil(direction: vec3f, sourceDirection: vec3f, illuminance: vec3f, age: f32, pigment: f32) -> vec3f {
    let angle = 2.0 * asin(min(length(direction - sourceDirection) * 0.5, 1.0)) * 57.29577951308232;
    return illuminance * hdVeilingGlare(angle, age, pigment);
}
