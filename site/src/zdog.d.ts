import "zdog";

// What the figures use of Zdog beyond its typings: an anchor's children, the SVG element a shape renders to, and its path.
declare module "zdog" {
    interface Anchor {
        children: Anchor[];
        svgElement?: SVGElement;
    }
    interface Shape {
        path: PathCommand[];
    }
}
