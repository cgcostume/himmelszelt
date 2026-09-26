// A light meter for the sky, for automatic exposure. Requires `atmosphere.wgsl`, `common.wgsl` and `lut.wgsl`. A pass,
// so it declares its bindings.
//
// Reads the sky-view table rather than the rendered image: it is small, rebuilt only when the sun or the observer
// moves, and holds every direction, so the reading does not change as the camera turns, and the sun disc, which is not
// in it, does not pull the exposure down. Directions are spread evenly over the sky above the horizon, as a camera
// pointed at the sky meters it: the table's rows below it hold only the dim air towards the dark ground, and would
// expose the sky far too bright. The geometric mean of their luminance is written for the sky pass, which reads it
// without a round trip to the CPU.

struct DkMeterParams {
    sunDirection: vec3f,
    observerAltitude: f32,
}

struct DkMetering {
    // log2 of the geometric mean luminance, in cd/m².
    log2Luminance: f32,
}

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkMeterParams;
@group(0) @binding(2) var dkSkyViewLut: texture_2d<f32>;
@group(0) @binding(3) var dkLutSampler: sampler;
@group(0) @binding(4) var<storage, read_write> dkMeteringOut: DkMetering;

const DK_METER_THREADS: u32 = 256u;
const DK_METER_SAMPLES: u32 = 16u;
// Below the darkest night sky, so a black direction counts as very dark rather than as minus infinity.
const DK_METER_FLOOR: f32 = 1e-10;

var<workgroup> dkMeterSums: array<f32, DK_METER_THREADS>;

@compute @workgroup_size(256)
fn dkMeterSky(@builtin(local_invocation_index) index: u32) {
    let a = dkAtmosphere;
    let h = clamp(dkParams.observerAltitude, 0.0, a.Rt - a.Rg);
    let size = vec2f(textureDimensions(dkSkyViewLut));
    let total = f32(DK_METER_THREADS * DK_METER_SAMPLES);
    let horizon = dkHorizonMu(a, h);

    var sum = 0.0;
    for (var i = 0u; i < DK_METER_SAMPLES; i = i + 1u) {
        // A Fibonacci spiral over the cap above the horizon: even in solid angle, the table's own spacing is not.
        let k = f32(index * DK_METER_SAMPLES + i) + 0.5;
        let mu = 1.0 - (1.0 - horizon) * k / total;
        let azimuth = k * 2.399963229728653;
        let uv = dkSkyViewUv(a, h, mu, cos(azimuth), size);
        let rgb = textureSampleLevel(dkSkyViewLut, dkLutSampler, uv, 0.0).rgb;
        sum = sum + log2(max(dot(rgb, vec3f(0.2126, 0.7152, 0.0722)), DK_METER_FLOOR));
    }
    dkMeterSums[index] = sum;
    workgroupBarrier();

    for (var stride = DK_METER_THREADS / 2u; stride > 0u; stride = stride / 2u) {
        if (index < stride) {
            dkMeterSums[index] = dkMeterSums[index] + dkMeterSums[index + stride];
        }
        workgroupBarrier();
    }
    if (index == 0u) {
        dkMeteringOut.log2Luminance = dkMeterSums[0] / total;
    }
}
