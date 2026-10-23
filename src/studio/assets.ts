import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import * as THREE from "three";
import type { AssetDefinition } from "@/domain/scene";
export function verifyAsset(gltf: GLTF, asset: AssetDefinition) {
  const morphs = new Set<string>();
  const names = new Set<string>();
  let bones = 0;
  gltf.scene.traverse((object) => {
    names.add(object.name);
    if (object instanceof THREE.SkinnedMesh)
      bones = Math.max(bones, object.skeleton.bones.length);
    if (object instanceof THREE.Mesh)
      Object.keys(object.morphTargetDictionary || {}).forEach((name) =>
        morphs.add(name),
      );
  });
  const animations = gltf.animations.map((clip) => clip.name);
  if (
    !bones ||
    !asset.animations.includes("Idle") ||
    !asset.outfits.length ||
    Object.keys(asset.morphs).some((name) => !morphs.has(name)) ||
    asset.outfits.some((name) => !names.has("Outfit_" + name)) ||
    asset.animations.some((name) => !animations.includes(name))
  )
    throw new Error("资产缺少声明的 morph、服装、骨骼或动作。");
}
export function createAssetLibrary() {
  const ready = new Map<string, GLTF>();
  const pending = new Map<string, Promise<void>>();
  const loader = new GLTFLoader();
  return {
    get: (id: string) => ready.get(id),
    async load(asset: AssetDefinition) {
      if (ready.has(asset.id)) return;
      if (pending.has(asset.id)) return pending.get(asset.id);
      const task = loader
        .loadAsync(asset.url)
        .then((gltf) => {
          verifyAsset(gltf, asset);
          ready.set(asset.id, gltf);
        })
        .finally(() => pending.delete(asset.id));
      pending.set(asset.id, task);
      return task;
    },
  };
}
