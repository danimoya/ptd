import {
  clearLinkFailures as clearShared,
  consumeLinkCode as consumeShared,
  linkAttemptsBlocked as blockedShared,
  mintLinkCode as mintShared,
  peekLinkCode as peekShared,
  pruneLinkCodes as pruneShared,
  recordLinkFailure as recordShared,
  resetLinkState as resetShared,
  type LinkCodeEntry,
  type MintedLinkCode,
} from "../shared/linkCodes";
import { SLACK_PROVIDER } from "../shared/providers";

/**
 * One-time codes that bind a Slack user to a PTD user.
 *
 * The store moved to `../shared/linkCodes` when Telegram and Teams arrived — same
 * ten-minute, single-use, in-memory codes, now keyed by provider so a Telegram code
 * cannot be spent in Slack. This module is the Slack-flavoured door onto it: every
 * function here is the shared one with `provider = "slack"` already filled in.
 */

export {
  LINK_CODE_LENGTH,
  LINK_CODE_TTL_MS,
  MAX_LINK_FAILURES,
  normaliseCode,
  type LinkCodeEntry,
  type MintedLinkCode,
} from "../shared/linkCodes";

export const pruneLinkCodes = (now?: number): void => pruneShared(SLACK_PROVIDER, now);

/** A fresh code for one PTD user in one org. Any previous Slack code of theirs is dropped. */
export const mintLinkCode = (input: { userId: number; orgId: number; displayName: string }, now?: number): MintedLinkCode =>
  mintShared(SLACK_PROVIDER, input, now);

export const peekLinkCode = (raw: string, now?: number): LinkCodeEntry | null => peekShared(SLACK_PROVIDER, raw, now);

export const consumeLinkCode = (raw: string, now?: number): LinkCodeEntry | null => consumeShared(SLACK_PROVIDER, raw, now);

export const recordLinkFailure = (key: string, now?: number): { failures: number; blocked: boolean } =>
  recordShared(SLACK_PROVIDER, key, now);

export const linkAttemptsBlocked = (key: string, now?: number): boolean => blockedShared(SLACK_PROVIDER, key, now);

export const clearLinkFailures = (key: string): void => clearShared(SLACK_PROVIDER, key);

/** Test-only reset of the Slack provider's codes and failures. */
export const resetLinkState = (): void => resetShared(SLACK_PROVIDER);
