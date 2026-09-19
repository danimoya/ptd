import { Express, Request, Response } from "express";
import { eq, and, or, like, gte, lte, sql, desc, asc } from "drizzle-orm";
import { db } from "../db";
import { timeEntries, customers } from "../db/schema";
import { auth } from "./auth";
import { resolveWorkspace, WorkspaceRequest } from "./workspaces";
import { validate, dateRangeSchema, compareReportSchema } from "./validation";

interface SearchRequest {
  query?: string;
  dateFrom?: string;
  dateTo?: string;
  customerId?: number;
  isBreak?: boolean;
  minDuration?: number;
  maxDuration?: number;
  sortBy?: 'date' | 'duration' | 'customer';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

interface DashboardData {
  todayStats: {
    totalMinutes: number;
    breakMinutes: number;
    activeTimer: any;
    completedTasks: number;
  };
  weekStats: {
    totalMinutes: number;
    dailyAverage: number;
    peakDay: string;
    goalProgress: number;
  };
  recentActivity: any[];
  topCustomers: any[];
}

export function registerAdvancedFeatures(app: Express) {
  // Advanced search and filtering
  app.post("/api/search", auth, resolveWorkspace, async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const {
        query,
        dateFrom,
        dateTo,
        customerId,
        isBreak,
        minDuration,
        maxDuration,
        sortBy = 'date',
        sortOrder = 'desc',
        page = 1,
        limit = 20
      }: SearchRequest = req.body;

      let searchQuery = db
        .select({
          id: timeEntries.id,
          checkIn: timeEntries.checkIn,
          checkOut: timeEntries.checkOut,
          isBreak: timeEntries.isBreak,
          notes: timeEntries.notes,
          customerId: timeEntries.customerId,
          customerName: customers.name,
          duration: sql<number>`
            case 
              when ${timeEntries.checkOut} is not null 
              then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
              else 0
            end
          `
        })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id)
          )
        );

      // Build filters
      const filters = [
        eq(timeEntries.workspaceId, wr.workspace.id),
        eq(timeEntries.userId, wr.user[0].id),
      ];

      if (query) {
        filters.push(
          or(
            like(timeEntries.notes, `%${query}%`),
            like(customers.name, `%${query}%`)
          )
        );
      }

      if (dateFrom) {
        filters.push(gte(timeEntries.checkIn, new Date(dateFrom)));
      }

      if (dateTo) {
        filters.push(lte(timeEntries.checkIn, new Date(dateTo)));
      }

      if (customerId) {
        filters.push(eq(timeEntries.customerId, customerId));
      }

      if (typeof isBreak === 'boolean') {
        filters.push(eq(timeEntries.isBreak, isBreak));
      }

      searchQuery = searchQuery.where(and(...filters));

      // Apply sorting
      const sortColumn = sortBy === 'date' 
        ? timeEntries.checkIn 
        : sortBy === 'customer' 
        ? customers.name 
        : sql`duration`;
      
      searchQuery = searchQuery.orderBy(
        sortOrder === 'asc' ? asc(sortColumn) : desc(sortColumn)
      );

      // Apply pagination
      const offset = (page - 1) * limit;
      const results = await searchQuery.limit(limit).offset(offset);

      // Get total count
      const totalCountQuery = await db
        .select({ count: sql<number>`count(*)` })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(and(...filters));

      const totalCount = totalCountQuery[0].count;
      const totalPages = Math.ceil(totalCount / limit);

      // Filter by duration if specified
      let filteredResults = results;
      if (minDuration || maxDuration) {
        filteredResults = results.filter(entry => {
          const duration = entry.duration || 0;
          return (!minDuration || duration >= minDuration) &&
                 (!maxDuration || duration <= maxDuration);
        });
      }

      res.json({
        results: filteredResults,
        pagination: {
          page,
          limit,
          totalCount,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1
        },
        filters: {
          query,
          dateFrom,
          dateTo,
          customerId,
          isBreak,
          minDuration,
          maxDuration
        }
      });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Failed to search time entries" });
    }
  });

  // Real-time dashboard data
  app.get("/api/dashboard", auth, resolveWorkspace, async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);

      // Today's statistics
      const todayStats = await db
        .select({
          totalMinutes: sql<number>`
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
          `,
          completedTasks: sql<number>`count(*) filter (where ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false)`
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, todayStart),
            lte(timeEntries.checkIn, todayEnd)
          )
        );

      // Active timer
      const activeTimer = await db
        .select({
          id: timeEntries.id,
          checkIn: timeEntries.checkIn,
          isBreak: timeEntries.isBreak,
          customerId: timeEntries.customerId,
          customerName: customers.name
        })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            sql`${timeEntries.checkOut} is null`
          )
        )
        .limit(1);

      // Week statistics
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      weekStart.setHours(0, 0, 0, 0);

      const weekStats = await db
        .select({
          date: sql<string>`date(${timeEntries.checkIn})`,
          totalMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, weekStart)
          )
        )
        .groupBy(sql`date(${timeEntries.checkIn})`)
        .orderBy(sql`date(${timeEntries.checkIn})`);

      // Recent activity (last 10 entries)
      const recentActivity = await db
        .select({
          id: timeEntries.id,
          checkIn: timeEntries.checkIn,
          checkOut: timeEntries.checkOut,
          isBreak: timeEntries.isBreak,
          customerName: customers.name,
          duration: sql<number>`
            case 
              when ${timeEntries.checkOut} is not null 
              then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
              else 0
            end
          `
        })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id)
          )
        )
        .orderBy(desc(timeEntries.checkIn))
        .limit(10);

      // Top customers by time spent
      const topCustomers = await db
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
          sessionCount: sql<number>`count(*) filter (where ${timeEntries.isBreak} = false)`
        })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, weekStart),
            eq(timeEntries.isBreak, false)
          )
        )
        .groupBy(timeEntries.customerId, customers.name)
        .orderBy(desc(sql`total_minutes`))
        .limit(5);

      const weekTotalMinutes = weekStats.reduce((sum, day) => sum + (day.totalMinutes || 0), 0);
      const dailyAverage = weekTotalMinutes / Math.max(1, weekStats.length);
      const peakDay = weekStats.reduce((peak, day) => 
        (day.totalMinutes || 0) > (peak.totalMinutes || 0) ? day : peak, 
        weekStats[0] || { date: 'N/A', totalMinutes: 0 }
      );

      const dashboardData: DashboardData = {
        todayStats: {
          totalMinutes: todayStats[0]?.totalMinutes || 0,
          breakMinutes: todayStats[0]?.breakMinutes || 0,
          activeTimer: activeTimer[0] || null,
          completedTasks: todayStats[0]?.completedTasks || 0
        },
        weekStats: {
          totalMinutes: weekTotalMinutes,
          dailyAverage,
          peakDay: peakDay.date,
          goalProgress: Math.min(100, (weekTotalMinutes / 2400) * 100) // 40 hours goal
        },
        recentActivity,
        topCustomers
      };

      res.json(dashboardData);
    } catch (error) {
      console.error("Dashboard error:", error);
      res.status(500).json({ error: "Failed to fetch dashboard data" });
    }
  });

  // Advanced time tracking patterns
  app.get("/api/patterns", auth, resolveWorkspace, async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const { days = 30 } = req.query;
      
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - Number(days));

      // Work patterns by hour
      const hourlyPatterns = await db
        .select({
          hour: sql<number>`extract(hour from ${timeEntries.checkIn})`,
          avgDuration: sql<number>`
            avg(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `,
          sessionCount: sql<number>`count(*) filter (where ${timeEntries.isBreak} = false)`,
          totalMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, startDate)
          )
        )
        .groupBy(sql`extract(hour from ${timeEntries.checkIn})`)
        .orderBy(sql`extract(hour from ${timeEntries.checkIn})`);

      // Day of week patterns
      const weekdayPatterns = await db
        .select({
          dayOfWeek: sql<number>`extract(dow from ${timeEntries.checkIn})`,
          dayName: sql<string>`
            case extract(dow from ${timeEntries.checkIn})
              when 0 then 'Sunday'
              when 1 then 'Monday'
              when 2 then 'Tuesday'
              when 3 then 'Wednesday'
              when 4 then 'Thursday'
              when 5 then 'Friday'
              when 6 then 'Saturday'
            end
          `,
          avgDuration: sql<number>`
            avg(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `,
          totalMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, startDate),
            eq(timeEntries.isBreak, false)
          )
        )
        .groupBy(sql`extract(dow from ${timeEntries.checkIn})`)
        .orderBy(sql`extract(dow from ${timeEntries.checkIn})`);

      // Break patterns
      const breakPatterns = await db
        .select({
          avgBreakDuration: sql<number>`
            avg(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = true
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `,
          breakFrequency: sql<number>`
            count(*) filter (where ${timeEntries.isBreak} = true) / 
            count(distinct date(${timeEntries.checkIn}))::float
          `,
          totalBreakTime: sql<number>`
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
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, startDate)
          )
        );

      res.json({
        hourlyPatterns,
        weekdayPatterns,
        breakPatterns: breakPatterns[0],
        analysis: {
          mostProductiveHour: hourlyPatterns.reduce((max, hour) => 
            (hour.totalMinutes || 0) > (max.totalMinutes || 0) ? hour : max, 
            hourlyPatterns[0] || {}
          ),
          mostProductiveDay: weekdayPatterns.reduce((max, day) => 
            (day.totalMinutes || 0) > (max.totalMinutes || 0) ? day : max, 
            weekdayPatterns[0] || {}
          ),
          recommendedBreakInterval: Math.max(90, Math.min(180, breakPatterns[0]?.avgBreakDuration * 8 || 120))
        }
      });
    } catch (error) {
      console.error("Patterns error:", error);
      res.status(500).json({ error: "Failed to fetch patterns data" });
    }
  });

  // Period comparison: current vs previous range
  app.post("/api/reports/compare", auth, resolveWorkspace, validate(compareReportSchema), async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const { current, previous } = req.body as {
        current: { startDate: string; endDate: string };
        previous: { startDate: string; endDate: string };
      };

      const summarize = async (start: string, end: string) => {
        const rows = await db
          .select({
            workMinutes: sql<number>`coalesce(sum(case when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60 else 0 end), 0)`,
            breakMinutes: sql<number>`coalesce(sum(case when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = true then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60 else 0 end), 0)`,
            sessions: sql<number>`count(*) filter (where ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false)`,
            activeDays: sql<number>`count(distinct date(${timeEntries.checkIn})) filter (where ${timeEntries.isBreak} = false)`,
          })
          .from(timeEntries)
          .where(
            and(
              eq(timeEntries.workspaceId, wr.workspace.id),
              eq(timeEntries.userId, wr.user[0].id),
              gte(timeEntries.checkIn, new Date(start)),
              lte(timeEntries.checkIn, new Date(end))
            )
          );
        const r = rows[0] || { workMinutes: 0, breakMinutes: 0, sessions: 0, activeDays: 0 };
        return {
          workMinutes: Number(r.workMinutes) || 0,
          breakMinutes: Number(r.breakMinutes) || 0,
          sessions: Number(r.sessions) || 0,
          activeDays: Number(r.activeDays) || 0,
        };
      };

      const [cur, prev] = await Promise.all([
        summarize(current.startDate, current.endDate),
        summarize(previous.startDate, previous.endDate),
      ]);

      const pct = (a: number, b: number) => (b > 0 ? ((a - b) / b) * 100 : a > 0 ? 100 : 0);

      res.json({
        current: cur,
        previous: prev,
        delta: {
          workMinutes: cur.workMinutes - prev.workMinutes,
          breakMinutes: cur.breakMinutes - prev.breakMinutes,
          sessions: cur.sessions - prev.sessions,
          activeDays: cur.activeDays - prev.activeDays,
        },
        deltaPct: {
          workMinutes: pct(cur.workMinutes, prev.workMinutes),
          breakMinutes: pct(cur.breakMinutes, prev.breakMinutes),
          sessions: pct(cur.sessions, prev.sessions),
          activeDays: pct(cur.activeDays, prev.activeDays),
        },
      });
    } catch (error) {
      console.error("Compare error:", error);
      res.status(500).json({ error: "Failed to compare periods" });
    }
  });

  // Enhanced reporting with custom date ranges
  app.post("/api/reports/custom", auth, resolveWorkspace, validate(dateRangeSchema), async (req: Request, res: Response) => {
    try {
      const wr = req as WorkspaceRequest;
      const { startDate, endDate, groupBy = 'day', includeBreaks = false } = req.body;

      const groupByClause = groupBy === 'week' 
        ? sql`date_trunc('week', ${timeEntries.checkIn})`
        : groupBy === 'month'
        ? sql`date_trunc('month', ${timeEntries.checkIn})`
        : sql`date(${timeEntries.checkIn})`;

      const reportData = await db
        .select({
          period: groupByClause,
          workMinutes: sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          `,
          breakMinutes: includeBreaks ? sql<number>`
            sum(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = true
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else 0
              end
            )
          ` : sql<number>`0`,
          sessionCount: sql<number>`count(*) filter (where ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false)`,
          avgSessionLength: sql<number>`
            avg(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else null
              end
            )
          `
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, new Date(startDate)),
            lte(timeEntries.checkIn, new Date(endDate))
          )
        )
        .groupBy(groupByClause)
        .orderBy(groupByClause);

      // Customer breakdown for the period
      const customerBreakdown = await db
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
          sessionCount: sql<number>`count(*) filter (where ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false)`,
          avgSessionLength: sql<number>`
            avg(
              case 
                when ${timeEntries.checkOut} is not null and ${timeEntries.isBreak} = false
                then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
                else null
              end
            )
          `
        })
        .from(timeEntries)
        .leftJoin(customers, eq(timeEntries.customerId, customers.id))
        .where(
          and(
            eq(timeEntries.workspaceId, wr.workspace.id),
            eq(timeEntries.userId, wr.user[0].id),
            gte(timeEntries.checkIn, new Date(startDate)),
            lte(timeEntries.checkIn, new Date(endDate)),
            eq(timeEntries.isBreak, false)
          )
        )
        .groupBy(timeEntries.customerId, customers.name)
        .orderBy(desc(sql`total_minutes`));

      const totalWorkMinutes = reportData.reduce((sum, period) => sum + (period.workMinutes || 0), 0);
      const totalBreakMinutes = reportData.reduce((sum, period) => sum + (period.breakMinutes || 0), 0);

      res.json({
        reportData,
        customerBreakdown,
        summary: {
          totalWorkHours: Math.round(totalWorkMinutes / 60 * 100) / 100,
          totalBreakHours: Math.round(totalBreakMinutes / 60 * 100) / 100,
          avgDailyHours: Math.round((totalWorkMinutes / reportData.length / 60) * 100) / 100,
          totalSessions: reportData.reduce((sum, period) => sum + (period.sessionCount || 0), 0),
          period: { startDate, endDate, groupBy }
        }
      });
    } catch (error) {
      console.error("Custom report error:", error);
      res.status(500).json({ error: "Failed to generate custom report" });
    }
  });
}