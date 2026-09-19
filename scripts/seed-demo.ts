// Seeds the "Atelier 14" demo organization: 4 humans, 2 agents, 3 apps, 4 streams (one
// cross-app), 18 tasks with dependencies and priority inputs, and a week of human + agent
// time entries with token/cost figures. Idempotent: skips if the org slug exists.
// Prints the agent tokens once. Run: DATABASE_URL=… npm run seed
import bcrypt from "bcryptjs";
import { randomBytes, scrypt as scryptCb } from "crypto";
import { promisify } from "util";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  organizations, users, memberships, apiTokens, apps, customers, streams, streamApps, tasks, taskEvents, timeEntries,
  priorityScore,
} from "../db/schema";

const scrypt = promisify(scryptCb);
const SLUG = "atelier-14-demo";
const PASSWORD = process.env.SEED_PASSWORD || "demo.draft.atelier14";

async function mint(userId: number, orgId: number, name: string) {
  const prefix = randomBytes(4).toString("hex");
  const body = randomBytes(16).toString("hex");
  const salt = randomBytes(16).toString("hex");
  const buf = (await scrypt(body, salt, 64)) as Buffer;
  await db.insert(apiTokens).values({ userId, orgId, name, prefix, hash: `${buf.toString("hex")}.${salt}` });
  return `ptd_${prefix}${body}`;
}

const day = (offset: number, h = 9, m = 0) => {
  const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + offset); return d;
};

async function main() {
  const existing = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, SLUG)).limit(1);
  if (existing.length) { console.log(`[seed] organization ${SLUG} already exists (id ${existing[0].id}); nothing to do`); return; }

  const [org] = await db.insert(organizations).values({ name: "Atelier 14", slug: SLUG, plan: process.env.PTD_HOSTED === "1" ? "free" : "self_hosted", inviteCode: randomBytes(8).toString("hex") }).returning();
  const hash = await bcrypt.hash(PASSWORD, 12);
  const humans = [
    { email: "elena@atelier14.demo", displayName: "Elena Draftworks", role: "owner" },
    { email: "marcus@atelier14.demo", displayName: "Marcus Vellum", role: "manager" },
    { email: "priya@atelier14.demo", displayName: "Priya Indigo", role: "member" },
    { email: "theo@atelier14.demo", displayName: "Theo Schibsted", role: "member" },
  ];
  const agents = [
    { email: "agent_atelier_14@agents.ptd.local", displayName: "Atelier Orchestrator", role: "manager" },
    { email: "agent_claude_code@agents.ptd.local", displayName: "Claude Code", role: "member" },
  ];
  const ids: Record<string, number> = {};
  for (const h of humans) {
    const [u] = await db.insert(users).values({ email: h.email, passwordHash: hash, displayName: h.displayName }).returning();
    await db.insert(memberships).values({ orgId: org.id, userId: u.id, role: h.role });
    ids[h.displayName] = u.id;
  }
  const tokens: Record<string, string> = {};
  for (const a of agents) {
    const [u] = await db.insert(users).values({ email: a.email, passwordHash: await bcrypt.hash(randomBytes(32).toString("hex"), 10), displayName: a.displayName, isAgent: true }).returning();
    await db.insert(memberships).values({ orgId: org.id, userId: u.id, role: a.role });
    ids[a.displayName] = u.id;
    tokens[a.displayName] = await mint(u.id, org.id, `${a.displayName} — seed`);
  }

  const appRows = await db.insert(apps).values([
    { orgId: org.id, key: "web", name: "Atelier Web", urls: ["https://atelier14.example"], repo: "atelier14/web", stack: ["react", "vite", "express"] },
    { orgId: org.id, key: "mobile", name: "Atelier Mobile", urls: [], repo: "atelier14/mobile", stack: ["react-native"] },
    { orgId: org.id, key: "api", name: "Atelier API", urls: ["https://api.atelier14.example"], repo: "atelier14/api", stack: ["rust", "axum", "heliosdb"] },
  ]).returning();
  const app = Object.fromEntries(appRows.map((a) => [a.key, a.id]));

  const [client] = await db.insert(customers).values({ orgId: org.id, name: "Northwind Retail", weeklyGoalHours: 20, billingEmail: "ap@northwind.example" }).returning();
  const streamRows = await db.insert(streams).values([
    { orgId: org.id, name: "Security audit", color: "#B8451A", position: 0, agentBudgetUsd: 25, customerId: client.id },
    { orgId: org.id, name: "Checkout redesign", color: "#1A1510", position: 1, customerId: client.id },
    { orgId: org.id, name: "Mobile onboarding", color: "#5B6B4A", position: 2 },
    { orgId: org.id, name: "API v2", color: "#7A6F5D", position: 3, agentBudgetUsd: 40 },
  ]).returning();
  const st = Object.fromEntries(streamRows.map((s) => [s.name, s.id]));
  await db.insert(streamApps).values([
    { streamId: st["Security audit"], appId: app.web }, { streamId: st["Security audit"], appId: app.mobile }, { streamId: st["Security audit"], appId: app.api },
    { streamId: st["Checkout redesign"], appId: app.web },
    { streamId: st["Mobile onboarding"], appId: app.mobile },
    { streamId: st["API v2"], appId: app.api },
  ]);

  type T = { key: string; title: string; stream: string; app: keyof typeof app; status: string; u: number; i: number; e: number; start?: number; dur?: number; deps?: string[]; assignee?: string; tags?: string[] };
  const spec: T[] = [
    { key: "SEC-1", title: "Threat model the checkout flow", stream: "Security audit", app: "web", status: "completed", u: 9, i: 9, e: 3, start: -12, dur: 3, assignee: "Marcus Vellum", tags: ["security"] },
    { key: "SEC-2", title: "Rotate leaked staging credentials", stream: "Security audit", app: "api", status: "completed", u: 10, i: 8, e: 1, start: -10, dur: 1, assignee: "Claude Code", tags: ["security", "ops"] },
    { key: "SEC-3", title: "Add CSRF tokens to every form", stream: "Security audit", app: "web", status: "in-progress", u: 8, i: 8, e: 3, start: -4, dur: 4, deps: ["SEC-1"], assignee: "Claude Code", tags: ["security"] },
    { key: "SEC-4", title: "Pin TLS 1.3 + PQC hybrid on the API edge", stream: "Security audit", app: "api", status: "in-progress", u: 7, i: 9, e: 2, start: -2, dur: 2, deps: ["SEC-2"], assignee: "Atelier Orchestrator", tags: ["security", "infra"] },
    { key: "SEC-5", title: "Mobile keychain storage review", stream: "Security audit", app: "mobile", status: "triaged", u: 6, i: 7, e: 4, deps: ["SEC-1"], tags: ["security"] },
    { key: "SEC-6", title: "Pen-test report write-up", stream: "Security audit", app: "web", status: "backlog", u: 5, i: 6, e: 3, deps: ["SEC-3", "SEC-4", "SEC-5"], assignee: "Priya Indigo", tags: ["docs"] },
    { key: "CHK-1", title: "Wireframe the one-page checkout", stream: "Checkout redesign", app: "web", status: "completed", u: 7, i: 8, e: 2, start: -9, dur: 2, assignee: "Elena Draftworks" },
    { key: "CHK-2", title: "Implement address autocomplete", stream: "Checkout redesign", app: "web", status: "in-progress", u: 6, i: 7, e: 4, start: -3, dur: 5, deps: ["CHK-1"], assignee: "Claude Code" },
    { key: "CHK-3", title: "Payment provider fallback", stream: "Checkout redesign", app: "web", status: "triaged", u: 8, i: 9, e: 5, deps: ["CHK-1"], assignee: "Marcus Vellum" },
    { key: "CHK-4", title: "A/B test the new flow", stream: "Checkout redesign", app: "web", status: "backlog", u: 5, i: 8, e: 3, deps: ["CHK-2", "CHK-3"], assignee: "Theo Schibsted", tags: ["growth"] },
    { key: "MOB-1", title: "Onboarding copy and screens", stream: "Mobile onboarding", app: "mobile", status: "in-progress", u: 6, i: 6, e: 3, start: -5, dur: 4, assignee: "Priya Indigo" },
    { key: "MOB-2", title: "Biometric sign-in", stream: "Mobile onboarding", app: "mobile", status: "triaged", u: 7, i: 7, e: 5, deps: ["MOB-1", "SEC-5"], assignee: "Claude Code" },
    { key: "MOB-3", title: "Push notification opt-in", stream: "Mobile onboarding", app: "mobile", status: "backlog", u: 4, i: 5, e: 2, deps: ["MOB-1"] },
    { key: "API-1", title: "Design v2 resource model", stream: "API v2", app: "api", status: "completed", u: 8, i: 9, e: 3, start: -14, dur: 4, assignee: "Marcus Vellum" },
    { key: "API-2", title: "Generate OpenAPI 3.1 spec from routes", stream: "API v2", app: "api", status: "in-progress", u: 7, i: 8, e: 2, start: -6, dur: 3, deps: ["API-1"], assignee: "Atelier Orchestrator", tags: ["docs"] },
    { key: "API-3", title: "Migrate rate limiting to token buckets", stream: "API v2", app: "api", status: "triaged", u: 6, i: 7, e: 3, deps: ["API-1"], assignee: "Claude Code" },
    { key: "API-4", title: "Deprecation headers on v1", stream: "API v2", app: "api", status: "backlog", u: 4, i: 6, e: 1, deps: ["API-2"] },
    { key: "API-5", title: "v2 launch checklist", stream: "API v2", app: "api", status: "backlog", u: 5, i: 9, e: 2, deps: ["API-2", "API-3", "API-4", "SEC-4"], assignee: "Elena Draftworks", tags: ["launch"] },
  ];
  const taskId: Record<string, number> = {};
  for (const t of spec) {
    const start = t.start != null ? day(t.start) : null;
    const due = start && t.dur ? day(t.start! + t.dur) : null;
    const [row] = await db.insert(tasks).values({
      orgId: org.id, title: t.title, description: `<p>${t.title} for ${t.app}.</p>`, status: t.status, completed: t.status === "completed",
      streamId: st[t.stream], appId: app[t.app], assignedTo: t.assignee ? ids[t.assignee] : null, externalKey: t.key,
      startDate: start, dueDate: due, estimatedDuration: t.dur ?? null, dependencies: [],
      urgency: t.u, impact: t.i, effort: t.e, priorityScore: priorityScore(t.u, t.i, t.e), tags: t.tags ?? [], createdBy: ids["Elena Draftworks"],
    }).returning();
    taskId[t.key] = row.id;
  }
  for (const t of spec) {
    if (t.deps?.length) await db.update(tasks).set({ dependencies: t.deps.map((d) => taskId[d]) }).where(eq(tasks.id, taskId[t.key]));
    await db.insert(taskEvents).values({ taskId: taskId[t.key], orgId: org.id, actorUserId: ids["Elena Draftworks"], actorLabel: "Elena Draftworks", kind: "created", via: "import", note: "seeded" });
    if (t.status === "completed") {
      const actor = t.assignee ?? "Elena Draftworks";
      await db.insert(taskEvents).values({ taskId: taskId[t.key], orgId: org.id, actorUserId: ids[actor], actorLabel: ids[actor] && agents.some((a) => a.displayName === actor) ? `${actor} (agent)` : actor, kind: "completed", via: agents.some((a) => a.displayName === actor) ? "mcp" : "web" });
    }
  }

  // Time entries: humans log sessions; agents log sessions with tokens + cost.
  const entries: (typeof timeEntries.$inferInsert)[] = [];
  const human = (who: string, key: string, d: number, h: number, mins: number, notes?: string) =>
    entries.push({ userId: ids[who], orgId: org.id, streamId: st[spec.find((s) => s.key === key)!.stream], taskId: taskId[key], checkIn: day(d, h), checkOut: day(d, h, mins), entrySource: "human", notes: notes ?? null });
  const agent = (who: string, key: string, d: number, h: number, mins: number, tokens: number, cost: number, notes?: string) =>
    entries.push({ userId: ids[who], orgId: org.id, streamId: st[spec.find((s) => s.key === key)!.stream], taskId: taskId[key], checkIn: day(d, h), checkOut: day(d, h, mins), entrySource: "agent", agentLabel: who, tokensUsed: tokens, apiCostUsd: cost, notes: notes ?? null });
  human("Marcus Vellum", "SEC-1", -12, 9, 150, "STRIDE pass on checkout"); human("Marcus Vellum", "SEC-1", -11, 10, 95);
  agent("Claude Code", "SEC-2", -10, 14, 22, 48_200, 0.61, "rotated 6 secrets, opened PR #412");
  agent("Claude Code", "SEC-3", -4, 9, 41, 132_900, 1.74, "csrf middleware + 38 form patches"); agent("Claude Code", "SEC-3", -3, 9, 37, 98_400, 1.29); human("Marcus Vellum", "SEC-3", -3, 15, 45, "review of the agent PR");
  agent("Atelier Orchestrator", "SEC-4", -2, 8, 18, 61_000, 0.93, "edge config diff"); human("Marcus Vellum", "SEC-4", -1, 11, 60);
  human("Elena Draftworks", "CHK-1", -9, 9, 180); human("Elena Draftworks", "CHK-1", -8, 9, 120);
  agent("Claude Code", "CHK-2", -3, 10, 55, 210_300, 2.66, "autocomplete component + tests"); agent("Claude Code", "CHK-2", -2, 10, 48, 174_800, 2.21); human("Theo Schibsted", "CHK-2", -1, 14, 30, "QA on staging");
  human("Priya Indigo", "MOB-1", -5, 9, 200); human("Priya Indigo", "MOB-1", -4, 9, 160); human("Priya Indigo", "MOB-1", -2, 9, 90);
  human("Marcus Vellum", "API-1", -14, 9, 240); human("Marcus Vellum", "API-1", -13, 9, 200);
  agent("Atelier Orchestrator", "API-2", -6, 9, 33, 88_700, 1.31, "spec generator scaffold"); agent("Atelier Orchestrator", "API-2", -5, 9, 29, 74_100, 1.10); agent("Atelier Orchestrator", "API-2", -1, 9, 26, 69_900, 1.02);
  await db.insert(timeEntries).values(entries);

  console.log(`[seed] organization "Atelier 14" (id ${org.id}, slug ${SLUG}) — invite code ${org.inviteCode}`);
  console.log(`[seed] humans: ${humans.map((h) => `${h.email} (${h.role})`).join(", ")} — password: ${PASSWORD}`);
  for (const [name, tok] of Object.entries(tokens)) console.log(`[seed] agent "${name}" token: ${tok}`);
  console.log(`[seed] ${appRows.length} apps, 1 customer, ${streamRows.length} streams, ${spec.length} tasks, ${entries.length} time entries`);
}

main().then(() => process.exit(0)).catch((err) => { console.error("[seed] failed:", err); process.exit(1); });
