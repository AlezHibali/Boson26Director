import { z } from "zod";
import manifest from "../../public/actors/manifest.json";

export type AssetDefinition = {
  id: string;
  name: string;
  url: string;
  morphs: Record<string, { min: number; max: number }>;
  outfits: string[];
  animations: string[];
};
export type Catalog = Record<string, AssetDefinition>;
export const catalog: Catalog = Object.fromEntries(
  manifest.map((asset) => [
    asset.id,
    {
      id: asset.id,
      name: asset.name,
      url: asset.url,
      morphs: Object.fromEntries(
        asset.morphs.map((name) => [name, { min: 0, max: 1 }]),
      ),
      outfits: asset.outfits,
      animations: asset.animations,
    },
  ]),
);

export type SceneState = {
  revision: number;
  actor: {
    id: string;
    presetId: string;
    position: { x: number; y: number; z: number };
    rotationY: number;
    appearance: Record<string, number>;
    expression: Record<string, number>;
    outfit: string;
    animation: { name: string; token: number };
  };
  camera: {
    distance: number;
    azimuth: number;
    height: number;
    fov: number;
    targetY: number;
  };
  lights: {
    key: number;
    fill: number;
    rim: number;
    ambient: number;
    temperature: "warm" | "neutral" | "cool";
  };
  performance: { dialogue: string; emotion: "neutral" | "fear" | "anger" };
};
export function initialScene(): SceneState {
  return {
    revision: 0,
    actor: {
      id: "actor-1",
      presetId: "mira",
      position: { x: 0, y: 0, z: -0.45 },
      rotationY: 0,
      appearance: { EyeSize: 0.15, FaceWidth: 0.1 },
      expression: {},
      outfit: "Casual",
      animation: { name: "Idle", token: 0 },
    },
    camera: { distance: 5.2, azimuth: 0, height: 1.9, fov: 40, targetY: 1.2 },
    lights: {
      key: 3.5,
      fill: 1.1,
      rim: 2.5,
      ambient: 0.5,
      temperature: "warm",
    },
    performance: { dialogue: "I didn't do it.", emotion: "fear" },
  };
}
const actorId = z.string().min(1).max(80);
const finite = () => z.number().finite();
const cameraPatch = z
  .object({
    distance: finite().min(2.2).max(6).optional(),
    azimuth: finite().min(-60).max(60).optional(),
    height: finite().min(0.8).max(3).optional(),
    fov: finite().min(25).max(65).optional(),
    targetY: finite().min(0.8).max(1.8).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Camera patch is empty.");
const lightsPatch = z
  .object({
    key: finite().min(0).max(6).optional(),
    fill: finite().min(0).max(4).optional(),
    rim: finite().min(0).max(6).optional(),
    ambient: finite().min(0.05).max(1.5).optional(),
    temperature: z.enum(["warm", "neutral", "cool"]).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Lighting patch is empty.");
const SingleSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("select_actor"),
      actorId,
      presetId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_appearance"),
      actorId,
      morph: z.string().min(1),
      value: finite().min(0).max(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_outfit"),
      actorId,
      outfit: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("rotate_actor"),
      actorId,
      mode: z.enum(["relative", "absolute"]),
      degrees: finite().min(-360).max(360),
    })
    .strict(),
  z
    .object({
      type: z.literal("set_position"),
      actorId,
      x: finite().min(-0.75).max(0.75),
      z: finite().min(-0.8).max(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("play_animation"),
      actorId,
      animation: z.string().min(1),
    })
    .strict(),
  z.object({ type: z.literal("set_camera"), camera: cameraPatch }).strict(),
  z
    .object({ type: z.literal("dolly"), amount: finite().min(-2).max(2) })
    .strict(),
  z
    .object({ type: z.literal("orbit"), degrees: finite().min(-120).max(120) })
    .strict(),
  z.object({ type: z.literal("set_lighting"), lights: lightsPatch }).strict(),
  z
    .object({ type: z.literal("set_dialogue"), text: z.string().max(300) })
    .strict(),
  z
    .object({
      type: z.literal("set_emotion"),
      emotion: z.enum(["neutral", "fear", "anger"]),
    })
    .strict(),
  z.object({ type: z.literal("reset_scene") }).strict(),
]);
export const CommandSchema = z.union([
  SingleSchema,
  z
    .object({
      type: z.literal("batch"),
      commands: z.array(SingleSchema).min(1).max(16),
    })
    .strict(),
]);
export type Command = z.infer<typeof CommandSchema>;
export type SingleCommand = z.infer<typeof SingleSchema>;
export type CommandResult =
  | { ok: true; revision: number; message: string; notices: string[] }
  | { ok: false; revision: number; code: string; message: string };
export type Transition = { state: SceneState; result: CommandResult };
class CommandError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function wrapDegrees(value: number) {
  const normalized = ((((value + 180) % 360) + 360) % 360) - 180;
  return Object.is(normalized, -0) ? 0 : normalized;
}
export function commandList(command: Command): SingleCommand[] {
  return command.type === "batch" ? command.commands : [command];
}

function applyOne(
  scene: SceneState,
  command: SingleCommand,
  assets: Catalog,
  notices: string[],
) {
  if ("actorId" in command && command.actorId !== scene.actor.id)
    throw new CommandError("UNKNOWN_ACTOR", "未找到演员：" + command.actorId);
  const asset = assets[scene.actor.presetId];
  switch (command.type) {
    case "select_actor": {
      const next = Object.hasOwn(assets, command.presetId)
        ? assets[command.presetId]
        : undefined;
      if (!next)
        throw new CommandError(
          "UNKNOWN_PRESET",
          "未找到角色预设：" + command.presetId,
        );
      for (const name of Object.keys(scene.actor.appearance)) {
        const range = next.morphs[name];
        if (!range) {
          delete scene.actor.appearance[name];
          notices.push("新角色不支持 " + name + "，已移除该外形参数。");
        } else if (
          scene.actor.appearance[name] < range.min ||
          scene.actor.appearance[name] > range.max
        ) {
          scene.actor.appearance[name] = Math.min(
            range.max,
            Math.max(range.min, scene.actor.appearance[name]),
          );
          notices.push(name + " 已调整到新角色支持的范围。");
        }
      }
      for (const [name, range] of Object.entries(next.morphs))
        if (scene.actor.appearance[name] === undefined)
          scene.actor.appearance[name] = range.min;
      if (!next.outfits.includes(scene.actor.outfit)) {
        scene.actor.outfit = next.outfits[0];
        notices.push("服装不兼容，已切换为 " + scene.actor.outfit + "。");
      }
      if (!next.animations.includes(scene.actor.animation.name)) {
        scene.actor.animation.name = "Idle";
        notices.push("动作不兼容，已回到 Idle。");
      }
      scene.actor.presetId = next.id;
      scene.actor.animation.token++;
      break;
    }
    case "set_appearance": {
      const range = Object.hasOwn(asset.morphs, command.morph)
        ? asset.morphs[command.morph]
        : undefined;
      if (!range)
        throw new CommandError(
          "UNSUPPORTED_MORPH",
          "当前角色不支持外形参数：" + command.morph,
        );
      if (command.value < range.min || command.value > range.max)
        throw new CommandError(
          "OUT_OF_RANGE",
          "外形参数超出当前角色支持的范围。",
        );
      scene.actor.appearance[command.morph] = command.value;
      break;
    }
    case "set_outfit":
      if (!asset.outfits.includes(command.outfit))
        throw new CommandError(
          "UNSUPPORTED_OUTFIT",
          "当前角色不支持服装：" + command.outfit,
        );
      scene.actor.outfit = command.outfit;
      break;
    case "rotate_actor":
      scene.actor.rotationY = wrapDegrees(
        (command.mode === "relative" ? scene.actor.rotationY : 0) +
          command.degrees,
      );
      break;
    case "set_position":
      scene.actor.position.x = command.x;
      scene.actor.position.z = command.z;
      break;
    case "play_animation":
      if (!asset.animations.includes(command.animation))
        throw new CommandError(
          "UNSUPPORTED_ANIMATION",
          "当前角色不支持动作：" + command.animation,
        );
      scene.actor.animation = {
        name: command.animation,
        token: scene.actor.animation.token + 1,
      };
      break;
    case "set_camera":
      Object.assign(scene.camera, command.camera);
      break;
    case "dolly": {
      const distance = Number(
        (scene.camera.distance - command.amount).toFixed(5),
      );
      if (distance < 2.2 || distance > 6)
        throw new CommandError(
          "OUT_OF_RANGE",
          "摄影机距离须保持在 2.2–6 米，已保留原机位。",
        );
      scene.camera.distance = distance;
      break;
    }
    case "orbit": {
      const azimuth = scene.camera.azimuth + command.degrees;
      if (azimuth < -60 || azimuth > 60)
        throw new CommandError(
          "OUT_OF_RANGE",
          "环绕角度须保持在 -60°–60°，已保留原机位。",
        );
      scene.camera.azimuth = azimuth;
      break;
    }
    case "set_lighting":
      Object.assign(scene.lights, command.lights);
      break;
    case "set_dialogue":
      scene.performance.dialogue = command.text;
      break;
    case "set_emotion":
      scene.performance.emotion = command.emotion;
      break;
    case "reset_scene": {
      const reset = initialScene();
      reset.actor.id = scene.actor.id;
      reset.actor.animation.token = scene.actor.animation.token + 1;
      const revision = scene.revision;
      Object.assign(scene, reset);
      scene.revision = revision;
      break;
    }
  }
}
/** Pure, atomic command boundary. Errors preserve the exact original object. */
export function transition(
  state: SceneState,
  input: unknown,
  assets: Catalog = catalog,
  expectedRevision?: number,
): Transition {
  if (expectedRevision !== undefined && expectedRevision !== state.revision)
    return {
      state,
      result: {
        ok: false,
        revision: state.revision,
        code: "STALE_REVISION",
        message: "场景已变化，请读取最新状态后重试。",
      },
    };
  const parsed = CommandSchema.safeParse(input);
  if (!parsed.success)
    return {
      state,
      result: {
        ok: false,
        revision: state.revision,
        code: "INVALID_COMMAND",
        message: "命令格式或数值无效。请检查参数名称、单位及范围。",
      },
    };
  const draft = structuredClone(state);
  const notices: string[] = [];
  try {
    for (const command of commandList(parsed.data))
      applyOne(draft, command, assets, notices);
    draft.revision = state.revision + 1;
    return {
      state: draft,
      result: {
        ok: true,
        revision: draft.revision,
        message:
          parsed.data.type === "batch"
            ? "整批导演指令已执行。"
            : "导演指令已执行。",
        notices,
      },
    };
  } catch (error) {
    return {
      state,
      result: {
        ok: false,
        revision: state.revision,
        code: error instanceof CommandError ? error.code : "INVALID_COMMAND",
        message: error instanceof Error ? error.message : "命令执行失败。",
      },
    };
  }
}
