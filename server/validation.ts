import { Request, Response, NextFunction } from "express";
import { z, ZodSchema } from "zod";

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

export const emailSchema = z.string().email().max(255);
export const passwordSchema = z.string().min(6).max(255);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(255),
});

export const createCustomerSchema = z.object({
  name: z.string().min(1).max(255),
  weeklyGoalHours: z.number().int().min(0).max(168).optional().nullable(),
  billingAddress: z.string().max(2000).optional().nullable(),
  billingEmail: z.string().email().max(255).optional().nullable().or(z.literal("")),
});

export const updateCustomerSchema = createCustomerSchema.partial();

export const createTimeEntrySchema = z.object({
  isBreak: z.boolean(),
  customerId: z.number().int().positive().optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  taskId: z.number().int().positive().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  // Optional past-tense entries used by integrations: pass both checkIn
  // and checkOut to log a completed session retroactively.
  checkIn: z.string().datetime().optional(),
  checkOut: z.string().datetime().optional(),
});

export const updateTimeEntrySchema = z.object({
  checkOut: z.string().datetime().optional(),
  customerId: z.number().int().positive().optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  taskId: z.number().int().positive().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  isBreak: z.boolean().optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1).max(255),
  customerId: z.number().int().positive().optional().nullable(),
  color: z
    .string()
    .regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
    .max(16)
    .optional()
    .nullable()
    .or(z.literal("")),
  archived: z.boolean().optional(),
});

export const updateProjectSchema = createProjectSchema.partial();

export const invoiceSchema = z.object({
  customerId: z.number().int().positive(),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
});

export const idParamSchema = z.object({
  id: z.string().regex(/^\d+$/).transform(Number),
});

export const bulkIdsSchema = z.object({
  timeEntryIds: z.array(z.number().int().positive()).min(1).max(500),
  updates: z
    .object({
      customerId: z.number().int().positive().optional().nullable(),
      notes: z.string().max(2000).optional().nullable(),
      isBreak: z.boolean().optional(),
    })
    .optional(),
});

export const dateRangeSchema = z.object({
  startDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)),
  endDate: z.string().datetime().or(z.string().regex(/^\d{4}-\d{2}-\d{2}/)),
  groupBy: z.enum(["day", "week", "month"]).optional(),
  includeBreaks: z.boolean().optional(),
  customerIds: z.array(z.number().int().positive()).optional(),
});

export const compareReportSchema = z.object({
  current: dateRangeSchema.pick({ startDate: true, endDate: true }),
  previous: dateRangeSchema.pick({ startDate: true, endDate: true }),
  groupBy: z.enum(["day", "week", "month"]).optional(),
});

export const createTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  customerId: z.number().int().positive().optional().nullable(),
  projectId: z.number().int().positive().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  icon: z
    .string()
    .max(32)
    .regex(/^[a-z0-9-]+$/i)
    .optional()
    .nullable()
    .or(z.literal("")),
  isBreak: z.boolean().optional(),
});

export const updateTemplateSchema = createTemplateSchema.partial();
