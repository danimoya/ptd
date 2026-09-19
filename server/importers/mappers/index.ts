import type { AnyMapper, Source, TaskMapper, TimeMapper } from "../types";
import { jira } from "./jira";
import { trello } from "./trello";
import { asana } from "./asana";
import { linear } from "./linear";
import { notion } from "./notion";
import { generic } from "./generic";
import { toggl } from "./toggl";
import { clockify } from "./clockify";
import { harvest } from "./harvest";

/**
 * Detection order matters: the first mapper whose score ties the best wins, so
 * the specific formats come before the ones whose header is mostly generic
 * (Notion), and `generic` is last because it recognises everything.
 */
export const MAPPERS: AnyMapper[] = [jira, trello, asana, linear, toggl, clockify, harvest, notion, generic];

export const TASK_MAPPERS = MAPPERS.filter((m): m is TaskMapper => m.kind === "task");
export const TIME_MAPPERS = MAPPERS.filter((m): m is TimeMapper => m.kind === "time");

const BY_SOURCE = new Map<Source, AnyMapper>(MAPPERS.map((m) => [m.source, m]));

export function mapperFor(source: Source): AnyMapper {
  const mapper = BY_SOURCE.get(source);
  if (!mapper) throw new Error(`No importer for source "${source}"`);
  return mapper;
}

export { jira, trello, asana, linear, notion, generic, toggl, clockify, harvest };
