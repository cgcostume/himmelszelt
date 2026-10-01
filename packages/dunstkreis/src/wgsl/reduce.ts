/**
 * `dkWorkgroupSum(value, index)`: the sum of every invocation's `value` over a workgroup of `threads`, a power of two,
 * for every invocation; `index` is its `local_invocation_index`. Call it in uniform control flow, as a barrier.
 *
 * With `subgroups`, for a device with the "subgroups" feature, each subgroup sums its own in registers and one of each
 * adds that to workgroup memory: one barrier instead of one per halving. Without, the classic tree in workgroup memory.
 * The source has to come first in a module: `enable subgroups;` precedes every declaration.
 */
export const workgroupSum = (threads: number, subgroups: boolean) =>
    subgroups
        ? `
enable subgroups;

// One sum per subgroup, at most one per four invocations, the smallest subgroup there is; written by whichever
// subgroup comes first, to the next free slot.
var<workgroup> dkSumSlots: array<vec4f, ${threads / 4}>;
var<workgroup> dkSumCount: atomic<u32>;

fn dkWorkgroupSum(value: vec4f, index: u32) -> vec4f {
    workgroupBarrier();
    if (index == 0u) {
        atomicStore(&dkSumCount, 0u);
    }
    workgroupBarrier();
    let sum = subgroupAdd(value);
    if (subgroupElect()) {
        dkSumSlots[atomicAdd(&dkSumCount, 1u)] = sum;
    }
    workgroupBarrier();
    let count = atomicLoad(&dkSumCount);
    var total = vec4f(0.0);
    for (var i = 0u; i < ${threads / 4}u; i = i + 1u) {
        total = total + select(vec4f(0.0), dkSumSlots[i], i < count);
    }
    return total;
}
`
        : `
var<workgroup> dkSumSlots: array<vec4f, ${threads}>;

fn dkWorkgroupSum(value: vec4f, index: u32) -> vec4f {
    workgroupBarrier();
    dkSumSlots[index] = value;
    workgroupBarrier();
    for (var stride = ${threads / 2}u; stride > 0u; stride = stride / 2u) {
        if (index < stride) {
            dkSumSlots[index] = dkSumSlots[index] + dkSumSlots[index + stride];
        }
        workgroupBarrier();
    }
    return dkSumSlots[0];
}
`;
