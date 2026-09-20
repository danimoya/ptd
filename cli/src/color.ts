/**
 * Colour only when stdout is a TTY. `NO_COLOR` (any value) and `TERM=dumb` turn
 * it off, `FORCE_COLOR` turns it on — the usual contract, so piping `ptd tasks`
 * into grep yields plain text.
 */
let enabled = decideFromEnv();

function decideFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

export function setColor(on: boolean): void {
  enabled = on;
}

export function colorEnabled(): boolean {
  return enabled;
}

const wrap = (open: string) => (text: string) => (enabled ? `\u001b[${open}m${text}\u001b[0m` : text);

export const bold = wrap("1");
export const dim = wrap("2");
export const red = wrap("31");
export const green = wrap("32");
export const yellow = wrap("33");
export const cyan = wrap("36");
