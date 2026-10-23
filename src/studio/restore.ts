import { SceneSnapshotSchema } from "@/domain/take";
import type { SceneState, Command } from "@/domain/scene";
// Restore is an ordinary validated atomic batch; asset failure keeps the current set.
export function commandsToRestore(
  raw: SceneState,
  emotion = raw.performance.emotion,
): Command {
  const s = SceneSnapshotSchema.parse(raw),
    a = s.actor;
  return {
    type: "batch",
    commands: [
      { type: "select_actor", actorId: "actor-1", presetId: a.presetId },
      ...Object.entries(a.appearance).map(([morph, value]) => ({
        type: "set_appearance" as const,
        actorId: "actor-1",
        morph,
        value,
      })),
      { type: "set_outfit", actorId: "actor-1", outfit: a.outfit },
      {
        type: "rotate_actor",
        actorId: "actor-1",
        mode: "absolute",
        degrees: a.rotationY,
      },
      {
        type: "set_position",
        actorId: "actor-1",
        x: a.position.x,
        z: a.position.z,
      },
      {
        type: "play_animation",
        actorId: "actor-1",
        animation: a.animation.name,
      },
      { type: "set_camera", camera: s.camera },
      { type: "set_lighting", lights: s.lights },
      { type: "set_dialogue", text: s.performance.dialogue },
      { type: "set_emotion", emotion },
    ],
  };
}
