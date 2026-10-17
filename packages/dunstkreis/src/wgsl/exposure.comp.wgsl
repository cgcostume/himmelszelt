// A light meter for the sky, for automatic exposure. Requires `atmosphere.wgsl`, `common.wgsl`, `lut.wgsl`,
// `sampling.wgsl`, `raymarch.wgsl`, `spiral.wgsl`, `frame.wgsl` and `workgroupSum(128, ...)` from `reduce.ts`, first. A pass, so it
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
// Two entry points, run one after the other: `dkMeterSample` reads one direction per cap per invocation, over 32
// workgroups, so that the raymarches from space spread over the GPU rather than queue up in one; `dkMeterSky`, one
// workgroup, sums them. It also writes the observer's horizon for the sky pass, see `DkMetering`.
//
// Each sample counts at most DK_METER_RANGE stops below the brightest of its cap: a black direction would otherwise
// enter the geometric mean at the floor, some 33 stops down, and from space the planet's night side and the black sky
// would pull the reading towards night while the day side shines.

@group(0) @binding(0) var<uniform> dkAtmosphere: DkAtmosphere;
@group(0) @binding(1) var<uniform> dkParams: DkSkyParams;
@group(0) @binding(2) var dkSkyViewLut: texture_2d<f32>;
@group(0) @binding(3) var dkLutSampler: sampler;
@group(0) @binding(4) var<storage, read_write> dkMeteringOut: DkMetering;
@group(0) @binding(5) var dkTransmittanceLut: texture_2d<f32>;
@group(0) @binding(6) var dkMultiScatteringLut: texture_2d<f32>;

// 128 threads, the most WebGPU's compatibility mode allows per workgroup.
const DK_METER_THREADS: u32 = 128u;
var<workgroup> dkMeterBrightest: array<vec2f, DK_METER_THREADS>;
// Samples each invocation of the summing workgroup takes from the sampling pass' buffer.
const DK_METER_SAMPLES_PER_THREAD: u32 = DK_METER_SAMPLES / DK_METER_THREADS;
// Below the darkest night sky, so a black direction counts as very dark rather than as minus infinity.
const DK_METER_FLOOR: f32 = 1e-10;
// How far below the brightest sample of a cap a sample counts at most, in stops: a camera's dynamic range.
const DK_METER_RANGE: f32 = 10.0;
// Samples per ray from space: the meter averages thousands of rays, so each can be coarse.
const DK_METER_RAY_SAMPLES: u32 = 16u;

// log2 of the luminance seen from altitude h along mu and an azimuth from the sun, for the geometric mean. `below`
// keeps the lookup to the table's ground half, as the sky pass does, so the horizon's rows do not blend into each other.
fn dkMeterLog2(a: DkAtmosphere, h: f32, horizon: vec3f, mu: f32, azimuth: f32, size: vec2f, below: bool) -> f32 {
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
        rgb = dkToRgb(a, ray.luminance);
    } else {
        var uv = dkSkyViewUvAt(horizon, mu, cos(azimuth), size);
        let half = 0.5 / size.y;
        uv.y = select(min(uv.y, 0.5 - half), max(uv.y, 0.5 + half), below);
        rgb = dkToRgb(a, textureSampleLevel(dkSkyViewLut, dkLutSampler, uv, 0.0)) / dkParams.skyViewScale;
    }
    return log2(max(dot(rgb, vec3f(0.2126, 0.7152, 0.0722)), DK_METER_FLOOR));
}

// Transmittance from the sun to the observer: by the table inside the atmosphere, raymarched from above it, where the
// sunlight may still graze the air or be hidden by the planet.
fn dkSunTransmittance(a: DkAtmosphere, h: f32) -> vec4f {
    let sun = dkParams.sunDirection;
    if (h > a.Rt - a.Rg) {
        let ray = dkRaymarchFromSpace(
            a, dkTransmittanceLut, dkMultiScatteringLut, dkLutSampler, h, sun, sun, DK_METER_RAY_SAMPLES,
        );
        return select(ray.transmittance, vec4f(0.0), ray.hitsGround);
    }
    return dkSampleTransmittanceToTop(a, dkTransmittanceLut, dkLutSampler, h, sun.z);
}

// One direction per cap per invocation, on Fibonacci spirals over the caps above and below the horizon: even in solid
// angle, where the table's own spacing is not. DK_METER_SAMPLES / 128 workgroups.
@compute @workgroup_size(128)
fn dkMeterSample(@builtin(global_invocation_id) id: vec3u) {
    let j = id.x;
    if (j >= DK_METER_SAMPLES) {
        return;
    }
    let a = dkAtmosphere;
    let h = max(dkParams.observerAltitude, 0.0);
    let size = vec2f(textureDimensions(dkSkyViewLut));
    // The visible horizon from h, from space as well: it splits the caps.
    let horizon = dkHorizonOf(a, h);
    let total = f32(DK_METER_SAMPLES);
    let k = f32(j) + 0.5;
    let azimuth = dkGoldenAzimuth(j);
    let above = dkMeterLog2(a, h, horizon, 1.0 - (1.0 - horizon.x) * k / total, azimuth, size, false);
    let below = dkMeterLog2(a, h, horizon, -1.0 + (1.0 + horizon.x) * k / total, azimuth, size, true);
    dkMeteringOut.samples[j] = vec2f(above, below);
}

// The reading from the samples, one workgroup: the brightest of each cap, then the geometric mean of the samples held
// within DK_METER_RANGE of it, and the brighter cap's. Also the sun's light and the observer's horizon.
@compute @workgroup_size(128)
fn dkMeterSky(@builtin(local_invocation_index) index: u32) {
    let a = dkAtmosphere;
    let h = max(dkParams.observerAltitude, 0.0);
    let first = index * DK_METER_SAMPLES_PER_THREAD;

    var brightest = vec2f(log2(DK_METER_FLOOR));
    for (var i = 0u; i < DK_METER_SAMPLES_PER_THREAD; i = i + 1u) {
        brightest = max(brightest, dkMeteringOut.samples[first + i]);
    }

    // The brightest of each cap over the workgroup, by halving.
    dkMeterBrightest[index] = brightest;
    workgroupBarrier();
    for (var stride = DK_METER_THREADS / 2u; stride > 0u; stride = stride / 2u) {
        if (index < stride) {
            dkMeterBrightest[index] = max(dkMeterBrightest[index], dkMeterBrightest[index + stride]);
        }
        workgroupBarrier();
    }
    let lowest = dkMeterBrightest[0] - DK_METER_RANGE;

    var sum = vec2f(0.0);
    for (var i = 0u; i < DK_METER_SAMPLES_PER_THREAD; i = i + 1u) {
        sum = sum + max(dkMeteringOut.samples[first + i], lowest);
    }
    let sums = dkWorkgroupSum(vec4f(sum, 0.0, 0.0), index);
    if (index == 0u) {
        dkMeteringOut.log2Luminance = max(sums.x, sums.y) / f32(DK_METER_SAMPLES);
        dkMeteringOut.sunIlluminance = dkToRgb(a, a.solarIlluminance * dkSunTransmittance(a, h));
        dkMeteringOut.horizon = vec4f(dkHorizonOf(a, h), 0.0);
    }
}
