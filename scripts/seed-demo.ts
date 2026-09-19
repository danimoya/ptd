// Seeds a demo organization. Filled in during Phase 1 (streams, apps, tasks, agent time entries).
import { db } from "../db";
import { users } from "../db/schema";

async function main() {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  console.log(existing.length ? "[seed] database already has users; nothing to do" : "[seed] nothing to seed yet");
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
