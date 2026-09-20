/**
 * Exit codes, fixed by contract so scripts can branch on them:
 *
 *   0  the command did what it said
 *   1  an error (API refused, network down, task not found, …)
 *   2  usage — unknown command, missing or malformed argument
 *   3  forbidden — the credential is valid but the role is not enough
 */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;
export const EXIT_FORBIDDEN = 3;

/** Bad invocation. Printed with the relevant usage line, exits 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly command?: string,
  ) {
    super(message);
    this.name = "UsageError";
  }
}

/** Anything the user can fix that is not a usage problem. Exits 1. */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/**
 * A non-2xx answer from the API. `code` is the `error` field PTD sends
 * (`forbidden`, `not_found`, `invalid`, `conflict`, `internal`) or a synthetic
 * one for transport failures.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return EXIT_USAGE;
  if (err instanceof ApiError) return err.status === 403 || err.code === "forbidden" ? EXIT_FORBIDDEN : EXIT_ERROR;
  return EXIT_ERROR;
}
