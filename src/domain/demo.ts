import { initialScene } from "./scene";
export function demoScene() {
  const scene = initialScene();
  scene.actor.appearance.EyeSize = 0.55;
  scene.actor.outfit = "Suit";
  scene.actor.rotationY = 45;
  return scene;
}
