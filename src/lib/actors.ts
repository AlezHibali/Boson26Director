export type ActorCapabilities = {
  meshes: number;
  bones: string[];
  morphs: string[];
  outfits: string[];
  animations: string[];
};
export const actors = [
  {
    id: "mira",
    name: "Mira",
    url: "/actors/mira.glb",
    description: "Teal knit · warm terracotta",
    license: "CC0-1.0",
  },
  {
    id: "ren",
    name: "Ren",
    url: "/actors/ren.glb",
    description: "Muted violet · charcoal hair",
    license: "CC0-1.0",
  },
] as const;
