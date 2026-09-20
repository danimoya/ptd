import type { Client } from "./api.ts";

export interface Ctx {
  client: Client;
  flags: Map<string, string | true>;
  /** Positionals after the command name. */
  args: string[];
  /** `--json` was given without a JSON body — print the raw API answer. */
  raw: boolean;
  print: (text: string) => void;
}

export type Handler = (ctx: Ctx) => Promise<void>;
