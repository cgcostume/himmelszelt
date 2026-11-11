// The shadow map: for each point of the band around the terminator, how much of the Sun's disc stands above the terrain,
// marched through the heights once, not per ray and frame. A window of the band in its own frame, longitude about the
// Sun and angle from the subsolar point, `ngParams.shadowSun`, `shadowEast` and `shadowWindow`; the whole ring while the
// disc is small enough, else what the view shows. Kept until the Sun, the view or the disc's size have moved on.
// Requires `moon.comp.wgsl` with all it requires, and the output binding from `moonOutput` for the map's format.

@compute @workgroup_size(8, 8, 1)
fn ngShadows(@builtin(global_invocation_id) id: vec3u) {
    if (f32(id.x) >= ngParams.shadowWindow.y || f32(id.y) >= ngParams.shadowWindow.z) {
        return;
    }

    // The map's frame, in the Moon's own: the pole towards the Sun, and two axes around it, longitude 0 and 90°.
    let toSun = ngParams.shadowSun.xyz;
    let axisX = ngParams.shadowEast.xyz;
    let axisY = cross(toSun, axisX);
    // The texel's middle in that frame: its longitude about the Sun, and its angle from the subsolar point.
    let texelAngle = ngParams.shadowSun.w;
    let longitude = ngParams.shadowEast.w + (f32(id.x) + 0.5) * texelAngle;
    let fromSubsolar = ngParams.shadowWindow.x + (f32(id.y) + 0.5) * texelAngle;
    // Its point on the Moon's unit sphere, in the Moon's frame.
    let around = axisX * cos(longitude) + axisY * sin(longitude);
    let point = toSun * cos(fromSubsolar) + around * sin(fromSubsolar);

    // The terrain's height there, read as coarse as the map's texels are wide, from the strip where it lies in one.
    let inStrip = ngInDetail(point);
    let level = max(log2(max(texelAngle * ngParams.moonRadiusKm / ngReliefTexelKm(inStrip), 1e-4)), 0.0);
    let height = ngHeightAt(point, level, inStrip, NG_SPLINE_SHADOWS);

    // The share of the Sun's disc above the terrain: soft by its half degree, or a point's, all or nothing.
    let sunRadius = max(ngParams.shadowWindow.w, 1e-7);
    let lit = ngDiscAboveTerrain(point, toSun, height, level, inStrip, sunRadius);

    // The rays of a disc that is not displaced meet the smooth sphere: near the limb a point the terrain in front hides
    // from the viewer is seen anyway. Its shadow is then the hidden part of the occluder's, which near full Moon, the Sun
    // at the viewer's back, the eye would not see: where the viewer cannot see the point, it takes no shadow.
    let toViewer = ngParams.orientation * -ngParams.direction;
    var seen = 1.0;
    if (lit < 1.0) {
        seen = ngDiscAboveTerrain(point, toViewer, height, level, inStrip, ngParams.sunAngularRadius);
    }

    ngOutputStore(id.xy, vec4f(mix(1.0, lit, seen), 0.0, 0.0, 1.0));
}
