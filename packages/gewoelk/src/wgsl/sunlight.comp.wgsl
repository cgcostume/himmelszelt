// The sunlight table from dunstkreis' transmittance table: the sun's illuminance at each row's altitude for each of its
// elevations above the local horizon, per channel in lux, written where GwSunlight's table lies. Far clouds towards the
// sun stay lit after the ground has fallen into shadow, by a redder sun. Needs dunstkreis' `atmosphere`, `common`,
// `lut` and `sampling` before it.

@group(0) @binding(0) var<uniform> gwAtmosphere: DkAtmosphere;
@group(0) @binding(1) var gwTransmittanceLut: texture_2d<f32>;
@group(0) @binding(2) var gwLutSampler: sampler;
// Per entry the altitude in km and the sine of the sun's apparent elevation there.
@group(0) @binding(3) var<storage, read> gwSunlightQuery: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> gwSunlightOut: array<vec4f>;

@compute @workgroup_size(64)
fn gwSunlightTable(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&gwSunlightQuery)) {
        return;
    }
    let a = gwAtmosphere;
    let query = gwSunlightQuery[id.x];
    let altitude = clamp(query.x, 0.0, a.Rt - a.Rg);
    let transmittance = dkSampleTransmittanceToTop(a, gwTransmittanceLut, gwLutSampler, altitude, query.y);
    gwSunlightOut[id.x] = vec4f(dkToRgb(a, a.solarIlluminance * transmittance), 1.0);
}
