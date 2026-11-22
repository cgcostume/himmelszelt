// Rainbows: what raindrops send of the sun's light into every scattering angle, read from the table `rainbowTable`
// computes: one row over the angle, the phase function per steradian for red, green and blue in linear sRGB, and for
// luminance in its alpha. The primary bow stands 138° from the sun, 42° around the point opposite it, the secondary at
// 129°, the dark of Alexander's band between them; towards the sun the drops' own glare, ten times the bows.
// Binding-free: the table and its sampler are passed in, the sampler a filtering one over a format it may filter.

// The scattering angles in degrees at the table's left and right edges.
const GW_RAINBOW_FROM: f32 = 0.0;
const GW_RAINBOW_TO: f32 = 180.0;

// Where along the table's row of `texels` the scattering angle of cosine `cosTheta` lies, 0 to 1: held within the
// outermost texels' centers, so that a sampler that repeats reads nothing from the row's other end.
fn gwRainbowCoord(cosTheta: f32, texels: f32) -> f32 {
    let angle = degrees(acos(clamp(cosTheta, -1.0, 1.0)));
    let u = (angle - GW_RAINBOW_FROM) / (GW_RAINBOW_TO - GW_RAINBOW_FROM);
    return clamp(u, 0.5 / texels, 1.0 - 0.5 / texels);
}

// The rain's phase function per steradian at the scattering angle of cosine `cosTheta`, the view ray's direction dot
// the sun's: times the sun's illuminance and the rain's optical depth along the ray, where that is thin, cd/m².
fn gwRainbowPhase(cosTheta: f32, table: texture_2d<f32>, tableSampler: sampler) -> vec3f {
    let u = gwRainbowCoord(cosTheta, f32(textureDimensions(table).x));
    return textureSampleLevel(table, tableSampler, vec2f(u, 0.5), 0.0).rgb;
}

// The light of rain of optical depth `depth` over a pixel looking along `direction`, under a sun at `sunDirection` of
// `illuminance` lux per channel where the rain falls, both unit vectors: in cd/m², before whatever lies in front of
// the rain dims it. The depth is of the stretch that the sun reaches and counts the drops' cross-sections alone.
fn gwRainbowOf(direction: vec3f, sunDirection: vec3f, illuminance: vec3f, depth: f32, table: texture_2d<f32>, tableSampler: sampler) -> vec3f {
    return illuminance * depth * gwRainbowPhase(dot(direction, sunDirection), table, tableSampler);
}
