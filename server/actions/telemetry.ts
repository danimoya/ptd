/**
 * Installation telemetry, as actions — so the CLI, an MCP client and the audit
 * log reach the same three verbs the Org → Data section does.
 *
 * All three are owner-grade. The setting is instance-wide (one PTD process, one
 * install record, many organizations), so the role gate here is the closest
 * honest approximation: whoever owns the organization you are calling from.
 *
 * The policy these actions implement, unchanged from Claude-Dashboard:
 * telemetry is **opt-in and off by default**; the payload is exactly
 * `{ installation_id, dashboard_version, heliosdb_version, timestamp }`; no IP,
 * no username, no email, no hostname, no OS or architecture, no organization
 * names, no counts, no task or session content; and the operator can see the
 * exact bytes before anything is sent.
 */
import { z } from "zod";
import { defineAction } from "./registry";
import { loadInstall } from "../telemetry/install";
import { OFFLINE_FORMATS, TELEMETRY_POLICY, buildPayload, offlineCommandsFor, ping, setPreferences, statusOf } from "../telemetry/service";

defineAction({
  name: "telemetry.status",
  title: "Installation telemetry status",
  description:
    "Whether this installation submits the weekly anonymous install ping and whether it checks for updates — both off unless someone turned them on — " +
    "together with the exact four-field JSON that would be sent, the six ready-to-paste offline submission formats for an egress-restricted host, " +
    "and the receiver's retention policy. Reading this sends nothing.",
  input: z.object({}),
  requiredRole: "owner",
  surface: "org",
  handler: async () => {
    const install = await loadInstall();
    const payload = await buildPayload(install);
    return {
      status: statusOf(install),
      payload,
      offline: { formats: OFFLINE_FORMATS, commands: offlineCommandsFor(payload) },
      policy: TELEMETRY_POLICY,
    };
  },
});

defineAction({
  name: "telemetry.set",
  title: "Set the telemetry preferences",
  description:
    "Turn the weekly install ping and the update check on or off, independently. The ping posts four fields to the shared receiver, which hashes " +
    "(client IP, installation id) under a weekly-rotating salt and keeps only the hash; the update check is a bare GET against the public releases " +
    "feed and sends nothing at all. Either call also records that the question has been answered, which retires the first-run prompt. " +
    "`PTD_TELEMETRY=0` or `=1` in the environment outranks the stored ping toggle.",
  input: z
    .object({
      telemetryEnabled: z.boolean().optional().describe("true = post the weekly ping. Off by default."),
      updateChecksEnabled: z.boolean().optional().describe("true = GET the public releases feed. Off by default. Sends no payload."),
      dismissed: z.boolean().optional().describe("Answer the question without changing either toggle — what dismissing the first-run prompt does."),
    })
    .strict(),
  requiredRole: "owner",
  surface: "org",
  audited: true,
  handler: async (args) => setPreferences(args),
});

defineAction({
  name: "telemetry.ping",
  title: "Send one install ping now",
  description:
    "Post the four-field payload once, immediately, instead of waiting for the weekly timer. Refused with `telemetry-disabled` while the toggle is off — " +
    "there is no path in PTD that pings without an explicit opt-in. Returns the exact payload that was sent and the receiver's status code; " +
    "a network failure is reported, not thrown.",
  input: z.object({}),
  requiredRole: "owner",
  surface: "org",
  handler: async () => ping(),
});
