import * as THREE from "three";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { catalog, type SceneState } from "@/domain/scene";
import type { createAssetLibrary } from "./assets";
// Render the frozen appearance with a dedicated front camera, neutral lights and rest pose.
// Stage camera, actor rotation, animation and room never affect the Avatar reference.
export async function capturePortrait(
  snapshot: SceneState,
  library: ReturnType<typeof createAssetLibrary>,
) {
  await library.load(catalog[snapshot.actor.presetId]);
  const gltf = library.get(snapshot.actor.presetId);
  if (!gltf) throw new Error("演员尚未加载，无法捕获人像。");
  const actor = clone(gltf.scene);
  actor.traverse((node) => {
    if (
      node instanceof THREE.Mesh &&
      node.morphTargetDictionary &&
      node.morphTargetInfluences
    )
      for (const [name, index] of Object.entries(node.morphTargetDictionary))
        node.morphTargetInfluences[index] =
          snapshot.actor.appearance[name] ?? 0;
    if (node.name.startsWith("Outfit_"))
      node.visible = node.name === "Outfit_" + snapshot.actor.outfit;
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#8b969a");
  scene.add(actor);
  scene.add(new THREE.AmbientLight(0xffffff, 2));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(1, 3, 4);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
  camera.position.set(0, 1.8, 2.8);
  camera.lookAt(0, 1.65, 0);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(640, 640);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  try {
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/png");
  } finally {
    actor.traverse((node) => {
      if (node instanceof THREE.SkinnedMesh) node.skeleton.dispose();
    });
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
