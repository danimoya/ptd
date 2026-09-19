import { Express, Request, Response } from "express";
import { eq, inArray, and, gte, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { timeEntries, customers } from "../db/schema";
import { auth } from "./auth";
import { validate, bulkIdsSchema } from "./validation";
import { resolveWorkspace, WorkspaceRequest } from "./workspaces";

interface BulkDeleteRequest {
  timeEntryIds: number[];
}

interface BulkUpdateRequest {
  timeEntryIds: number[];
  updates: {
    customerId?: number;
    notes?: string;
    isBreak?: boolean;
  };
}

interface BulkExportRequest {
  startDate: string;
  endDate: string;
  customerIds?: number[];
  includeBreaks?: boolean;
}

export function registerBulkOperations(app: Express) {
  // Bulk delete time entries
  app.delete("/api/time-entries/bulk", auth, resolveWorkspace, validate(bulkIdsSchema), async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const { timeEntryIds }: BulkDeleteRequest = req.body;

      if (!timeEntryIds || timeEntryIds.length === 0) {
        return res.status(400).json({ error: "No time entry IDs provided" });
      }

      const entries = await db
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            inArray(timeEntries.id, timeEntryIds)
          )
        );

      if (entries.length !== timeEntryIds.length) {
        return res.status(403).json({
          error: "Some time entries are not in this workspace"
        });
      }

      const deletedEntries = await db
        .delete(timeEntries)
        .where(inArray(timeEntries.id, timeEntryIds))
        .returning();

      res.json({ 
        message: `Successfully deleted ${deletedEntries.length} time entries`,
        deletedCount: deletedEntries.length
      });
    } catch (error) {
      console.error("Bulk delete error:", error);
      res.status(500).json({ error: "Failed to bulk delete time entries" });
    }
  });

  // Bulk update time entries
  app.patch("/api/time-entries/bulk", auth, resolveWorkspace, validate(bulkIdsSchema), async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const { timeEntryIds, updates }: BulkUpdateRequest = req.body;

      if (!timeEntryIds || timeEntryIds.length === 0) {
        return res.status(400).json({ error: "No time entry IDs provided" });
      }

      const entries = await db
        .select({ id: timeEntries.id })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            inArray(timeEntries.id, timeEntryIds)
          )
        );

      if (entries.length !== timeEntryIds.length) {
        return res.status(403).json({
          error: "Some time entries are not in this workspace"
        });
      }

      const updatedEntries = await db
        .update(timeEntries)
        .set({
          ...updates,
          updatedAt: new Date()
        })
        .where(inArray(timeEntries.id, timeEntryIds))
        .returning();

      res.json({ 
        message: `Successfully updated ${updatedEntries.length} time entries`,
        updatedEntries
      });
    } catch (error) {
      console.error("Bulk update error:", error);
      res.status(500).json({ error: "Failed to bulk update time entries" });
    }
  });

  // Bulk export time entries
  app.post("/api/time-entries/export", auth, resolveWorkspace, async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const { startDate, endDate, customerIds, includeBreaks = true }: BulkExportRequest = req.body;

      let query = db
        .select({
          id: timeEntries.id,
          checkIn: timeEntries.checkIn,
          checkOut: timeEntries.checkOut,
          isBreak: timeEntries.isBreak,
          notes: timeEntries.notes,
          customerId: timeEntries.customerId,
          customerName: customers.name
        })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, new Date(startDate)),
            lte(timeEntries.checkIn, new Date(endDate))
          )
        );

      // Add customer filter if provided
      if (customerIds && customerIds.length > 0) {
        query = query.where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, new Date(startDate)),
            lte(timeEntries.checkIn, new Date(endDate)),
            inArray(timeEntries.customerId, customerIds)
          )
        );
      }

      // Add break filter if needed
      if (!includeBreaks) {
        query = query.where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, new Date(startDate)),
            lte(timeEntries.checkIn, new Date(endDate)),
            eq(timeEntries.isBreak, false),
            ...(customerIds && customerIds.length > 0 ? [inArray(timeEntries.customerId, customerIds)] : [])
          )
        );
      }

      const exportData = await query.orderBy(timeEntries.checkIn);

      res.json({
        exportData,
        summary: {
          totalEntries: exportData.length,
          periodStart: startDate,
          periodEnd: endDate,
          includeBreaks,
          filteredCustomers: customerIds?.length || 0
        }
      });
    } catch (error) {
      console.error("Export error:", error);
      res.status(500).json({ error: "Failed to export time entries" });
    }
  });

  // Get time tracking statistics
  app.get("/api/statistics", auth, resolveWorkspace, async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const { startDate, endDate } = req.query;

      const whereClause = [
        eq(timeEntries.workspaceId, wr.workspace.id),
        eq(timeEntries.userId, wr.user[0].id),
      ];
      
      if (startDate) {
        whereClause.push(gte(timeEntries.checkIn, new Date(startDate as string)));
      }
      
      if (endDate) {
        whereClause.push(lte(timeEntries.checkIn, new Date(endDate as string)));
      }

      // Get basic statistics
      const stats = await db
        .select({
          totalEntries: sql<number>`count(*)`,
          workEntries: sql<number>`count(*) filter (where ${timeEntries.isBreak} = false)`,
          breakEntries: sql<number>`count(*) filter (where ${timeEntries.isBreak} = true)`,
          totalMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null 
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `,
          workMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `,
          breakMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = true
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `
        })
        .from(timeEntries)
        .where(and(...whereClause));

      // Get customer breakdown
      const customerStats = await db
        .select({
          customerId: timeEntries.customerId,
          customerName: customers.name,
          totalMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `,
          entryCount: sql<number>`count(*) filter (where ${timeEntries.isBreak} = false)`
        })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(
          and(
            ...whereClause,
            eq(timeEntries.isBreak, false)
          )
        )
        .groupBy(timeEntries.customerId, customers.name)
        .orderBy(sql`total_minutes desc`);

      res.json({
        overview: stats[0],
        customerBreakdown: customerStats
      });
    } catch (error) {
      console.error("Statistics error:", error);
      res.status(500).json({ error: "Failed to fetch statistics" });
    }
  });
}