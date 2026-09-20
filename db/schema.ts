import {
  pgTable, text, serial, timestamp, boolean, varchar, integer, real, jsonb,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

export const ROLES = ["owner", "admin", "manager", "member"] as const;
export type Role = (typeof ROLES)[number];
export const TASK_STATUSES = ["backlog", "triaged", "in-progress", "completed", "wontfix"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const organizations = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 80 }).notNull().unique(),
  plan: varchar("plan", { length: 20 }).notNull().default("self_hosted"),
  inviteCode: varchar("invite_code", { length: 32 }),
  stripeCustomerId: varchar("stripe_customer_id", { length: 64 }),
  stripeSubscriptionId: varchar("stripe_subscription_id", { length: 64 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  isAgent: boolean("is_agent").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const memberships = pgTable("memberships", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("member"),
  invitedBy: integer("invited_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitations = pgTable("invitations", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  role: varchar("role", { length: 20 }).notNull().default("member"),
  token: varchar("token", { length: 64 }).notNull().unique(),
  invitedBy: integer("invited_by").references(() => users.id).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  acceptedAt: timestamp("accepted_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Bearer tokens for agents and integrations. Format: ptd_{8 hex prefix}{32 hex secret}
export const apiTokens = pgTable("api_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  prefix: varchar("prefix", { length: 8 }).notNull().unique(),
  hash: varchar("hash", { length: 200 }).notNull(),
  scopes: varchar("scopes", { length: 64 }).notNull().default("read,write"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
});

// A product / service / codebase the org owns. Counters are computed, never stored.
export const apps = pgTable("apps", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  key: varchar("key", { length: 64 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  urls: jsonb("urls").$type<string[]>().notNull().default([]),
  repo: varchar("repo", { length: 255 }),
  stack: jsonb("stack").$type<string[]>().notNull().default([]),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const customers = pgTable("customers", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  weeklyGoalHours: integer("weekly_goal_hours"),
  billingAddress: text("billing_address"),
  billingEmail: varchar("billing_email", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// Stream = Kanttban swim-lane = TTM project. Attaches to one app or several.
export const streams = pgTable("streams", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  color: varchar("color", { length: 16 }),
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
  archived: boolean("archived").notNull().default(false),
  position: integer("position").notNull().default(0),
  agentBudgetUsd: real("agent_budget_usd"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const streamApps = pgTable("stream_apps", {
  id: serial("id").primaryKey(),
  streamId: integer("stream_id").references(() => streams.id, { onDelete: "cascade" }).notNull(),
  appId: integer("app_id").references(() => apps.id, { onDelete: "cascade" }).notNull(),
});

export const tasks = pgTable("tasks", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: varchar("status", { length: 20 }).notNull().default("backlog"),
  streamId: integer("stream_id").references(() => streams.id, { onDelete: "set null" }),
  appId: integer("app_id").references(() => apps.id, { onDelete: "set null" }),
  assignedTo: integer("assigned_to").references(() => users.id, { onDelete: "set null" }),
  startDate: timestamp("start_date"),
  dueDate: timestamp("due_date"),
  estimatedDuration: integer("estimated_duration"),
  dependencies: jsonb("dependencies").$type<number[]>().notNull().default([]),
  externalKey: varchar("external_key", { length: 128 }),
  urgency: integer("urgency").notNull().default(5),
  impact: integer("impact").notNull().default(5),
  effort: integer("effort").notNull().default(5),
  priorityScore: integer("priority_score").notNull().default(5),
  prioritySource: varchar("priority_source", { length: 10 }).notNull().default("formula"),
  priorityNote: text("priority_note"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  completed: boolean("completed").notNull().default(false),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const taskEvents = pgTable("task_events", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }).notNull(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorLabel: text("actor_label"),
  kind: varchar("kind", { length: 32 }).notNull(),
  changes: jsonb("changes").$type<Record<string, { old: unknown; new: unknown }>>(),
  note: text("note"),
  via: varchar("via", { length: 16 }).notNull().default("web"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const timeEntries = pgTable("time_entries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
  streamId: integer("stream_id").references(() => streams.id, { onDelete: "set null" }),
  taskId: integer("task_id").references(() => tasks.id, { onDelete: "set null" }),
  checkIn: timestamp("check_in").notNull(),
  checkOut: timestamp("check_out"),
  isBreak: boolean("is_break").notNull().default(false),
  notes: text("notes"),
  // Decided by the server from the auth path; never from the request body.
  entrySource: varchar("entry_source", { length: 10 }).notNull().default("human"),
  agentLabel: varchar("agent_label", { length: 80 }),
  tokensUsed: integer("tokens_used"),
  apiCostUsd: real("api_cost_usd"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const entryTemplates = pgTable("entry_templates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
  streamId: integer("stream_id").references(() => streams.id, { onDelete: "set null" }),
  name: varchar("name", { length: 100 }).notNull(),
  icon: varchar("icon", { length: 32 }),
  notes: text("notes"),
  isBreak: boolean("is_break").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  customerId: integer("customer_id").references(() => customers.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  month: integer("month").notNull(),
  year: integer("year").notNull(),
  status: varchar("status", { length: 50 }).notNull().default("draft"),
  totalAmount: integer("total_amount"),
  pdfUrl: varchar("pdf_url", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const orgIntegrations = pgTable("org_integrations", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  kind: varchar("kind", { length: 20 }).notNull(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const chatIdentities = pgTable("chat_identities", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  provider: varchar("provider", { length: 20 }).notNull(),
  externalId: varchar("external_id", { length: 128 }).notNull(),
  linkedAt: timestamp("linked_at").notNull().defaultNow(),
});

export type Organization = typeof organizations.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type App = typeof apps.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Stream = typeof streams.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;
export type TaskEvent = typeof taskEvents.$inferSelect;
export type TimeEntry = typeof timeEntries.$inferSelect;
export type InsertTimeEntry = typeof timeEntries.$inferInsert;
export type EntryTemplate = typeof entryTemplates.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;

export const insertTaskSchema = createInsertSchema(tasks);
export const selectTaskSchema = createSelectSchema(tasks);
export const insertTimeEntrySchema = createInsertSchema(timeEntries);
export const selectTimeEntrySchema = createSelectSchema(timeEntries);

/** Sprinter's formula on 0–10 inputs: urgency×impact/effort, clamped to 0–100. */
export function priorityScore(urgency: number, impact: number, effort: number): number {
  const raw = (urgency * impact) / Math.max(effort, 1);
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/* ─────────────── OAuth 2.1 authorization server (MCP connectors) ───────────────
 * Claude.ai / ChatGPT connectors cannot be handed a pasted token, so PTD also
 * speaks the MCP authorization flow: dynamic registration, Authorization Code +
 * PKCE, refresh. The access token it issues is a normal `ptd_` api_token, so
 * /mcp keeps exactly one verification path; these tables only record which
 * client asked, who approved it and for which organization.
 */

export const oauthClients = pgTable("oauth_clients", {
  id: serial("id").primaryKey(),
  clientId: varchar("client_id", { length: 64 }).notNull().unique(),
  /** scrypt hash; null for public clients (token_endpoint_auth_method = none). */
  clientSecretHash: varchar("client_secret_hash", { length: 200 }),
  clientName: varchar("client_name", { length: 255 }).notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull().default([]),
  grantTypes: jsonb("grant_types").$type<string[]>().notNull().default([]),
  tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", { length: 32 }).notNull().default("none"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthCodes = pgTable("oauth_codes", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 128 }).notNull().unique(),
  clientId: varchar("client_id", { length: 64 }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  redirectUri: varchar("redirect_uri", { length: 500 }).notNull(),
  scope: varchar("scope", { length: 200 }).notNull().default(""),
  codeChallenge: varchar("code_challenge", { length: 128 }).notNull(),
  codeChallengeMethod: varchar("code_challenge_method", { length: 10 }).notNull().default("S256"),
  /** RFC 8707 audience — must be the MCP endpoint when the client sends one. */
  resource: varchar("resource", { length: 500 }),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthRefreshTokens = pgTable("oauth_refresh_tokens", {
  id: serial("id").primaryKey(),
  /** Keyed SHA-256 of the opaque `ptdr_…` token — deterministic so it is findable. */
  tokenHash: varchar("token_hash", { length: 200 }).notNull().unique(),
  clientId: varchar("client_id", { length: 64 }).notNull(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  orgId: integer("org_id").references(() => organizations.id, { onDelete: "cascade" }).notNull(),
  /** The `ptd_` access token this refresh token currently owns. */
  apiTokenId: integer("api_token_id").references(() => apiTokens.id, { onDelete: "cascade" }),
  /** Lineage: the code the grant came from, carried through every rotation, so a
   *  replayed authorization code can revoke everything it ever produced. */
  codeId: integer("code_id").references(() => oauthCodes.id, { onDelete: "set null" }),
  scope: varchar("scope", { length: 200 }).notNull().default(""),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type OauthClient = typeof oauthClients.$inferSelect;
export type OauthCode = typeof oauthCodes.$inferSelect;
export type OauthRefreshToken = typeof oauthRefreshTokens.$inferSelect;

/* ─────────────────────────── Password resets ───────────────────────────
 * A reset link is a bearer credential for an account, so the row stores only a
 * keyed SHA-256 of the token (deterministic, so the row is findable by value —
 * the same treatment `oauth_refresh_tokens` gets) and the token itself exists
 * only in the letter that was mailed. One use: `used_at` is stamped on
 * redemption, and redeeming one invalidates every other outstanding token for
 * that account, so a forwarded older link cannot be replayed afterwards.
 */
export const passwordResets = pgTable("password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  tokenHash: varchar("token_hash", { length: 200 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PasswordReset = typeof passwordResets.$inferSelect;
