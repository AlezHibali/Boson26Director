import * as THREE from "three";
export function createActorPlayer(
  scene: THREE.Object3D,
  clips: THREE.AnimationClip[],
  finished: (token: number) => void,
) {
  const mixer = new THREE.AnimationMixer(scene);
  let activeToken = -1;
  let activeName = "Idle";
  const onFinished = (event: THREE.AnimationMixerEventMap["finished"]) => {
    if (activeName === "Wave" && event.action.getClip().name === "Wave")
      finished(activeToken);
  };
  mixer.addEventListener("finished", onFinished);
  return {
    play(name: string, token: number) {
      mixer.stopAllAction();
      activeToken = token;
      activeName = name;
      const clip = clips.find((c) => c.name === name);
      if (!clip) return;
      const action = mixer.clipAction(clip).reset();
      action.setLoop(
        name === "Wave" ? THREE.LoopOnce : THREE.LoopRepeat,
        name === "Wave" ? 1 : Infinity,
      );
      action.clampWhenFinished = false;
      action.play();
    },
    update: (delta: number) => mixer.update(delta),
    dispose() {
      mixer.removeEventListener("finished", onFinished);
      mixer.stopAllAction();
      mixer.uncacheRoot(scene);
    },
  };
}
