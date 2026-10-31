// A light meter: every texel of the source counted into histograms of red, green, blue, luminance and the brightest
// channel, by the share of the source it covers, for `meter.ts` to read. Counts are integers, the only atomics there are.
// Goes with `meterSource(kind)`: the source's declaration and the entry point, by what the source is. A pass, so it declares
// its bindings.

const HD_METER_BINS: u32 = 2048u;
const HD_METER_BINS_PER_STOP: f32 = 32.0;
const HD_METER_LOWEST_STOP: f32 = -32.0;

struct HdMeterParams {
    // Where the meter looks, full weight within `inner` and none past `outer`, as cosines.
    focus: vec3f,
    inner: f32,
    outer: f32,
    // What a share of 1 counts for, so that even all of the source in one bin stays within 32 bits.
    scale: f32,
    // The shares of the darkest and of the brightest to leave out, or `low` below 0 for a floor of `rangeStops` instead.
    low: f32,
    high: f32,
    rangeStops: f32,
    // Seconds since the last reading, 0 to take this one at once, and the time constants towards brighter and darker.
    seconds: f32,
    toBrighter: f32,
    toDarker: f32,
    // One texel counted in so many along either axis.
    stride: f32,
}

// The reading, no round trip needed: its luminance, its EV100 and the EV100 adapted towards it.
struct HdMeterResult {
    luminance: f32,
    ev100: f32,
    adapted: f32,
}

@group(0) @binding(1) var<uniform> hdMeterParams: HdMeterParams;
@group(0) @binding(2) var<storage, read_write> hdMeterCounts: array<atomic<u32>, 10240>;
@group(0) @binding(4) var<storage, read_write> hdMeterResult: HdMeterResult;

fn hdMeterFinite(value: f32) -> bool {
    return (bitcast<u32>(value) & 0x7f800000u) != 0x7f800000u;
}

// The bin of a value, each centered on its stop: 0 holds whatever is too dark to tell from nothing.
fn hdMeterBin(value: f32) -> u32 {
    if (!(value > 0.0)) {
        return 0u;
    }
    let bin = round((log2(value) - HD_METER_LOWEST_STOP) * HD_METER_BINS_PER_STOP);
    return u32(clamp(bin, 0.0, f32(HD_METER_BINS - 1u)));
}

// The texel a cell of a thinned reading counts, anywhere in the cell: a fixed grid would miss the same lamp every time, or
// fall in step with a regular image, and this way a small bright place still counts by the area it covers.
fn hdMeterTexel(cell: vec2u) -> vec2u {
    let stride = u32(hdMeterParams.stride);
    if (stride <= 1u) {
        return cell;
    }
    var hash = (cell.x * 1597334677u) ^ (cell.y * 3812015801u);
    hash = (hash ^ (hash >> 16u)) * 2654435769u;
    return cell * stride + vec2u(hash % stride, (hash >> 16u) % stride);
}

fn hdMeterFocus(direction: vec3f) -> f32 {
    // No focus: its cosines are out of reach.
    if (hdMeterParams.inner > 1.0) {
        return 1.0;
    }
    return smoothstep(hdMeterParams.outer, hdMeterParams.inner, dot(direction, hdMeterParams.focus));
}

fn hdMeterCount(color: vec3f, weight: f32) {
    let channels = array<f32, 5>(
        color.r,
        color.g,
        color.b,
        dot(color, vec3f(0.2126, 0.7152, 0.0722)),
        max(color.r, max(color.g, color.b)),
    );
    // A half float overflows to infinity, a Sun's disc in cd/m² for one: such a place tells nothing, and is left out.
    if (!hdMeterFinite(channels[3])) {
        return;
    }
    let count = u32(weight * hdMeterParams.scale + 0.5);
    for (var channel = 0u; channel < 5u; channel = channel + 1u) {
        atomicAdd(&hdMeterCounts[channel * HD_METER_BINS + hdMeterBin(channels[channel])], count);
    }
}

fn hdMeterStop(bin: u32) -> f32 {
    return HD_METER_LOWEST_STOP + f32(bin) / HD_METER_BINS_PER_STOP;
}

// Dispatched once, after the counting: the same mean as `meteredLuminance` in meter.ts.
@compute @workgroup_size(1)
fn hdMeterResolve() {
    const LUMINANCE = 3u * HD_METER_BINS;
    var total = 0.0;
    for (var bin = 0u; bin < HD_METER_BINS; bin = bin + 1u) {
        total = total + f32(atomicLoad(&hdMeterCounts[LUMINANCE + bin]));
    }
    var sum = 0.0;
    var mean = 0.0;
    var weight = 0.0;
    if (hdMeterParams.low >= 0.0) {
        let from_ = hdMeterParams.low * total;
        let to_ = hdMeterParams.high * total;
        for (var bin = 0u; bin < HD_METER_BINS; bin = bin + 1u) {
            let count = f32(atomicLoad(&hdMeterCounts[LUMINANCE + bin]));
            let kept = max(min(sum + count, to_) - max(sum, from_), 0.0);
            if (bin > 0u) {
                mean = mean + kept * hdMeterStop(bin);
                weight = weight + kept;
            }
            sum = sum + count;
        }
    } else {
        var bright = 0u;
        for (var bin = 0u; bin < HD_METER_BINS && sum < 0.99 * total; bin = bin + 1u) {
            sum = sum + f32(atomicLoad(&hdMeterCounts[LUMINANCE + bin]));
            bright = bin;
        }
        if (bright > 0u) {
            let floor_ = hdMeterStop(bright) - hdMeterParams.rangeStops;
            for (var bin = 0u; bin < HD_METER_BINS; bin = bin + 1u) {
                let count = f32(atomicLoad(&hdMeterCounts[LUMINANCE + bin]));
                mean = mean + count * max(hdMeterStop(bin), floor_);
                weight = weight + count;
            }
        }
    }
    // Nothing lit tells nothing: the exposure stays where it was.
    if (weight > 0.0) {
        hdMeterResult.ev100 = mean / weight + 3.0;
        hdMeterResult.luminance = exp2(mean / weight);
    } else {
        hdMeterResult.luminance = 0.0;
    }
    let target_ = hdMeterResult.ev100;
    let constant = select(hdMeterParams.toDarker, hdMeterParams.toBrighter, target_ > hdMeterResult.adapted);
    hdMeterResult.adapted = select(
        target_,
        target_ + (hdMeterResult.adapted - target_) * exp(-hdMeterParams.seconds / max(constant, 1e-3)),
        hdMeterParams.seconds > 0.0,
    );
}
