import { z } from "zod";
import { catalog, type SceneState } from "./scene";
export const EmotionSchema = z.enum(["neutral", "fear", "anger"]);
const n = (min: number, max: number) => z.number().finite().min(min).max(max);
export const SceneSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    actor: z
      .object({
        id: z.literal("actor-1"),
        presetId: z.enum(["mira", "ren"]),
        position: z
          .object({ x: n(-0.75, 0.75), y: z.literal(0), z: n(-0.8, 0) })
          .strict(),
        rotationY: n(-180, 180),
        appearance: z.object({ EyeSize: n(0, 1), FaceWidth: n(0, 1) }).strict(),
        expression: z.object({}).strict(),
        outfit: z.enum(["Casual", "Suit"]),
        animation: z
          .object({
            name: z.enum(["Idle", "Wave"]),
            token: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    camera: z
      .object({
        distance: n(2.2, 6),
        azimuth: n(-60, 60),
        height: n(0.8, 3),
        fov: n(25, 65),
        targetY: n(0.8, 1.8),
      })
      .strict(),
    lights: z
      .object({
        key: n(0, 6),
        fill: n(0, 4),
        rim: n(0, 6),
        ambient: n(0.05, 1.5),
        temperature: z.enum(["warm", "neutral", "cool"]),
      })
      .strict(),
    performance: z
      .object({
        dialogue: z
          .string()
          .min(1)
          .max(300)
          .refine((v) => !!v.trim() && !v.includes("<|")),
        emotion: EmotionSchema,
      })
      .strict(),
  })
  .strict()
  .refine((s) => catalog[s.actor.presetId].outfits.includes(s.actor.outfit));
export const RequestIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9:_-]+$/);
export const TakeIdSchema = z.string().uuid();
export const CreateTakeSchema = z
  .object({
    requestId: RequestIdSchema,
    scene: SceneSnapshotSchema,
    portrait: z
      .string()
      .max(2800000)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export const RetakeSchema = z
  .object({
    requestId: RequestIdSchema,
    baseTakeId: TakeIdSchema,
    overrides: z.object({ emotion: EmotionSchema }).strict(),
  })
  .strict();
export type TakeInput = {
  scene: SceneState;
  emotion: z.infer<typeof EmotionSchema>;
  voice: "default";
  model: "higgs-avatar";
  ttsModel: "higgs-tts-3";
  size: "640x640";
  diagnostic?: {
    ref_image: string;
    input?: string;
    input_tts?: { text: string; emotion: "neutral" | "fear" | "anger" };
    size: "640x640" | "640x480" | "480x640";
  };
  reference: {
    hash: string;
    version: "portrait-v1";
    mode: "captured" | "diagnostic";
    appearanceKey: string;
  };
};
export type TakeStatus =
  | "submitting"
  | "queued"
  | "in_progress"
  | "completed"
  | "failed"
  | "submission_unknown";
export type Take = {
  id: string;
  requestId: string;
  baseTakeId: string | null;
  createdAt: string;
  status: TakeStatus;
  videoId: string | null;
  progress: number | null;
  error: string | null;
  input: TakeInput;
  inputHash: string;
  invariantHash: string;
};
export const activeTake = (t: Pick<Take, "status">) =>
  ["submitting", "queued", "in_progress", "submission_unknown"].includes(
    t.status,
  );
export function appearanceKey(scene: SceneState) {
  const a = scene.actor;
  return JSON.stringify([
    a.presetId,
    a.outfit,
    a.appearance.EyeSize,
    a.appearance.FaceWidth,
  ]);
}
