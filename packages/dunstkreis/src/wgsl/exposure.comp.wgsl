// A light meter for the sky, for automatic exposure. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`,
// `sampling.wgsl`, `raymarch.wgsl`, `frame.wgsl` and `workgroupSum(128, ...)` from `reduce.ts`, first. A pass, so it
// declares its bindings.
//
// Reads the sky-view table rather than the rendered image: it is small, rebuilt only when the sun or the observer
// moves, and holds every direction, so the reading does not change as the camera turns, and the sun disc, which is not
// in it, does not pull the exposure down. Directions are spread evenly over the sky above the horizon and, apart, over
// the directions below it, and the brighter of the two geometric means is written for the sky pass, which reads it
// without a round trip to the CPU. On the ground that is mostly the sky, as a camera pointed at it meters it: below lies
// the ground, dark but where the sun lights it, which would expose the sky too bright. Over snow it may be the ground,
// as for a camera. High up it is the lit air below,
// while the sky above turns black. Above the atmosphere, where the table does not reach, it raymarches what the
// observer sees instead: the lit planet and its rim of air.
//
// TODO: high up, and from space, it still exposes too bright, if only subjectively.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(2) var dkSkyViewLut: texture_2d<f32>;
@group(0) @binding(3) var dkLutSampler: sampler;
@group(0) @binding(4) var<storage, read_write> dkMeteringOut: DkMetering;
@group(0) @binding(5) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(6) var dkMultiScatteringLut: texture_2d<f32>;

// 128 threads, the most WebGPU's compatibility mode allows per workgroup.
const DK_METER_THREADS: u32 = 128u;
const DK_METER_SAMPLES: u32 = 32u;
// Below the darkest night sky, so a black direction counts as very dark rather than as minus infinity.
const DK_METER_FLOOR: f32 = 1e-10;
// Samples per ray from space: the meter averages thousands of rays, so each can be coarse.
const DK_METER_RAY_SAMPLES: u32 = 16u;

// log2 of the luminance seen from altitude h along mu and an azimuth from the sun, for the geometric mean.
fn dkMeterLog2(a: DkAtmosphere, h: f32, mu: f32, azimuth: f32, size: vec2f) -> f32 {
    var rgb: vec3f;
    if (h > a.Rt - a.Rg) {
        let sun = dkParams.sunDirection;
        let s = normalize(select(vec2f(1.0, 0.0), sun.xy, length(sun.xy) > 1e-6));
        let horizontal = sqrt(max(1.0 - mu * mu, 0.0));
        let c = cos(azimuth);
        let d = sin(azimuth);
        let direction = vec3f(horizontal * (c * s.x - d * s.y), horizontal * (c * s.y + d * s.x), mu);
        let ray = dkRaymarchFromSpace(
            a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, h, direction, sun, DK_METER_RAY_SAMPLES,
        );
        rgb = ray.luminance;
    } else {
        rgb = textureSampleLevel(dkSkyViewLut, dkLutSampler, dkSkyViewUv(a, h, mu, cos(azimuth), size), 0.0).rgb;
    }
    return log2(max(dot(rgb, vec3f(0.2126, 0.7152, 0.0722)), DK_METER_FLOOR));
}

// Transmittance from the sun to the observer: by the table inside the atmosphere, raymarched from above it, where the
// sunlight may still graze the air or be hidden by the planet.
fn dkSunTransmittance(a: DkAtmosphere, h: f32) -> vec3f {
    let sun = dkParams.sunDirection;
    if (h > a.Rt - a.Rg) {
        let ray = dkRaymarchFromSpace(
            a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, h, sun, sun, DK_METER_RAY_SAMPLES,
        );
        return select(ray.transmittance, vec3f(0.0), ray.hitsGround);
    }
    return dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, h, sun.z);
}

@compute @workgroup_size(128)
fn dkMeterSky(@builtin(local_invocation_index) index: u32) {
    let a = dkAtmosphere;
    let h = max(dkParams.observerAltitude, 0.0);
    let size = vec2f(textureDimensions(dkSkyViewLut));
    let total = f32(DK_METER_THREADS * DK_METER_SAMPLES);
    let horizon = dkHorizonMu(a, h);

    // Fibonacci spirals over the caps above and below the horizon: even in solid angle, the table's own spacing is not.
    var sum = vec2f(0.0);
    for (var i = 0u; i < DK_METER_SAMPLES; i = i + 1u) {
        let k = f32(index * DK_METER_SAMPLES + i) + 0.5;
        let azimuth = k * 2.399963229728653;
        let above = dkMeterLog2(a, h, 1.0 - (1.0 - horizon) * k / total, azimuth, size);
        let below = dkMeterLog2(a, h, -1.0 + (1.0 + horizon) * k / total, azimuth, size);
        sum = sum + vec2f(above, below);
    }
    let sums = dkWorkgroupSum(vec4f(sum, 0.0, 0.0), index);
    if (index == 0u) {
        dkMeteringOut.log2Luminance = max(sums.x, sums.y) / total;
        dkMeteringOut.sunIlluminance = a.solarIlluminance * dkSunTransmittance(a, h);
    }
}
