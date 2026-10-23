import { commandFromTool, effectSchemas } from "./tools";
import type {
  Command,
  CommandResult,
  SceneState,
  SingleCommand,
} from "@/domain/scene";
export type ToolLog = {
  callId: string;
  name: string;
  arguments: string;
  status: "working" | "success" | "error";
  message: string;
  revision: number;
  cached?: boolean;
  elapsedMs?: number;
};
export type EffectHandler = (
  name: string,
  args: Record<string, unknown>,
  callId: string,
  signal: AbortSignal,
) => Promise<CommandResult & { takeId?: string; status?: string }>;
type Output = CommandResult & {
  scene: SceneState;
  takeId?: string;
  status?: string;
};
type Entry = { fingerprint: string; output?: Output; owner: string };
export type ToolScope = {
  signal: AbortSignal;
  active: () => boolean;
  send: (event: unknown) => void;
  continueResponse: () => void;
};
type Call = {
  receivedAt: number;
  call_id: string;
  name: string;
  arguments: string;
  entry?: Entry;
  conflict?: boolean;
};
export class ToolBridge {
  private cache = new Map<string, Entry>();
  private responses = new Set<string>();
  private tail = Promise.resolve();
  constructor(
    private deps: {
      getScene: () => SceneState;
      effect?: EffectHandler;
      execute: (
        command: Command,
        signal: AbortSignal,
      ) => Promise<CommandResult>;
      log: (entry: ToolLog) => void;
    },
  ) {}
  private output(code: string, message: string): Output {
    return {
      ok: false,
      code,
      message,
      revision: this.deps.getScene().revision,
      scene: structuredClone(this.deps.getScene()),
    };
  }
  handleDone(event: unknown, scope: ToolScope): Promise<void> {
    const value = event as {
      type?: string;
      response?: { id?: string; status?: string; output?: unknown[] };
    };
    if (
      value?.type !== "response.done" ||
      value.response?.status !== "completed" ||
      !value.response.id ||
      !Array.isArray(value.response.output)
    )
      return Promise.resolve();
    const id = value.response.id;
    if (this.responses.has(id) || this.responses.size >= 2048)
      return Promise.resolve();
    this.responses.add(id);

    const calls: Call[] = [];
    for (const raw of value.response.output) {
      const item = raw as {
        type?: string;
        executor?: string;
        call_id?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (
        item?.type !== "function_call" ||
        item.executor === "server" ||
        typeof item.call_id !== "string" ||
        !item.call_id ||
        item.call_id.length > 160 ||
        typeof item.name !== "string" ||
        item.name.length > 80
      )
        continue;
      const call: Call = {
        receivedAt: performance.now(),
        call_id: item.call_id,
        name: item.name,
        arguments:
          typeof item.arguments === "string" && item.arguments.length <= 20000
            ? item.arguments
            : "",
      };
      const fingerprint = JSON.stringify([call.name, call.arguments]);
      const existing = this.cache.get(call.call_id);
      if (existing) {
        call.entry = existing;
        call.conflict = existing.fingerprint !== fingerprint;
      } else if (this.cache.size < 512) {
        call.entry = { fingerprint, owner: id };
        this.cache.set(call.call_id, call.entry);
      }
      calls.push(call);
    }
    if (!calls.length) return Promise.resolve();
    const task = this.tail.then(() => this.run(calls, id, scope));
    this.tail = task.catch(() => {});
    return task;
  }
  private async run(calls: Call[], id: string, scope: ToolScope) {
    const fresh = calls.filter(
      (c) => c.entry?.owner === id && !c.entry.output && !c.conflict,
    );
    // A provider repeating a call inside one response must not apply it twice.
    const unique = [...new Map(fresh.map((c) => [c.call_id, c])).values()];
    const commands: SingleCommand[] = [];
    const effects: { call: Call; args: Record<string, unknown> }[] = [];
    let invalid: Output | undefined;
    for (const call of unique) {
      try {
        if (call.arguments.length > 20000) throw new Error("INVALID_ARGUMENTS");
        if (this.deps.effect && Object.hasOwn(effectSchemas, call.name)) {
          const args = effectSchemas[
            call.name as keyof typeof effectSchemas
          ].parse(JSON.parse(call.arguments));
          effects.push({ call, args });
          continue;
        }
        const command = commandFromTool(call.name, JSON.parse(call.arguments));
        if (command)
          commands.push(
            ...(command.type === "batch" ? command.commands : [command]),
          );
      } catch (error) {
        invalid = this.output(
          error instanceof Error && error.message === "UNKNOWN_TOOL"
            ? "UNKNOWN_TOOL"
            : "INVALID_ARGUMENTS",
          "工具名称或完整参数无效，整组未执行。",
        );
      }
    }
    if (calls.some((c) => c.conflict || !c.entry))
      invalid = this.output(
        "CALL_ID_CONFLICT",
        "工具调用 ID 冲突或缓存已满，整组未执行。",
      );
    if (effects.length && (effects.length !== 1 || unique.length !== 1))
      invalid = this.output(
        "MIXED_EFFECTS",
        "表演与重拍须单独提交；请先完成片场调整，整组未执行。",
      );
    let result: Output;
    if (!scope.active() || scope.signal.aborted)
      result = this.output("CANCELLED", "连接已变化，旧工具调用未执行。");
    else if (invalid) result = invalid;
    else if (effects.length) {
      const { call, args } = effects[0];
      this.deps.log({
        callId: call.call_id,
        name: call.name,
        arguments: call.arguments,
        status: "working",
        message: "正在保存 Take…",
        revision: this.deps.getScene().revision,
      });
      try {
        result = {
          ...(await this.deps.effect!(
            call.name,
            args,
            call.call_id,
            scope.signal,
          )),
          scene: structuredClone(this.deps.getScene()),
        };
      } catch {
        result = this.output(
          "PERFORMANCE_ERROR",
          "表演调用未确认；请检查历史，勿自动重试。",
        );
      }
    } else if (commands.length) {
      unique.forEach((call) =>
        this.deps.log({
          callId: call.call_id,
          name: call.name,
          arguments: call.arguments,
          status: "working",
          message: "正在执行…",
          revision: this.deps.getScene().revision,
        }),
      );
      try {
        const applied = await this.deps.execute(
          commands.length === 1 ? commands[0] : { type: "batch", commands },
          scope.signal,
        );
        result = { ...applied, scene: structuredClone(this.deps.getScene()) };
      } catch {
        result = this.output(
          "EXECUTION_FAILED",
          "场景操作未完成，请检查当前状态。",
        );
      }
    } else
      result = {
        ok: true,
        revision: this.deps.getScene().revision,
        message: "当前场景已读取。",
        notices: [],
        scene: structuredClone(this.deps.getScene()),
      };
    for (const call of unique) call.entry!.output = result;
    if (!scope.active() || scope.signal.aborted) return;
    const sent = new Set<string>();
    for (const call of calls) {
      if (sent.has(call.call_id)) continue;
      sent.add(call.call_id);
      const output = call.conflict
        ? this.output(
            "CALL_ID_CONFLICT",
            "同一调用 ID 的参数发生变化，已拒绝。",
          )
        : call.entry?.output ||
          this.output("DEDUP_LIMIT", "当前会话的去重缓存已满，请重开片场。");
      this.deps.log({
        callId: call.call_id,
        name: call.name,
        arguments: call.arguments,
        status: output.ok ? "success" : "error",
        message: output.ok
          ? [output.message, ...output.notices].join(" ")
          : output.message,
        revision: output.revision,
        cached: call.entry?.owner !== id,
        elapsedMs: Math.round(performance.now() - call.receivedAt),
      });
      scope.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output),
        },
      });
    }
    scope.continueResponse();
  }
}
