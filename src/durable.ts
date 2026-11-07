import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, defineDocFamily, LiveDoc, type Conversation, type ConversationId, type Harness, type LiveState, type SubmissionId } from "@earendil-works/pi-durable";
import { AgentCard, Artifact, Message, Role, StreamResponse, Task, TaskState, type SendMessageRequest, type GetTaskRequest, type ListTasksRequest, type ListTasksResponse, type CancelTaskRequest, type SubscribeToTaskRequest, TaskPushNotificationConfig, type GetTaskPushNotificationConfigRequest, type ListTaskPushNotificationConfigsRequest, type DeleteTaskPushNotificationConfigRequest, type ListTaskPushNotificationConfigsResponse } from "@a2a-js/sdk";
import { ContentTypeNotSupportedError, PushNotificationNotSupportedError, RequestMalformedError, TaskNotCancelableError, TaskNotFoundError, UnsupportedOperationError } from "@a2a-js/sdk/errors";
import type { A2ARequestHandler, ServerCallContext } from "@a2a-js/sdk/server";
import { interrupted, terminal } from "./client.ts";
import { DurablePush, type PushOptions } from "./push.ts";

/** All adapter metadata is committed by the application's existing storage owner. */
type TaskRecord = { scope: string; conversationId: number; submissionId: number; settledId: number; task: { [key: string]: JsonValue } | null };
const Tasks = defineDocFamily<TaskRecord, null>({ kind: "pi-a2a.task", version: 1, scope: "session", family: true,
  initial: () => ({ scope: "", conversationId: 0, submissionId: 0, settledId: 0, task: null }), checkpointWhen: () => true });
const Messages = defineDocFamily<{ taskId: string; text: string; textSha256?: string; inputSha256?: string; contextId: string }, null>({ kind: "pi-a2a.message", version: 1, scope: "session", family: true,
  initial: () => ({ taskId: "", text: "", contextId: "" }), checkpointWhen: () => true });
const Owners = defineDocFamily<{ ids: string[]; contexts: Record<string, string> }, null>({ kind: "pi-a2a.owner", version: 1, scope: "session", family: true,
  initial: () => ({ ids: [], contexts: {} }), checkpointWhen: () => true });
const Contexts = defineDocFamily<{ scope: string; conversationId: number }, null>({ kind: "pi-a2a.context", version: 1, scope: "session", family: true,
  initial: () => ({ scope: "", conversationId: 0 }), checkpointWhen: () => true });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Chord returns tracked JSON values: SDK metadata can retain their proxies.
// Materialize across the codec boundary before returning or cloning a task.
const materialize = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const decodeTask = (value: unknown) => Task.fromJSON(materialize(value));
const jsonTask = (value: Task) => materialize(Task.toJSON(value)) as { [key: string]: JsonValue };
const now = () => new Date().toISOString();
const textDigest = (text: string) => createHash("sha256").update(text).digest("hex");
const sameText = (receipt: { text: string; textSha256?: string }, text: string) => receipt.textSha256 ? receipt.textSha256 === textDigest(text) : receipt.text === text;
/** Fixed descriptions only: never publish reasoning, arguments, output, or retry diagnostics. */
function progressText(live: LiveState): string {
  if (live.compactions?.some(item => item.blocking)) return "Compacting conversation";
  if (live.generation?.retry) return "Waiting to retry model request";
  if (live.generation?.deferred) return "Waiting for model response";
  if (live.tools?.length) return `Running tools (${live.tools.filter(tool => tool.status === "done").length}/${live.tools.length} complete)`;
  if (live.generation) return `Generating response (turn ${(live.run?.turns ?? 0) + 1}, attempt ${live.generation.attempt})`;
  return "Working";
}
function malformed(message: string): never { throw new RequestMalformedError(message); }
const checkId = (value: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) malformed("An ID must contain 1–128 ASCII ID characters."); };

export interface Identity { userId: string; tenant: string }
export interface DurableA2AOptions {
  harness: Harness;
  card: AgentCard;
  /** Resolve a host-owned conversation. Do not return one private conversation for unrelated users. */
  conversation: (identity: Identity) => Conversation | Promise<Conversation>;
  context?: Context;
  /** Adopt an already admitted input by its old message ID, without resubmitting it. */
  existingSubmission?: (messageId: string, identity: Identity, conversation: Conversation) => Promise<{ submissionId: SubmissionId; textSha256: string } | undefined>;
  /** Application-defined interruption, never guessed from model prose. Defaults to COMPLETED. */
  classifyAnswer?: (answer: string) => TaskState;
  pollIntervalMs?: number;
  /** Accept bounded inline JPEG/PNG parts. Defaults to false. */
  images?: boolean;
  /** Read-only, host-owned URL artifacts from a committed completed task, including retained tasks. */
  fileArtifacts?: (task: Readonly<Task>) => Promise<Artifact[]>;
  /** Explicit callback trust. The host starts/stops the pump with its existing owner. */
  push?: PushOptions;
}

/** A2A 1.0 request handler; the official SDK supplies the transport and wire codecs. */
export class DurableA2A implements A2ARequestHandler {
  readonly context: Context;
  private readonly push?: DurablePush;
  startPush(): void { this.push?.start(); }
  async close(): Promise<void> { await this.push?.close(); }
  async flushPush(): Promise<void> { await this.push?.flush(); }
  constructor(readonly options: DurableA2AOptions) {
    this.context = options.context ?? BACKGROUND_CONTEXT;
    if (options.card.capabilities?.extendedAgentCard || options.card.capabilities?.extensions.length) throw new Error("This adapter does not implement extended cards or protocol extensions.");
    if (Boolean(options.card.capabilities?.pushNotifications) !== Boolean(options.push)) throw new Error("Push capability requires explicit callback trust and lifecycle configuration.");
    if (options.push) this.push = new DurablePush(options.harness, this.context, options.push, (id, scope) => this.refresh(id, scope));
    const allowedInputs = options.images ? ["text/plain", "image/jpeg", "image/png"] : ["text/plain"];
    const allowedOutputs = options.fileArtifacts ? options.card.defaultOutputModes : ["text/plain"];
    if (!options.card.defaultInputModes.length || !options.card.defaultOutputModes.includes("text/plain") ||
        options.card.defaultInputModes.some(mode => !allowedInputs.includes(mode)) || options.card.defaultOutputModes.some(mode => !mode || !allowedOutputs.includes(mode)) ||
        options.card.skills.some(skill => [...skill.inputModes].some(mode => !allowedInputs.includes(mode)) || [...skill.outputModes].some(mode => !allowedOutputs.includes(mode)))) throw new Error("Advertise only supported input modes and text/plain output modes unless fileArtifacts is configured.");
    if ((options.pollIntervalMs ?? 250) < 1) throw new Error("pollIntervalMs must be positive.");
  }
  async getAgentCard(): Promise<AgentCard> { return structuredClone(this.options.card); }
  async getAuthenticatedExtendedAgentCard(): Promise<AgentCard> { throw new UnsupportedOperationError(); }

  private identity(context: ServerCallContext, tenant = ""): { identity: Identity; scope: string } {
    if (!context.user?.isAuthenticated || !context.user.userName) throw new RequestMalformedError("An authenticated identity is required.");
    if (tenant !== (context.tenant ?? "")) malformed("The requested tenant does not match the authenticated call context.");
    const identity = { userId: context.user.userName, tenant };
    return { identity, scope: hash(identity) };
  }
  private async adoptExisting(id: string, identity: Identity, scope: string): Promise<void> {
    checkId(id);
    if (!this.options.existingSubmission || (await this.options.harness.snapshot(Tasks, id, this.context))?.task) return;
    const key = hash([scope, id]);
    if ((await this.options.harness.snapshot(Messages, key, this.context))?.taskId) return;
    const conversation = await this.options.conversation(identity);
    const existing = await this.options.existingSubmission(id, identity, conversation);
    if (!existing) return;
    if (!/^[a-f0-9]{64}$/.test(existing.textSha256)) malformed("Existing input needs its SHA-256 text digest.");
    const handle = await this.options.harness.submission(existing.submissionId, this.context);
    const submission = await handle?.status(this.context);
    if (!submission || submission.type !== "input" || submission.conversationId !== conversation.id) malformed("Existing submission does not belong to this conversation.");
    await this.options.harness.commit(async tx => {
      const receipt = await tx.doc(Messages, key, null);
      const record = await tx.doc(Tasks, id, null);
      if (receipt.taskId || record.task) {
        if (receipt.taskId !== id || record.scope !== scope || record.submissionId !== existing.submissionId || receipt.textSha256 !== existing.textSha256) malformed("Existing submission binding conflicts.");
        return;
      }
      const owner = await tx.doc(Owners, scope, null);
      const contextId = owner.contexts[String(conversation.id)] || randomUUID();
      const binding = await tx.doc(Contexts, contextId, null);
      if (binding.scope && (binding.scope !== scope || binding.conversationId !== conversation.id)) malformed("Context ownership changed.");
      const task = Task.fromJSON({ id, contextId, metadata: { messageId: id, imported: true }, status: { state: "TASK_STATE_SUBMITTED", timestamp: now() } });
      record.scope = scope; record.conversationId = conversation.id; record.submissionId = existing.submissionId; record.settledId = 0; record.task = jsonTask(task);
      receipt.taskId = id; receipt.textSha256 = existing.textSha256; receipt.contextId = contextId;
      binding.scope = scope; binding.conversationId = conversation.id;
      owner.contexts[String(conversation.id)] = contextId;
      if (!owner.ids.includes(id)) owner.ids.push(id);
    }, this.context);
  }
  private async record(id: string, scope: string) {
    checkId(id);
    const record = await this.options.harness.snapshot(Tasks, id, this.context);
    if (!record?.task || record.scope !== scope) throw new TaskNotFoundError();
    return materialize(record) as TaskRecord;
  }
  private validateHistory(length?: number): void {
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 0)) malformed("historyLength must be a nonnegative integer.");
  }
  private history(task: Task, length?: number): Task {
    this.validateHistory(length);
    const result = decodeTask(jsonTask(task));
    result.history = length === 0 ? [] : result.history.slice(-Math.min(length ?? 50, 50));
    return result;
  }
  private async refresh(id: string, scope: string): Promise<Task> {
    const task = await this.refreshStored(id, scope);
    if (!this.options.fileArtifacts || task.status?.state !== TaskState.TASK_STATE_COMPLETED) return task;
    const extra = await this.options.fileArtifacts(decodeTask(jsonTask(task)));
    if (!Array.isArray(extra) || extra.length > 4 || Buffer.byteLength(JSON.stringify(extra)) > 65_536)
      throw new Error("Host file artifacts exceed the supported metadata bound.");
    const origins = new Set(this.options.card.supportedInterfaces.map(item => new URL(item.url).origin));
    const ids = new Set(task.artifacts.map(item => item.artifactId));
    for (const artifact of extra) {
      checkId(artifact.artifactId);
      if (ids.has(artifact.artifactId) || !artifact.parts.length || artifact.parts.length > 4) throw new Error("Host file artifact identity or parts are invalid.");
      ids.add(artifact.artifactId);
      for (const part of artifact.parts) {
        if (part.content?.$case !== "url" || !this.options.card.defaultOutputModes.includes(part.mediaType))
          throw new Error("Host file artifacts require an advertised URL media type.");
        const url = new URL(part.content.value);
        if (!origins.has(url.origin) || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
          throw new Error("Host file artifacts must use a credential-free agent origin.");
      }
    }
    return { ...task, artifacts: [...task.artifacts, ...extra.map(value => Artifact.fromJSON(Artifact.toJSON(value)))] };
  }
  private async refreshStored(id: string, scope: string): Promise<Task> {
    const record = await this.record(id, scope);
    const task = decodeTask(record.task);
    if (record.settledId === record.submissionId) return task;
    const submission = await this.options.harness.submission(record.submissionId as SubmissionId, this.context);
    if (!submission) throw new Error("Missing persisted submission.");
    const status = await submission.status(this.context);
    let state = TaskState.TASK_STATE_SUBMITTED;
    let answer: string | undefined;
    if (status.status === "done" && status.type === "input") {
      const entry = await this.options.harness.commit(tx => tx.entry(AssistantEntry, status.answer), this.context);
      const message = entry?.model?.[0];
      if (message?.role !== "assistant") throw new Error("Missing committed final answer.");
      const blocks = message.content.flatMap(block => {
        if (block.type !== "text") return [];
        let phase: string | undefined;
        try { phase = block.textSignature ? JSON.parse(block.textSignature).phase : undefined; } catch { /* Other providers use opaque signatures. */ }
        return [{ text: block.text, phase }];
      });
      const phased = blocks.some(block => block.phase !== undefined);
      answer = blocks.filter(block => !phased || block.phase === "final_answer").map(block => block.text).join("\n");
      state = this.options.classifyAnswer?.(answer) ?? TaskState.TASK_STATE_COMPLETED;
      if (![TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_INPUT_REQUIRED, TaskState.TASK_STATE_AUTH_REQUIRED, TaskState.TASK_STATE_REJECTED].includes(state)) throw new Error("Invalid answer classification.");
      if (!answer.trim()) { answer = undefined; state = TaskState.TASK_STATE_FAILED; }
    } else if (status.status === "unanswered") {
      state = status.reason === "aborted" || status.reason === "withdrawn" ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_FAILED;
    }
    return this.options.harness.commit(async tx => {
      const current = await tx.doc(Tasks, id, null);
      if (!current.task) throw new TaskNotFoundError();
      const value = decodeTask(current.task);
      // A sibling poll or a follow-up may have advanced this task while the status was read.
      if (current.submissionId !== record.submissionId || current.settledId === record.submissionId) return value;
      const settled = status.status === "done" || status.status === "unanswered";
      let progress: string | undefined;
      if (!settled) {
        // Read on the commit line: deriving a retained status must also store any deferred live changes.
        const live = await tx.doc(LiveDoc, record.conversationId as ConversationId);
        if (live.run?.inputs.includes(submission.id)) {
          state = TaskState.TASK_STATE_WORKING;
          progress = progressText(live);
        } else progress = "Queued";
      }
      const previous = value.status?.message?.parts.map(part => part.content?.$case === "text" ? part.content.value : "").join("\n");
      if (value.status?.state !== state || previous !== progress || settled) {
        value.status = { state, timestamp: now(), message: progress === undefined ? undefined : Message.fromJSON({
          messageId: randomUUID(), contextId: value.contextId, taskId: id, role: "ROLE_AGENT", parts: [{ text: progress, mediaType: "text/plain" }],
        }) };
        if (answer !== undefined) {
          const reply = Message.fromJSON({ messageId: `answer-${submission.id}`, contextId: value.contextId, taskId: id, role: "ROLE_AGENT", parts: [{ text: answer, mediaType: "text/plain" }] });
          value.history = [...value.history, reply].slice(-50);
          value.artifacts = [{ artifactId: "answer", name: "answer", description: "Final text from the committed Durable submission", parts: reply.parts, extensions: [], metadata: undefined }];
          value.status.message = reply;
        }
        current.task = jsonTask(value);
      }
      if (settled) current.settledId = record.submissionId;
      return value;
    }, this.context);
  }

  private async admit(params: SendMessageRequest, context: ServerCallContext): Promise<string> {
    this.validateHistory(params.configuration?.historyLength);
    const { identity, scope } = this.identity(context, params.tenant);
    const message = params.message;
    if (!message || message.role !== Role.ROLE_USER || !message.parts.length) malformed("Send a user message with text parts.");
    checkId(message.messageId);
    const textParts: string[] = [];
    const images: { data: Buffer; mimeType: "image/jpeg" | "image/png" }[] = [];
    let imageBytes = 0;
    for (const part of message.parts) {
      if (part.content?.$case === "text" && (!part.mediaType || part.mediaType === "text/plain")) { textParts.push(part.content.value); continue; }
      if (!this.options.images || part.content?.$case !== "raw" || (part.mediaType !== "image/jpeg" && part.mediaType !== "image/png")) throw new ContentTypeNotSupportedError();
      const data = part.content.value;
      const jpeg = part.mediaType === "image/jpeg";
      if (!Buffer.isBuffer(data) || data.length === 0 || data.length > 1_048_576 || (jpeg ? !(data[0] === 0xff && data[1] === 0xd8 && data.at(-2) === 0xff && data.at(-1) === 0xd9) : !(data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))))) malformed("Invalid or oversized inline image.");
      imageBytes += data.length;
      if (images.length >= 4 || imageBytes > 4 * 1_048_576) malformed("Too many or oversized inline images.");
      images.push({ data: Buffer.from(data), mimeType: part.mediaType });
    }
    const text = textParts.join("\n");
    if (Buffer.byteLength(text) > 8192 || (!text.trim() && images.length === 0)) malformed("Provide text of at most 8192 UTF-8 bytes or at least one image.");
    const inputSha256 = createHash("sha256").update(JSON.stringify([text, images.map(image => [image.mimeType, image.data.toString("base64")]), message.contextId ?? null, message.taskId ?? null])).digest("hex");
    const requestedPush = params.configuration?.taskPushNotificationConfig;
    let pushConfig: TaskPushNotificationConfig | undefined;
    if (requestedPush) {
      if (!this.push) throw new PushNotificationNotSupportedError();
      pushConfig = this.push.validate({ ...requestedPush, id: requestedPush.id || hash(message.messageId) });
      if (requestedPush.taskId && requestedPush.taskId !== message.taskId || requestedPush.tenant && requestedPush.tenant !== params.tenant) malformed("Push configuration association does not match the message.");
    }
    if (params.configuration?.acceptedOutputModes.length && !params.configuration.acceptedOutputModes.includes("text/plain")) throw new ContentTypeNotSupportedError();
    if (message.extensions.length || message.referenceTaskIds.length) throw new UnsupportedOperationError("Protocol extensions and referenceTaskIds are not implemented by this text adapter.");
    await this.adoptExisting(message.messageId, identity, scope);
    if (message.taskId) await this.adoptExisting(message.taskId, identity, scope);
    const key = hash([scope, message.messageId]);
    const existing = await this.options.harness.snapshot(Messages, key, this.context);
    if (existing?.taskId) {
      if ((existing.inputSha256 ? existing.inputSha256 !== inputSha256 : images.length > 0 || !sameText(existing, text)) || (message.contextId && message.contextId !== existing.contextId) || (message.taskId && message.taskId !== existing.taskId)) malformed("This message ID already belongs to another message.");
      return existing.taskId;
    }
    let task: Task | undefined;
    if (message.taskId) {
      task = await this.refresh(message.taskId, scope);
      if (terminal(task)) throw new UnsupportedOperationError("A terminal task cannot receive a new message; use its contextId to start another task.");
      if (!interrupted(task)) throw new UnsupportedOperationError("This task is working. Start a separate task in its context or wait for it.");
      if (message.contextId && message.contextId !== task.contextId) malformed("taskId and contextId do not match.");
    }
    const requestedContext = task?.contextId || message.contextId;
    let conversation: Conversation;
    if (requestedContext) {
      checkId(requestedContext);
      const binding = await this.options.harness.snapshot(Contexts, requestedContext, this.context);
      if (!binding?.conversationId || binding.scope !== scope) throw new TaskNotFoundError();
      const found = await this.options.harness.conversation(binding.conversationId as ConversationId, this.context);
      if (!found) throw new TaskNotFoundError();
      conversation = found;
    } else conversation = await this.options.conversation(identity);
    const proposedTaskId = task?.id ?? randomUUID();
    return this.options.harness.commit(async tx => {
      const receipt = await tx.doc(Messages, key, null);
      if (receipt.taskId) {
        if ((receipt.inputSha256 ? receipt.inputSha256 !== inputSha256 : images.length > 0 || !sameText(receipt, text)) || (message.contextId && receipt.contextId !== message.contextId) || (message.taskId && receipt.taskId !== message.taskId)) malformed("This message ID already belongs to another message.");
        return receipt.taskId;
      }
      const owner = await tx.doc(Owners, scope, null);
      const contextId = requestedContext || owner.contexts[String(conversation.id)] || randomUUID();
      const binding = await tx.doc(Contexts, contextId, null);
      if (binding.scope && (binding.scope !== scope || binding.conversationId !== conversation.id)) malformed("Context ownership changed.");
      const record = await tx.doc(Tasks, proposedTaskId, null);
      if (task && record.task && !interrupted(decodeTask(record.task))) throw new UnsupportedOperationError("The task is no longer awaiting input.");
      const content = images.length ? [...(text ? [{ type: "text" as const, text }] : []), ...images.map(image => ({ type: "image" as const, data: image.data.toString("base64"), mimeType: image.mimeType }))] : text;
      const submissionId = await conversation.submit(tx, { type: "input", content, requestId: `pi-a2a:${key}` });
      const input = Message.fromJSON({ messageId: message.messageId, contextId, taskId: proposedTaskId, role: "ROLE_USER", parts: [...(text ? [{ text, mediaType: "text/plain" }] : []), ...images.map(image => ({ text: `[${image.mimeType} image attached]`, mediaType: "text/plain" }))] });
      const value = decodeTask(record.task ?? { id: proposedTaskId, contextId, metadata: { messageId: message.messageId } });
      value.history = [...value.history, input].slice(-50);
      value.status = { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now(), message: undefined };
      record.scope = scope; record.conversationId = conversation.id; record.submissionId = submissionId; record.settledId = 0; record.task = jsonTask(value);
      receipt.taskId = proposedTaskId; receipt.text = text; receipt.inputSha256 = inputSha256; receipt.contextId = contextId;
      binding.scope = scope; binding.conversationId = conversation.id;
      owner.contexts[String(conversation.id)] = contextId;
      if (!owner.ids.includes(proposedTaskId)) owner.ids.push(proposedTaskId);
      if (pushConfig) await this.requirePush().bind(tx, scope, { ...pushConfig, taskId: proposedTaskId });
      return proposedTaskId;
    }, this.context);
  }

  async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task> {
    const id = await this.admit(params, context);
    const { scope } = this.identity(context, params.tenant);
    if (params.configuration?.taskPushNotificationConfig) await this.requirePush().put(scope, {
      ...params.configuration.taskPushNotificationConfig, id: params.configuration.taskPushNotificationConfig.id || hash(params.message?.messageId), taskId: id,
    });
    let value = await this.refresh(id, scope);
    while (!params.configuration?.returnImmediately && !terminal(value) && !interrupted(value)) {
      await this.pause(context);
      value = await this.refresh(id, scope);
    }
    return this.history(value, params.configuration?.historyLength);
  }
  async getTask(params: GetTaskRequest, context: ServerCallContext): Promise<Task> {
    this.validateHistory(params.historyLength);
    const { identity, scope } = this.identity(context, params.tenant);
    await this.adoptExisting(params.id, identity, scope);
    return this.history(await this.refresh(params.id, scope), params.historyLength);
  }
  async cancelTask(params: CancelTaskRequest, context: ServerCallContext): Promise<Task> {
    const { identity, scope } = this.identity(context, params.tenant);
    await this.adoptExisting(params.id, identity, scope);
    const task = await this.refresh(params.id, scope);
    if (terminal(task) || interrupted(task)) throw new TaskNotCancelableError();
    const record = await this.record(params.id, scope);
    const submission = await this.options.harness.submission(record.submissionId as SubmissionId, this.context);
    // Pi 1.5 offers scoped withdrawal only while queued. Never abort a shared conversation.
    if (!submission || await submission.abort(this.context) !== "aborted") throw new TaskNotCancelableError("This submission has started and cannot be canceled independently of its conversation.");
    return this.refresh(params.id, scope);
  }
  private pause(context: ServerCallContext) {
    const signal = context.state.get("signal");
    return delay(this.options.pollIntervalMs ?? 250, undefined, { signal: signal instanceof AbortSignal ? signal : undefined });
  }
  private async *updates(id: string, context: ServerCallContext, historyLength?: number): AsyncGenerator<StreamResponse> {
    const scope = this.identity(context, context.tenant ?? "").scope;
    let value = await this.refresh(id, scope);
    yield { payload: { $case: "task", value: this.history(value, historyLength) } };
    let stamp = JSON.stringify(Task.toJSON(value));
    while (!terminal(value) && !interrupted(value)) {
      await this.pause(context);
      value = await this.refresh(id, scope);
      const next = JSON.stringify(Task.toJSON(value));
      if (stamp !== next) {
        for (const artifact of value.artifacts) yield { payload: { $case: "artifactUpdate", value: { taskId: id, contextId: value.contextId, artifact, append: false, lastChunk: true, metadata: undefined } } };
        yield { payload: { $case: "statusUpdate", value: { taskId: id, contextId: value.contextId, status: value.status, metadata: undefined } } };
        stamp = next;
      }
    }
  }
  async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    if (!this.options.card.capabilities?.streaming) throw new UnsupportedOperationError();
    const id = await this.admit(params, context);
    if (params.configuration?.taskPushNotificationConfig) await this.requirePush().put(this.identity(context, params.tenant).scope, {
      ...params.configuration.taskPushNotificationConfig, id: params.configuration.taskPushNotificationConfig.id || hash(params.message?.messageId), taskId: id,
    });
    yield* this.updates(id, context, params.configuration?.historyLength);
  }
  async *resubscribe(params: SubscribeToTaskRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
    if (!this.options.card.capabilities?.streaming) throw new UnsupportedOperationError();
    const { identity, scope } = this.identity(context, params.tenant);
    await this.adoptExisting(params.id, identity, scope);
    const task = await this.refresh(params.id, scope);
    if (terminal(task)) throw new UnsupportedOperationError();
    yield* this.updates(params.id, context);
  }
  async listTasks(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    this.validateHistory(params.historyLength);
    if (!Number.isInteger(params.status) || params.status < 0 || params.status > 8) malformed("Invalid task state filter.");
    const { scope } = this.identity(context, params.tenant);
    const pageSize = params.pageSize ?? 50;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) malformed("pageSize must be between 1 and 100.");
    if (params.statusTimestampAfter && !Number.isFinite(Date.parse(params.statusTimestampAfter))) malformed("Invalid status timestamp.");
    const filter = hash([scope, params.contextId, params.status, params.statusTimestampAfter ?? ""]);
    let cursor: { filter: string; timestamp: string; id: string } | undefined;
    if (params.pageToken) {
      try { if (params.pageToken.length > 2048) throw new Error(); cursor = JSON.parse(Buffer.from(params.pageToken, "base64url").toString()); } catch { malformed("Invalid page token."); }
      if (!cursor || cursor.filter !== filter || typeof cursor.timestamp !== "string" || typeof cursor.id !== "string") malformed("Page token does not match this query.");
    }
    const owner = await this.options.harness.snapshot(Owners, scope, this.context);
    const tasks: Task[] = [];
    for (const id of owner?.ids ?? []) {
      const task = await this.refresh(id, scope);
      if (params.contextId && task.contextId !== params.contextId) continue;
      if (params.status && task.status?.state !== params.status) continue;
      if (params.statusTimestampAfter && Date.parse(task.status?.timestamp ?? "") < Date.parse(params.statusTimestampAfter)) continue;
      tasks.push(task);
    }
    const order = (a: Task, b: Task) => (b.status?.timestamp ?? "").localeCompare(a.status?.timestamp ?? "") || b.id.localeCompare(a.id);
    tasks.sort(order);
    const remaining = cursor ? tasks.filter(task => (task.status?.timestamp ?? "") < cursor.timestamp || (task.status?.timestamp === cursor.timestamp && task.id < cursor.id)) : tasks;
    const page = remaining.slice(0, pageSize);
    const last = page.at(-1);
    const nextPageToken = remaining.length > pageSize && last ? Buffer.from(JSON.stringify({ filter, timestamp: last.status?.timestamp ?? "", id: last.id })).toString("base64url") : "";
    return { tasks: page.map(task => { const result = this.history(task, params.historyLength); if (!params.includeArtifacts) result.artifacts = []; return result; }), pageSize, totalSize: tasks.length, nextPageToken };
  }
  private requirePush(): DurablePush {
    if (!this.push) throw new PushNotificationNotSupportedError();
    return this.push;
  }
  async createTaskPushNotificationConfig(params: TaskPushNotificationConfig, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
    return this.requirePush().put(this.identity(context, params.tenant).scope, params);
  }
  async getTaskPushNotificationConfig(params: GetTaskPushNotificationConfigRequest, context: ServerCallContext): Promise<TaskPushNotificationConfig> {
    return this.requirePush().get(this.identity(context, params.tenant).scope, params.taskId, params.id);
  }
  async listTaskPushNotificationConfigs(params: ListTaskPushNotificationConfigsRequest, context: ServerCallContext): Promise<ListTaskPushNotificationConfigsResponse> {
    return this.requirePush().list(this.identity(context, params.tenant).scope, params.taskId, params.pageSize || 50, params.pageToken);
  }
  async deleteTaskPushNotificationConfig(params: DeleteTaskPushNotificationConfigRequest, context: ServerCallContext) {
    return this.requirePush().delete(this.identity(context, params.tenant).scope, params.taskId, params.id);
  }
}

export function createDurableA2A(options: DurableA2AOptions): DurableA2A { return new DurableA2A(options); }
export { createA2ATools } from "./durable-tools.ts";
