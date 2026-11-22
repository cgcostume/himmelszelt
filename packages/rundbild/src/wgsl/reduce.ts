import { prefixed } from "../../../../reisszeug/prefixed.js";
import { workgroupSum as sum } from "../../../../reisszeug/reduce.js";

/**
 * `rbWorkgroupSum(value, index)`: the sum of every invocation's `value` over a workgroup of `threads`, a power of two,
 * for every invocation; `index` is its `local_invocation_index`. Call it in uniform control flow, as a barrier.
 *
 * With `subgroups`, for a device with the "subgroups" feature, each subgroup sums its own in registers and one of each
 * adds that to workgroup memory: one barrier instead of one per halving. Without, the classic tree in workgroup memory.
 * The source has to come first in a module: `enable subgroups;` precedes every declaration.
 */
export const workgroupSum = (threads: number, subgroups: boolean): string => prefixed(sum(threads, subgroups), "rb");
