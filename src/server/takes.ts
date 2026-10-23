import { storeArchive, archivedContent, type ArchiveInfo } from "./archive";
import { recordMetric } from "./metrics";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ApiError,
  type BosonClient,
  VideoIdSchema,
  AvatarSchema,
} from "./boson";
import { initialScene } from "@/domain/scene";
import { z } from "zod";
import { client } from "./http";
import {
  appearanceKey,
  CreateTakeSchema,
  RetakeSchema,
  type Take,
  type TakeInput,
} from "@/domain/take";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
type Provider = Pick<BosonClient, "createVideo" | "video" | "content">;
type Row = { record: string; fingerprint: string };
export class TakeService {
  readonly db: DatabaseSync;
  private polls = new Map<string, Promise<Take>>();
  private archives = new Map<string, Promise<Take>>();
  private archiveDir: string | undefined;
  private nextPoll = new Map<string, number>();
  constructor(
    filename: string,
    private provider: Provider,
    archiveDir?: string,
  ) {
    this.archiveDir =
      archiveDir ||
      (filename === ":memory:"
        ? undefined
        : path.join(path.dirname(filename), "media"));
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS takes (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
        video_id TEXT UNIQUE, active INTEGER UNIQUE, record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portraits (hash TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
    // Boot occurs once per process. A previous process may have paid without saving the ID.
    for (const t of this.list())
      if (t.status === "submitting")
        this.save({
          ...t,
          status: "submission_unknown",
          error:
            "服务重启前提交未确认；请到 Boson 核实任务后关联 ID，禁止自动重试。",
        });
  }
  list(): Take[] {
    return (
      this.db
        .prepare("SELECT record FROM takes ORDER BY rowid DESC")
        .all() as unknown as Row[]
    ).map((r) => JSON.parse(r.record));
  }
  get(id: string): Take {
    const row = this.db
      .prepare("SELECT record FROM takes WHERE id=?")
      .get(id) as unknown as Row | undefined;
    if (!row) throw new ApiError("TAKE_NOT_FOUND", "Take 不存在。", 404);
    return JSON.parse(row.record);
  }
  private save(t: Take) {
    if (t.status === "completed" && this.get(t.id).status !== "completed") {
      t = { ...t, completedAt: new Date().toISOString() };
      recordMetric({
        operation: "avatar_total",
        durationMs: Date.now() - Date.parse(t.createdAt),
        outcome: "ok",
      });
    }
    const active = [
      "submitting",
      "queued",
      "in_progress",
      "submission_unknown",
    ].includes(t.status)
      ? 1
      : null;
    this.db
      .prepare("UPDATE takes SET video_id=?,active=?,record=? WHERE id=?")
      .run(t.videoId, active, JSON.stringify(t), t.id);
    return t;
  }
  portrait(id: string) {
    const t = this.get(id);
    const row = this.db
      .prepare("SELECT data FROM portraits WHERE hash=?")
      .get(t.input.reference.hash) as { data: string } | undefined;
    if (!row)
      throw new ApiError(
        "REFERENCE_MISSING",
        "参考人像文件缺失，请检查本地数据备份。",
        409,
      );
    return row.data;
  }
  private existing(requestId: string, fingerprint: string) {
    const row = this.db
      .prepare("SELECT record,fingerprint FROM takes WHERE request_id=?")
      .get(requestId) as unknown as Row | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint)
      throw new ApiError(
        "REQUEST_CONFLICT",
        "相同 requestId 的输入发生变化。",
        409,
      );
    return JSON.parse(row.record) as Take;
  }
  async create(raw: unknown): Promise<Take> {
    const v = CreateTakeSchema.parse(raw);
    const bytes = Buffer.from(v.portrait.split(",")[1], "base64");
    if (
      bytes.length < 32 ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== 640 ||
      bytes.readUInt32BE(20) !== 640
    )
      throw new ApiError(
        "INVALID_PORTRAIT",
        "需要 640×640 PNG 正面人像，请重新捕获。",
        400,
      );
    const input: TakeInput = {
      scene: structuredClone(v.scene),
      emotion: v.scene.performance.emotion,
      voice: "default",
      model: "higgs-avatar",
      ttsModel: "higgs-tts-3",
      size: "640x640",
      reference: {
        hash: hash(v.portrait),
        version: "portrait-v1",
        mode: "captured",
        appearanceKey: appearanceKey(v.scene),
      },
    };
    return this.submit(
      v.requestId,
      null,
      input,
      v.portrait,
      hash(JSON.stringify(v)),
    );
  }
  async legacy(raw: z.infer<typeof AvatarSchema>) {
    const value = AvatarSchema.parse(raw);
    const scene = initialScene();
    scene.performance = {
      dialogue: value.input_tts?.text || "[Lab audio diagnostic]",
      emotion: value.input_tts?.emotion || "neutral",
    };
    const input: TakeInput = {
      scene,
      emotion: scene.performance.emotion,
      voice: "default",
      model: "higgs-avatar",
      ttsModel: "higgs-tts-3",
      size: "640x640",
      diagnostic: value,
      reference: {
        hash: hash(value.ref_image),
        version: "portrait-v1",
        mode: "diagnostic",
        appearanceKey: "",
      },
    };
    const take = await this.submit(
      "lab:" + randomUUID(),
      null,
      input,
      value.ref_image,
      hash(JSON.stringify(value)),
    );
    if (take.status === "failed" || take.status === "submission_unknown")
      throw new ApiError(
        take.status === "submission_unknown"
          ? "SUBMISSION_UNKNOWN"
          : "DIAGNOSTIC_FAILED",
        take.error || "诊断失败",
        take.status === "submission_unknown" ? 504 : 502,
      );
    return {
      id: take.videoId!,
      status: take.status,
      progress: take.progress ?? undefined,
      error: take.error,
    };
  }
  async retake(raw: unknown) {
    const v = RetakeSchema.parse(raw);
    const fingerprint = hash(JSON.stringify(v));
    const old = this.existing(v.requestId, fingerprint);
    if (old) return old;
    const base = this.get(v.baseTakeId);
    if (base.input.diagnostic)
      throw new ApiError(
        "DIAGNOSTIC_TAKE",
        "Lab 诊断未同步片场；请从主页 Action 创建可重拍的 Take。",
        409,
      );
    const input = structuredClone(base.input);
    // The frozen scene is deliberately unchanged; effective TTS emotion is a separate input.
    input.emotion = v.overrides.emotion;
    return this.submit(
      v.requestId,
      base.id,
      input,
      this.portrait(base.id),
      fingerprint,
    );
  }
  private async submit(
    requestId: string,
    baseTakeId: string | null,
    input: TakeInput,
    portrait: string,
    fingerprint: string,
  ) {
    const existing = this.existing(requestId, fingerprint);
    if (existing) return existing;
    const { emotion: _emotion, ...invariant } = input;
    const t: Take = {
      id: randomUUID(),
      requestId,
      baseTakeId,
      createdAt: new Date().toISOString(),
      status: "submitting",
      videoId: null,
      progress: null,
      error: null,
      input,
      inputHash: hash(JSON.stringify(input)),
      invariantHash: hash(JSON.stringify(invariant)),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const again = this.existing(requestId, fingerprint);
      if (again) {
        this.db.exec("COMMIT");
        return again;
      }
      if (this.db.prepare("SELECT id FROM takes WHERE active=1").get())
        throw new ApiError(
          "TAKE_BUSY",
          "已有生成任务或提交结果未知；请先查询或核实该任务。",
          409,
        );
      this.db
        .prepare("INSERT OR IGNORE INTO portraits(hash,data) VALUES(?,?)")
        .run(input.reference.hash, portrait);
      this.db
        .prepare(
          "INSERT INTO takes(id,request_id,fingerprint,active,record) VALUES(?,?,?,1,?)",
        )
        .run(t.id, requestId, fingerprint, JSON.stringify(t));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    try {
      const job = await this.provider.createVideo(
        input.diagnostic || {
          ref_image: portrait,
          input_tts: {
            text: input.scene.performance.dialogue,
            emotion: input.emotion,
          },
          size: input.size,
        },
      );
      return this.save({
        ...t,
        videoId: job.id,
        status: job.status,
        progress: job.progress ?? null,
        error: job.error ?? null,
      });
    } catch (error) {
      const known = error instanceof ApiError ? error : null;
      const definite =
        known &&
        [
          "NOT_CONFIGURED",
          "UPSTREAM_AUTH",
          "RATE_LIMITED",
          "NOT_FOUND",
          "UPSTREAM_REJECTED",
        ].includes(known.code);
      const saved = this.save({
        ...t,
        status: definite ? "failed" : "submission_unknown",
        error: definite
          ? known.message
          : "提交结果未知，上游可能已接收。请核实 Boson 任务并关联 ID，勿重复生成。",
      });
      if (input.diagnostic && definite) throw known;
      return saved;
    }
  }
  refresh(id: string): Promise<Take> {
    const t = this.get(id);
    if (
      !t.videoId ||
      ["completed", "failed"].includes(t.status) ||
      Date.now() < (this.nextPoll.get(id) || 0)
    )
      return Promise.resolve(t);
    const pending = this.polls.get(id);
    if (pending) return pending;
    const poll = this.provider
      .video(t.videoId)
      .then((job) => {
        this.nextPoll.set(id, Date.now() + 2000);
        return this.save({
          ...this.get(id),
          status: job.status,
          progress: job.progress ?? null,
          error: job.error ?? null,
        });
      })
      .catch((error) => {
        const raw = error instanceof ApiError ? error.retryAfter : undefined;
        const retry = raw
          ? Number.isFinite(Number(raw))
            ? Number(raw) * 1000
            : Date.parse(raw) - Date.now()
          : 5000;
        this.nextPoll.set(
          id,
          Date.now() + Math.max(2000, Number.isFinite(retry) ? retry : 5000),
        );
        throw error; // Network/429/404 never turns a running task into a failed one.
      })
      .finally(() => this.polls.delete(id));
    this.polls.set(id, poll);
    return poll;
  }
  async reconcile(id: string, videoId: string) {
    const t = this.get(id);
    if (t.status !== "submission_unknown")
      throw new ApiError("NOT_UNKNOWN", "只能关联提交结果未知的 Take。", 409);
    const job = await this.provider.video(VideoIdSchema.parse(videoId));
    if (this.db.prepare("SELECT id FROM takes WHERE video_id=?").get(job.id))
      throw new ApiError("VIDEO_CONFLICT", "此视频已关联其他 Take。", 409);
    return this.save({
      ...t,
      videoId: job.id,
      status: job.status,
      progress: job.progress ?? null,
      error: job.error ?? null,
    });
  }
  async video(id: string) {
    const row = this.db
      .prepare("SELECT record FROM takes WHERE video_id=?")
      .get(id) as unknown as Row | undefined;
    if (!row) return this.provider.video(id);
    const t = await this.refresh((JSON.parse(row.record) as Take).id);
    return {
      id: t.videoId!,
      status: t.status,
      progress: t.progress ?? undefined,
      error: t.error,
    };
  }
  resolveNotAccepted(id: string) {
    const t = this.get(id);
    if (t.status !== "submission_unknown")
      throw new ApiError("NOT_UNKNOWN", "只能处理提交结果未知的记录。", 409);
    return this.save({
      ...t,
      status: "failed",
      error:
        "用户已在 Boson 核实该提交未被接收；解除本地生成锁。此操作未取消任何云端任务。",
    });
  }
  async importArchive(
    id: string,
    stream: ReadableStream<Uint8Array>,
    source: ArchiveInfo["source"],
  ) {
    const t = this.get(id);
    if (t.status !== "completed" || !this.archiveDir)
      throw new ApiError("NOT_READY", "任务未完成或本地归档目录不可用。", 409);
    const archive = await storeArchive(this.archiveDir, id, stream, source);
    return this.save({ ...this.get(id), archive });
  }
  archive(id: string): Promise<Take> {
    const existing = this.archives.get(id);
    if (existing) return existing;
    const t = this.get(id);
    if (t.status !== "completed" || !t.videoId)
      throw new ApiError("NOT_READY", "完成后才能归档。", 409);
    const p = this.provider
      .content(t.videoId)
      .then((r) => {
        if (!r.body) throw new ApiError("INVALID_MEDIA", "视频内容为空。");
        return this.importArchive(id, r.body, "provider");
      })
      .finally(() => this.archives.delete(id));
    this.archives.set(id, p);
    return p;
  }
  async content(id: string, range?: string) {
    const t = this.get(id);
    if (t.status !== "completed" || !t.videoId)
      throw new ApiError("NOT_READY", "此 Take 尚无可播放视频。", 409);
    if (t.archive && this.archiveDir)
      return archivedContent(this.archiveDir, id, t.archive, range);
    return this.provider.content(t.videoId, range);
  }
}
const globalService = globalThis as unknown as { directorTakes?: TakeService };
export function takes() {
  if (!globalService.directorTakes) {
    const dir = path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      process.env.BOSON_DATA_DIR || ".data",
    );
    mkdirSync(dir, { recursive: true });
    globalService.directorTakes = new TakeService(
      path.join(dir, "takes.sqlite"),
      {
        createVideo: (v) => client().createVideo(v),
        video: (id) => client().video(id),
        content: (id, range) => client().content(id, range),
      },
    );
  }
  return globalService.directorTakes;
}
