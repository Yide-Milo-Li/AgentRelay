import { sqliteTable, text, integer, index, uniqueIndex, primaryKey, check, foreignKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Registered devices. Ids are slugs unique per owner; `name_key` is the normalised name used for lookups.
export const devices = sqliteTable("devices", {
  ownerId: text("owner_id").notNull(), id: text("id").notNull(),
  name: text("name").notNull(), nameKey: text("name_key").notNull(), line: text("line").notNull(),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.ownerId, t.id] }), uniqueIndex("devices_owner_name").on(t.ownerId, t.nameKey)]);

// Browser subscriptions are workspace data; deleting a device also removes its delivery destinations.
export const notificationSubscriptions = sqliteTable("notification_subscriptions", {
  ownerId: text("owner_id").notNull(), browserId: text("browser_id").notNull(),
  deviceId: text("device_id").notNull(), endpoint: text("endpoint").notNull(),
  endpointHash: text("endpoint_hash").notNull(), p256dh: text("p256dh").notNull(), auth: text("auth").notNull(),
  locale: text("locale").notNull().default("en"), disabledAt: integer("disabled_at"),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
  lastAttemptAt: integer("last_attempt_at"), lastAcceptedAt: integer("last_accepted_at"), lastError: text("last_error"),
  // What this browser wants to hear about. Requeues default on and Any-device handoffs off; details are shown unless the person hides them.
  notifyRequeue: integer("notify_requeue", { mode: "boolean" }).notNull().default(true),
  notifyAny: integer("notify_any", { mode: "boolean" }).notNull().default(false),
  showDetails: integer("show_details", { mode: "boolean" }).notNull().default(true),
  // Which agent connections this browser hears about before they expire: none, those of its device (and unbound ones), or all.
  notifyExpiry: text("notify_expiry", { enum: ["off", "device", "all"] }).notNull().default("device"),
  // What this browser hears about handoffs sent from its device: nothing, their completion, or their claim and completion.
  notifyProgress: text("notify_progress", { enum: ["off", "done", "all"] }).notNull().default("done"),
  // Display text only: a short browser label, and the member who enabled it (a name, never a platform id, is shown to others).
  label: text("label"), createdByUserId: text("created_by_user_id"), createdByName: text("created_by_name"),
}, (t) => [primaryKey({ columns: [t.ownerId, t.browserId] }),
  uniqueIndex("notification_subscriptions_owner_endpoint").on(t.ownerId, t.endpointHash),
  index("notification_subscriptions_owner_device").on(t.ownerId, t.deviceId),
  foreignKey({ columns: [t.ownerId, t.deviceId], foreignColumns: [devices.ownerId, devices.id] }).onDelete("cascade")]);

// The workspace's own VAPID key pair, made by the Worker the first time a browser reads the notification settings, so a
// Site can send notifications from its first deployment. Runtime values, when all set, take precedence over this row.
// The private key is a secret: it never leaves the server, and only the public key reaches browsers.
export const pushKeys = sqliteTable("push_keys", {
  ownerId: text("owner_id").primaryKey(), publicKey: text("public_key").notNull(), privateKey: text("private_key").notNull(),
  subject: text("subject").notNull(), createdAt: integer("created_at").notNull(),
});

// Projects that handoffs are filed under. Ids are opaque; `name_key` (separators and case folded) decides sameness.
// A handoff naming an unknown project creates it, so rows appear without any registration step.
export const projects = sqliteTable("projects", {
  ownerId: text("owner_id").notNull(), id: text("id").notNull(),
  name: text("name").notNull(), nameKey: text("name_key").notNull(), line: text("line").notNull(),
  archivedAt: integer("archived_at"), lastUsedAt: integer("last_used_at").notNull(),
  createdAt: integer("created_at").notNull(), updatedAt: integer("updated_at").notNull(),
  version: integer("version").notNull().default(1),
}, (t) => [primaryKey({ columns: [t.ownerId, t.id] }), uniqueIndex("projects_owner_name").on(t.ownerId, t.nameKey)]);

export const handoffs = sqliteTable("handoffs", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  title: text("title").notNull(), project: text("project").notNull().default(""),
  // The name columns are snapshots; the nullable id columns link to `devices` without a foreign key.
  sourceDevice: text("source_device").notNull(), targetDevice: text("target_device").notNull(),
  content: text("content").notNull(), status: text("status").notNull().default("ready"),
  claimedBy: text("claimed_by"), createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(), expiresAt: integer("expires_at"),
  version: integer("version").notNull().default(1), requestKey: text("request_key"),
  sourceDeviceId: text("source_device_id"), targetDeviceId: text("target_device_id"), claimedByDeviceId: text("claimed_by_device_id"),
  // Sender attribution inside a shared workspace; the name is a display snapshot taken at creation.
  createdByUserId: text("created_by_user_id"), createdByName: text("created_by_name"),
  // Image totals are written once in the creation batch (attachments are immutable and bound only then), so they
  // cannot drift; `attachment_bind_guard` proves they equal the bound rows before the batch commits.
  attachmentCount: integer("attachment_count").notNull().default(0), attachmentBytes: integer("attachment_bytes").notNull().default(0),
  // Links `project` (the display snapshot) to `projects`; null for no project and for legacy rows not reconciled yet.
  projectId: text("project_id"),
  // The receipt written by the completion that made the row `done`; cleared whenever the row returns to `ready`.
  result: text("result"),
  // Replies point at their direct parent and at the thread's root, without foreign keys: deleting a parent never touches
  // its replies. A root keeps `thread_id` null, so rows written before threads existed need no backfill.
  replyToId: text("reply_to_id"), threadId: text("thread_id"),
  // The code state the sender stopped at, validated on creation and never changed by the lifecycle. Untrusted text:
  // the server never resolves or fetches either value.
  gitBranch: text("git_branch"), gitBaseCommit: text("git_base_commit"),
}, (t) => [index("handoffs_owner_created").on(t.ownerId, t.createdAt), uniqueIndex("handoffs_owner_request").on(t.ownerId, t.requestKey),
  index("handoffs_owner_thread").on(t.ownerId, t.threadId, t.createdAt),
  index("handoffs_owner_target_device").on(t.ownerId, t.targetDeviceId),
  index("handoffs_owner_project").on(t.ownerId, t.projectId, t.createdAt),
  // Finds the expired rows the purge deletes, oldest first, without reading prompt pages.
  index("handoffs_owner_expiry").on(t.ownerId, t.expiresAt, t.id),
  // The inbox (ready and claimed) and Done lists page newest first without walking the other status's rows; with
  // expires_at it also covers the inbox count, so a poll never reads the rest of the workspace.
  index("handoffs_owner_status_created").on(t.ownerId, t.status, t.createdAt, t.id, t.expiresAt),
  // Store the byte expression in the index, not another wire field or a manually maintained counter.
  index("handoffs_owner_storage").on(t.ownerId, sql`length(CAST(${t.content} AS BLOB))`, t.id, t.status, t.expiresAt, t.createdAt, t.updatedAt),
  // Logical size (prompt text plus attached images) for Storage sorting, filtering and totals. The index above is kept for older code.
  index("handoffs_owner_logical").on(t.ownerId, sql`length(CAST(${t.content} AS BLOB)) + ${t.attachmentBytes}`, t.id, t.status, t.expiresAt, t.createdAt, t.updatedAt, t.attachmentCount, t.attachmentBytes),
  // The same size with the completion receipt counted as text. The index above stays until no deployed Worker reads it.
  index("handoffs_owner_logical_v2").on(t.ownerId, sql`length(CAST(${t.content} AS BLOB)) + length(CAST(coalesce(${t.result}, '') AS BLOB)) + ${t.attachmentBytes}`, t.id, t.status, t.expiresAt, t.createdAt, t.updatedAt, t.attachmentCount, t.attachmentBytes)]);

// Immutable uploaded images. A row is `pending` until its bytes are in R2, then `ready`; it joins at most one handoff.
// `object_key` is private: it is derived from the id and never leaves the server.
export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  handoffId: text("handoff_id"), position: integer("position"),
  filename: text("filename").notNull(), mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(), width: integer("width").notNull(), height: integer("height").notNull(),
  sha256: text("sha256").notNull(), objectKey: text("object_key").notNull(), uploadKey: text("upload_key").notNull(),
  state: text("state").notNull().default("pending"), createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("attachments_owner_upload").on(t.ownerId, t.uploadKey),
  uniqueIndex("attachments_handoff_position").on(t.handoffId, t.position).where(sql`${t.handoffId} IS NOT NULL`),
  index("attachments_owner_handoff").on(t.ownerId, t.handoffId),
  index("attachments_owner_state").on(t.ownerId, t.state, t.handoffId, t.createdAt)]);

// Objects whose database rows are gone and that still have to be deleted from R2; failures stay visible here.
export const objectCleanup = sqliteTable("object_cleanup", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), objectKey: text("object_key").notNull(),
  byteSize: integer("byte_size").notNull().default(0), attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"), createdAt: integer("created_at").notNull(),
}, (t) => [index("object_cleanup_owner").on(t.ownerId, t.createdAt)]);

// Written last in a creation batch. The CHECK fails the whole transaction when fewer or more attachments were bound than requested.
export const attachmentBindGuard = sqliteTable("attachment_bind_guard", {
  handoffId: text("handoff_id").primaryKey(), expected: integer("expected").notNull(), actual: integer("actual").notNull(),
}, (t) => [check("attachment_bind_guard_match", sql`${t.expected} = ${t.actual}`)]);

// Only the digest is stored; a credential can never be recovered from D1.
export const agentTokens = sqliteTable("agent_tokens", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(),
  name: text("name").notNull(), tokenHash: text("token_hash").notNull(),
  createdAt: integer("created_at").notNull(), expiresAt: integer("expires_at").notNull(),
  // Keep expires_at non-null for old Workers. Permanent rows use created_at there, so rollback fails closed.
  neverExpires: integer("never_expires", { mode: "boolean" }).notNull().default(false),
  lastAuthenticatedAt: integer("last_authenticated_at"),
  revokedAt: integer("revoked_at"),
  // Display and config generation only; a token still authorizes the whole account.
  deviceId: text("device_id"),
  // The member who minted the credential; its requests act as that member inside the owner's workspace.
  createdByUserId: text("created_by_user_id"), createdByName: text("created_by_name"),
  // Bumped by every change, so a stale browser cannot overwrite a newer edit.
  version: integer("version").notNull().default(1),
  // Who ended the connection and why; null for rows revoked before this was recorded.
  revokedByName: text("revoked_by_name"), revokedReason: text("revoked_reason"),
  // When the secret was last replaced; null if it never was.
  rotatedAt: integer("rotated_at"),
  // The agent profile chosen when the connection was made (null before this was recorded), and the name and version
  // the agent last reported when it initialized MCP. Both are display text only; nothing branches on them.
  clientProfile: text("client_profile"), lastClientName: text("last_client_name"), lastClientVersion: text("last_client_version"),
  // The lead time (ms) of the last expiry reminder this lifetime has used up; null when none has. Setting a lifetime
  // resets it, and it changes nothing a person sees, so it never bumps `version`.
  expiryRemindedLead: integer("expiry_reminded_lead"),
}, (t) => [uniqueIndex("agent_tokens_hash").on(t.tokenHash), index("agent_tokens_owner_created").on(t.ownerId, t.createdAt)]);

// Connection history. Names are snapshots, so an entry stays readable after its connection is removed; `detail` is small JSON.
export const connectionEvents = sqliteTable("connection_events", {
  id: text("id").primaryKey(), ownerId: text("owner_id").notNull(), tokenId: text("token_id"), tokenName: text("token_name").notNull(),
  kind: text("kind").notNull(), actorName: text("actor_name"), at: integer("at").notNull(), detail: text("detail"),
}, (t) => [index("connection_events_owner_at").on(t.ownerId, t.at), index("connection_events_owner_token").on(t.ownerId, t.tokenId, t.at)]);
