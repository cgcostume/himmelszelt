/**
 * `rzWorkgroupSum(value, index)`: the sum of every invocation's `value` over a workgroup of `threads`, a power of two,
 * for every invocation; `index` is its `local_invocation_index`. Call it in uniform control flow, as a barrier.
 *
 * With `subgroups`, for a device with the "subgroups" feature, each subgroup sums its own in registers and one of each
 * adds that to workgroup memory: one barrier instead of one per halving. Without, the classic tree in workgroup memory.
 * The source has to come first in a module: `enable subgroups;` precedes every declaration.
 */
export const workgroupSum = (threads: number, subgroups: boolean): string =>
    subgroups
        ? `
enable subgroups;

// One sum per subgroup, at most one per four invocations, the smallest subgroup there is; written by whichever
// subgroup comes first, to the next free slot.
var<workgroup> rzSumSlots: array<vec4f, ${threads / 4}>;
var<workgroup> rzSumCount: atomic<u32>;

fn rzWorkgroupSum(value: vec4f, index: u32) -> vec4f {
    workgroupBarrier();
    if (index == 0u) {
        atomicStore(&rzSumCount, 0u);
    }
    workgroupBarrier();
    let sum = subgroupAdd(value);
    if (subgroupElect()) {
        rzSumSlots[atomicAdd(&rzSumCount, 1u)] = sum;
    }
    workgroupBarrier();
    let count = atomicLoad(&rzSumCount);
    var total = vec4f(0.0);
    for (var i = 0u; i < ${threads / 4}u; i = i + 1u) {
        total = total + select(vec4f(0.0), rzSumSlots[i], i < count);
    }
    return total;
}
`
        : `
var<workgroup> rzSumSlots: array<vec4f, ${threads}>;

fn rzWorkgroupSum(value: vec4f, index: u32) -> vec4f {
    workgroupBarrier();
    rzSumSlots[index] = value;
    workgroupBarrier();
    for (var stride = ${threads / 2}u; stride > 0u; stride = stride / 2u) {
        if (index < stride) {
            rzSumSlots[index] = rzSumSlots[index] + rzSumSlots[index + stride];
        }
        workgroupBarrier();
    }
    return rzSumSlots[0];
}
`;
