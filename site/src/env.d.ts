/// <reference types="@webgpu/types" />

declare module "*.wgsl" {
    const source: string;
    export default source;
}

declare namespace App {
    interface Locals {
        /** The chapter's section ids, for the rule above each (see Section.astro). */
        sections?: { id: string; title: string }[];
    }
}
