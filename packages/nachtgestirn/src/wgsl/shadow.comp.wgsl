// The shadow map: for each point of the band around the terminator, how much of the Sun's disc stands above the terrain,
// marched through the heights once, not per ray and frame. A window of the band in its own frame, longitude about the
// Sun and angle from the subsolar point, `nbParams.shadowSun`, `shadowEast` and `shadowWindow`; the whole ring while the
// disc is small enough, else what the view shows. Kept until the Sun, the view or the disc's size have moved on.
// Requires `moon.comp.wgsl` with all it requires, and the output binding from `moonOutput` for the map's format.

@compute @workgroup_size(8, 8, 1)
fn nbShadows(@builtin(global_invocation_id) id: vec3u) {
    let p = nbParams;
    if (f32(id.x) >= p.shadowWindow.y || f32(id.y) >= p.shadowWindow.z) {
        return;
    }
    let texel = p.shadowSun.w;
    let s = p.shadowSun.xyz;
    let east = p.shadowEast.xyz;
    let longitude = p.shadowEast.w + (f32(id.x) + 0.5) * texel;
    let theta = p.shadowWindow.x + (f32(id.y) + 0.5) * texel;
    let body = s * cos(theta) + (east * cos(longitude) + cross(s, east) * sin(longitude)) * sin(theta);
    let fine = nbInDetail(body);
    let level = max(log2(max(texel * p.moonRadiusKm / nbReliefTexelKm(fine), 1e-4)), 0.0);
    let height = nbHeightAt(body, level, fine);
    let sunShare = nbSunAboveTerrain(body, s, height, level, fine);
    // The rays of a disc that is not displaced meet the smooth sphere: near the limb a point the terrain in front hides
    // from the viewer is seen anyway. Its shadow is then the hidden part of the occluder's, which near full Moon, the Sun
    // at the viewer's back, the eye would not see: where the viewer cannot see the point, it takes no shadow.
    let viewer = p.orientation * -p.direction;
    let seen = select(1.0, nbAboveTerrain(body, viewer, height, level, fine, p.sunAngularRadius), sunShare < 1.0);
    nbOutputStore(id.xy, vec4f(mix(1.0, sunShare, seen)));
}
