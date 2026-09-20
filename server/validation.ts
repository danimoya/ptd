import { Request, Response, NextFunction } from "express";
import { z, ZodSchema } from "zod";

/**
 * Body/query/param validation for the hand-written REST routes (auth, orgs,
 * tokens, the track picker feed). Everything that goes through the action
 * registry validates from the action's own `input` schema instead — that schema
 * is also what the MCP manifest publishes, so there is exactly one description
 * of each call's arguments.
 *
 * This file used to carry a parallel set of the original tracker schemas — projects,
 * invoices, reports, bulk edits, and a second copy of the register/login rules
 * whose password minimum had already drifted out of step with auth.ts. They are
 * gone: `projects` no longer exists (streams replaced it), invoices and reports
 * are Phase 2, and a duplicated rule that disagrees with the real one is worse
 * than no rule.
 */
export function validate<T extends ZodSchema>(
  schema: T,
  source: "body" | "query" | "params" = "body"
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.flatten(),
      });
    }
    (req as any)[source] = result.data;
    next();
  };
}

/** `:id` in a path, as a number. */
export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/).transform(Number),
});

/** An ISO-8601 datetime or a bare calendar day, the two forms the track surface accepts. */
export const whenSchema = z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

/** `?from=&to=` on a list endpoint. */
export const windowSchema = z.object({
  from: whenSchema.optional(),
  to: whenSchema.optional(),
});
