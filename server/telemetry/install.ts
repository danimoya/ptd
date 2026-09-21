import { randomBytes } from "crypto";
import fsp from "fs/promises";
import path from "path";

/**
 * The install record: one JSON file, installation-scoped, that holds the
 * anonymous installation id and the two opt-in toggles.
 *
 * Mirrors the Claude-Dashboard `Install` entity (one row, ever) — the same
 * fields, the same defaults, the same guarantee — but as a file rather than a
 * table, because `db/schema.ts` is frozen and because this is a property of the
 * *installation*, not of an organization. An org is not the unit here: one PTD
 * process serves many organizations and reports one install.
 *
 * Compliance, quoted from the product policy this mirrors:
 *
 *   "Telemetry is **opt-in and off by default**. When enabled, the dashboard
 *    posts a tiny weekly ping containing four fields and nothing else. We do not
 *    send your IP, username, host metadata, or any contents from your sessions."
 *
 * So both toggles are created `false`, and nothing in this file reads a
 * hostname, a user, an org name or a count.
 *
 * Layout: `${PTD_FILES_DIR}/.ptd-install.json`, mode 0600 (`./data/files` in
 * dev, the `ptd_files` volume at `/data/files` under compose — the same root the
 * attachment blobs use, so one volume carries all installation-local state).
 * `filesRoot()` is duplicated from server/plan/attachments.ts rather than
 * imported: that module imports `db`, and telemetry must be readable (and unit
 * testable) without a database connection.
 *
 * The shape below is FROZEN. Unknown keys found in the file are preserved on
 * write, so a newer PTD that adds a field cannot be silently downgraded by an
 * older one sharing the same volume.
 */

const DEFAULT_DIR = "./data/files";

export const INSTALL_FILENAME = ".ptd-install.json";

/** The shared receiver. One endpoint for every product in the family. */
export const DEFAULT_TELEMETRY_ENDPOINT = "https://telemetry.danimoya.com/v1/ping";
/** A bare GET against the public release feed. No payload leaves the host. */
export const DEFAULT_UPDATE_CHECK_URL = "https://api.github.com/repos/danimoya/ptd/releases/latest";

export interface PingOutcome {
  ok: boolean;
  at: string;
  /** HTTP status the receiver answered with, or null if the request never landed. */
  status: number | null;
  error: string | null;
}

export interface InstallRecord {
  /** 32 lowercase hex characters, minted once. The receiver requires `^[a-f0-9]{16,64}$`. */
  installationId: string;
  telemetryEnabled: boolean;
  updateChecksEnabled: boolean;
  /** When the operator first answered the question, either way. Null = never asked. */
  decidedAt: string | null;
  lastPingAt: string | null;
  lastPingResult: PingOutcome | null;
  lastUpdateCheckAt: string | null;
  latestVersionSeen: string | null;
  createdAt: string;
}

export function filesRoot(): string {
  return path.resolve(process.env.PTD_FILES_DIR || DEFAULT_DIR);
}

export function installFilePath(): string {
  return path.join(filesRoot(), INSTALL_FILENAME);
}

/** 16 random bytes as hex. Opaque to the receiver and to us; not derived from anything. */
export function mintInstallationId(): string {
  return randomBytes(16).toString("hex");
}

export const INSTALLATION_ID_SHAPE = /^[a-f0-9]{16,64}$/;

export function endpointUrl(): string {
  return process.env.PTD_TELEMETRY_ENDPOINT || DEFAULT_TELEMETRY_ENDPOINT;
}

export function updateCheckUrl(): string {
  return process.env.PTD_UPDATE_CHECK_URL || DEFAULT_UPDATE_CHECK_URL;
}

/**
 * `PTD_TELEMETRY=0` is a kill switch and `PTD_TELEMETRY=1` an opt-in, both
 * outranking the stored toggle so an operator can settle the question in the env
 * file for a fleet. Anything else (including unset) leaves the file in charge.
 *
 * Scoped to the ping deliberately: update checks send no payload, so there is
 * nothing for a telemetry kill switch to protect there — they have their own
 * toggle.
 */
export function telemetryEnvOverride(): boolean | null {
  const raw = process.env.PTD_TELEMETRY;
  if (raw === "0") return false;
  if (raw === "1") return true;
  return null;
}

/** The effective answer to "may this process post a ping?" — env first, then the file. */
export function telemetryIsEnabled(record: InstallRecord): boolean {
  return telemetryEnvOverride() ?? record.telemetryEnabled;
}

function defaults(now: string): InstallRecord {
  return {
    installationId: mintInstallationId(),
    telemetryEnabled: false,
    updateChecksEnabled: false,
    decidedAt: null,
    lastPingAt: null,
    lastPingResult: null,
    lastUpdateCheckAt: null,
    latestVersionSeen: null,
    createdAt: now,
  };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Coerce whatever is on disk into the frozen shape. A hand-edited or
 * half-written file must never crash the process or, worse, be read as
 * "telemetry enabled" — every boolean falls back to `false`.
 */
export function normalizeInstall(raw: unknown, now = new Date().toISOString()): InstallRecord {
  const base = defaults(now);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const id = typeof r.installationId === "string" ? r.installationId.trim().toLowerCase() : "";
  const outcome = r.lastPingResult;
  return {
    ...r,
    installationId: INSTALLATION_ID_SHAPE.test(id) ? id : base.installationId,
    telemetryEnabled: r.telemetryEnabled === true,
    updateChecksEnabled: r.updateChecksEnabled === true,
    decidedAt: str(r.decidedAt),
    lastPingAt: str(r.lastPingAt),
    lastPingResult:
      outcome && typeof outcome === "object"
        ? {
            ok: (outcome as Record<string, unknown>).ok === true,
            at: str((outcome as Record<string, unknown>).at) ?? now,
            status: typeof (outcome as Record<string, unknown>).status === "number" ? ((outcome as Record<string, unknown>).status as number) : null,
            error: str((outcome as Record<string, unknown>).error),
          }
        : null,
    lastUpdateCheckAt: str(r.lastUpdateCheckAt),
    latestVersionSeen: str(r.latestVersionSeen),
    createdAt: str(r.createdAt) ?? base.createdAt,
  } as InstallRecord;
}

async function writeRecord(record: InstallRecord): Promise<void> {
  const file = installFilePath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Temp file plus rename, so a crash mid-write cannot leave a truncated record
  // (and cannot leave a readable one: the temp file is 0600 from creation).
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, file);
  await fsp.chmod(file, 0o600).catch(() => {});
}

/** The record as it is on disk, or null when there is none (or it is unreadable). */
export async function readInstall(): Promise<InstallRecord | null> {
  try {
    const text = await fsp.readFile(installFilePath(), "utf8");
    return normalizeInstall(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

let pending: Promise<InstallRecord> | null = null;

/**
 * The record, minting it on first call. Idempotent, and safe against two
 * processes racing on the same volume: the create is exclusive (`wx`), so the
 * loser re-reads the winner's id rather than overwriting it with its own.
 */
export async function loadInstall(): Promise<InstallRecord> {
  if (pending) return pending;
  pending = (async () => {
    const existing = await readInstall();
    if (existing) return existing;

    const fresh = defaults(new Date().toISOString());
    const file = installFilePath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      await fsp.writeFile(file, `${JSON.stringify(fresh, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      console.log(`[telemetry] minted installation id ${fresh.installationId} (telemetry off by default)`);
      return fresh;
    } catch {
      const other = await readInstall();
      return other ?? fresh;
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/** Merge a patch into the record and persist it. Returns what was written. */
export async function updateInstall(patch: Partial<InstallRecord>): Promise<InstallRecord> {
  const current = await loadInstall();
  // installationId and createdAt are write-once: a caller cannot rotate the id
  // (which would count one install twice) by sending one in.
  const next: InstallRecord = { ...current, ...patch, installationId: current.installationId, createdAt: current.createdAt };
  await writeRecord(next);
  return next;
}

/** Test seam: drop the in-flight load so a test can point PTD_FILES_DIR elsewhere. */
export function resetInstallCache(): void {
  pending = null;
}
