import { createStore } from "zustand/vanilla";
import {
  catalog,
  CommandSchema,
  commandList,
  initialScene,
  transition,
  type Catalog,
  type CommandResult,
  type SceneState,
  type AssetDefinition,
} from "@/domain/scene";
export type LoadStatus = {
  status: "idle" | "loading" | "ready" | "error";
  target: string;
  sequence: number;
  error?: string;
};
export type StudioState = {
  scene: SceneState;
  load: LoadStatus;
  lastResult: CommandResult | null;
  log: { revision: number; ok: boolean; message: string }[];
};
export type Loader = (asset: AssetDefinition) => Promise<void>;
export function createSceneController(
  loadAsset: Loader,
  assets: Catalog = catalog,
) {
  const store = createStore<StudioState>(() => ({
    scene: initialScene(),
    load: { status: "idle", target: "mira", sequence: 0 },
    lastResult: null,
    log: [],
  }));
  let sequence = 0;
  let disposed = false;
  let retryInput: unknown;
  function record(result: CommandResult, scene?: SceneState) {
    if (disposed) return;
    store.setState((current) => ({
      ...current,
      scene: scene || current.scene,
      lastResult: result,
      log: [
        {
          revision: result.revision,
          ok: result.ok,
          message: result.ok
            ? [result.message, ...result.notices].join(" ")
            : result.message,
        },
        ...current.log,
      ].slice(0, 20),
    }));
  }
  async function dispatch(
    input: unknown,
    expectedRevision?: number,
  ): Promise<CommandResult> {
    if (disposed)
      return {
        ok: false,
        revision: store.getState().scene.revision,
        code: "DISPOSED",
        message: "片场已关闭。",
      };
    const initial = transition(
      store.getState().scene,
      input,
      assets,
      expectedRevision,
    );
    if (!initial.result.ok) {
      record(initial.result);
      return initial.result;
    }
    const parsed = CommandSchema.parse(input);
    const commands = commandList(parsed);
    const selections = commands.filter(
      (c) => c.type === "select_actor" || c.type === "reset_scene",
    );
    if (selections.length) {
      const ticket = ++sequence;
      retryInput = input;
      const ids = [
        ...new Set(
          selections.map((c) =>
            c.type === "select_actor" ? c.presetId : "mira",
          ),
        ),
      ];
      store.setState({
        load: {
          status: "loading",
          target: ids[ids.length - 1],
          sequence: ticket,
        },
      });
      try {
        await Promise.all(ids.map((id) => loadAsset(assets[id])));
        if (disposed || ticket !== sequence)
          return {
            ok: false,
            revision: store.getState().scene.revision,
            code: "SUPERSEDED",
            message: "角色请求已由后续选择替代。",
          };
        // Revalidate against latest state: camera/light edits during loading are preserved.
        const next = transition(
          store.getState().scene,
          input,
          assets,
          expectedRevision,
        );
        store.setState({
          load: {
            status: "ready",
            target: next.result.ok
              ? next.state.actor.presetId
              : store.getState().scene.actor.presetId,
            sequence: ticket,
          },
        });
        record(next.result, next.state);
        return next.result;
      } catch {
        if (disposed || ticket !== sequence)
          return {
            ok: false,
            revision: store.getState().scene.revision,
            code: "SUPERSEDED",
            message: "角色请求已被替代。",
          };
        const result: CommandResult = {
          ok: false,
          revision: store.getState().scene.revision,
          code: "ASSET_LOAD_FAILED",
          message: "角色加载失败。当前演员与片场已保留，可重试。",
        };
        store.setState({
          load: {
            status: "error",
            target: ids[ids.length - 1],
            sequence: ticket,
            error: result.message,
          },
        });
        record(result);
        return result;
      }
    }
    record(initial.result, initial.state);
    return initial.result;
  }
  async function initialize() {
    if (disposed) return;
    const ticket = ++sequence;
    const id = store.getState().scene.actor.presetId;
    retryInput = {
      type: "select_actor",
      actorId: store.getState().scene.actor.id,
      presetId: id,
    };
    store.setState({
      load: { status: "loading", target: id, sequence: ticket },
    });
    try {
      await loadAsset(assets[id]);
      if (!disposed && ticket === sequence)
        store.setState({
          load: { status: "ready", target: id, sequence: ticket },
        });
    } catch {
      if (!disposed && ticket === sequence)
        store.setState({
          load: {
            status: "error",
            target: id,
            sequence: ticket,
            error: "初始演员加载失败。房间与控制台仍可操作，请重试。",
          },
        });
    }
  }
  function finishAnimation(presetId: string, token: number) {
    const scene = store.getState().scene;
    if (
      disposed ||
      scene.actor.presetId !== presetId ||
      scene.actor.animation.name !== "Wave" ||
      scene.actor.animation.token !== token
    )
      return;
    const next = transition(
      scene,
      { type: "play_animation", actorId: scene.actor.id, animation: "Idle" },
      assets,
    );
    record(next.result, next.state);
  }
  return {
    store,
    dispatch,
    initialize,
    finishAnimation,
    retry: () => dispatch(retryInput),
    dispose: () => {
      disposed = true;
      sequence++;
    },
    activate: () => {
      disposed = false;
    },
  };
}
export type SceneController = ReturnType<typeof createSceneController>;
