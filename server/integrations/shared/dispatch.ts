import { ActionError, runAction as defaultRunAction, type ActionContext } from "../../actions/registry";
import { hasRole } from "../../types";
import { errorReply, renderHelp, type Reply } from "./format";
import { parseCommandText } from "./parse";
import {
  canonicalVerb,
  defaultVerbDeps,
  helpEntriesFor,
  requiredRoleOf,
  usageOf,
  verbByName,
  type Verb,
  type VerbDeps,
  type VerbInput,
} from "./verbs";

/**
 * One typed command → one registry action → one reply, for any chat surface.
 *
 * Everything surface-specific is in the input: the `prefix` a command is typed with,
 * who the caller is on that surface, and the extra rows its help table carries
 * (`/ptd unlink`, `/org <id>`). The role gate is checked here *before* the arguments
 * are even built, so a member asking for `stats` gets a sentence about their role
 * rather than a parse error, and then again inside `runAction` — the registry is the
 * authority and this is only a courtesy.
 */

export interface DispatchDeps extends VerbDeps {
  runAction: typeof defaultRunAction;
}

export const defaultDispatchDeps: DispatchDeps = {
  ...defaultVerbDeps,
  runAction: defaultRunAction,
};

export interface DispatchInput {
  ctx: ActionContext;
  /** The command text with the sigil already removed (`"start PTD-12 now"`). */
  text: string;
  /** How a command is typed here: `"/ptd "`, `"/"` or `"@PTD "`. */
  prefix: string;
  /** The chat account and scope, for `who`. Pre-escaped by the adapter. */
  who: { account: string; scope: string | null };
  /** Help rows this surface adds on top of the verb table. */
  helpExtras?: { usage: string; summary: string }[];
  /** Adapter name for the server log when something unexpected breaks. */
  surface: string;
}

export interface Dispatch {
  reply: Reply;
  /** The canonical verb, so a caller can tell `help` from a real command. */
  verb: string;
}

export async function dispatchCommand(input: DispatchInput, overrides: Partial<DispatchDeps> = {}): Promise<Dispatch> {
  const deps: DispatchDeps = { ...defaultDispatchDeps, ...overrides };
  const parsed = parseCommandText(input.text);
  const name = canonicalVerb(parsed.sub);

  if (name === "help") {
    return { verb: "help", reply: renderHelp(helpEntriesFor(input.ctx, input.prefix, input.helpExtras), input.ctx.role) };
  }

  const verb = verbByName(name);
  if (!verb) {
    return {
      verb: name,
      reply: errorReply(`I don't know \`${input.prefix}${parsed.sub}\`.`, [`\`${input.prefix}help\` lists what you can run`]),
    };
  }

  const requiredRole = requiredRoleOf(verb.action);
  if (!hasRole(input.ctx.role, requiredRole)) {
    return {
      verb: name,
      reply: errorReply(`Your role (${input.ctx.role}) can't do that — ask a manager.`, [
        `\`${usageOf(verb, input.prefix)}\` needs ${requiredRole} or higher`,
      ]),
    };
  }

  const verbInput: VerbInput = {
    ctx: input.ctx,
    args: parsed.args,
    rest: parsed.rest,
    prefix: input.prefix,
    deps,
    who: input.who,
  };
  try {
    const args = await verb.build(verbInput);
    const result = await deps.runAction(verb.action, args, input.ctx);
    return { verb: name, reply: verb.render(result, verbInput) };
  } catch (err) {
    return { verb: name, reply: failureReply(err, verb, input) };
  }
}

/** A failure the caller can act on — and never an internal error message. */
export function failureReply(err: unknown, verb: Verb, input: Pick<DispatchInput, "ctx" | "prefix" | "surface">): Reply {
  const usage = usageOf(verb, input.prefix);
  if (err instanceof ActionError) {
    switch (err.code) {
      case "forbidden":
        return errorReply(`Your role (${input.ctx.role}) can't do that — ask a manager.`, [err.message]);
      case "not_found":
        return errorReply(`Nothing found. ${err.message}`, [`\`${usage}\``]);
      case "invalid":
        return errorReply(err.message, [`\`${usage}\``]);
      case "conflict":
        return errorReply(err.message);
    }
  }
  console.error(`[${input.surface}] ${verb.action} failed:`, err);
  return errorReply("Something went wrong on the PTD side — the server log has the details.");
}
