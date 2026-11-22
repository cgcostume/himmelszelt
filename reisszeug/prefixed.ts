/**
 * A chunk of reisszeug's WGSL under the prefix of the package that inlines it: `rzName` becomes `dkName`, `RzName`
 * `DkName` and `RZ_NAME` `DK_NAME`. Each package's identifiers stay its own, so chunks inlined by two packages never
 * collide in one module.
 */
export function prefixed(code: string, prefix: string): string {
    const title = `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`;
    return code
        .replace(/\brz(?=[A-Z])/g, prefix)
        .replace(/\bRz(?=[A-Z])/g, title)
        .replace(/\bRZ_/g, `${prefix.toUpperCase()}_`);
}
