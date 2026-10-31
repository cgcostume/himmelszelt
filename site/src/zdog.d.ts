import "zdog";

// What the figures use of Zdog beyond its typings: an anchor's children, how it sorts, the SVG element a shape renders to, and its path.
declare module "zdog" {
    interface Anchor {
        children: Anchor[];
        svgElement?: SVGElement;
        renderOrigin: Vector;
        sortValue: number;
        updateSortValue(): void;
    }
    interface Shape {
        path: PathCommand[];
    }
}
