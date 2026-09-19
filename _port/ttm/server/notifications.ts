import { Express, Request, Response } from "express";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { timeEntries, customers } from "../db/schema";
import { AuthenticatedRequest } from "./types";
import { auth } from "./auth";

interface NotificationRule {
  id: string;
  type: 'daily_goal' | 'weekly_goal' | 'break_reminder' | 'overtime_alert';
  enabled: boolean;
  threshold: number;
  message: string;
}

interface NotificationPreferences {
  dailyGoalMinutes: number;
  weeklyGoalMinutes: number;
  breakReminderInterval: number; // minutes
  overtimeThreshold: number; // minutes
  enableDailyGoal: boolean;
  enableWeeklyGoal: boolean;
  enableBreakReminder: boolean;
  enableOvertimeAlert: boolean;
}

export function registerNotifications(app: Express) {
  // Get active notifications for user
  app.get("/api/notifications", auth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const today = new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);

      // Get today's work time
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
          lastEntryTime: sql<Date>`max(${timeEntries.checkIn})`
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.userId, user[0].id),
            gte(timeEntries.checkIn, todayStart),
            lte(timeEntries.checkIn, todayEnd)
          )
        );

      // Get week's work time
      const weekStart = new Date(today);
      weekStart.setDate(today.getDate() - today.getDay());
      weekStart.setHours(0, 0, 0, 0);

      const weekStats = await db
        .select({
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
            eq(timeEntries.userId, user[0].id),
            gte(timeEntries.checkIn, weekStart)
          )
        );

      // Check for active timer
      const activeEntry = await db
        .select()
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.userId, user[0].id),
            sql`${timeEntries.checkOut} is null`
          )
        )
        .limit(1);

      const notifications = [];
      const todayMinutes = todayStats[0]?.totalMinutes || 0;
      const weekMinutes = weekStats[0]?.totalMinutes || 0;
      const lastEntryTime = todayStats[0]?.lastEntryTime;

      // Daily goal check (assuming 8 hours = 480 minutes)
      if (todayMinutes >= 480) {
        notifications.push({
          id: 'daily_goal_reached',
          type: 'success',
          title: 'Daily Goal Reached!',
          message: `You've completed ${Math.round(todayMinutes / 60 * 10) / 10} hours today. Great work!`,
          timestamp: new Date()
        });
      } else if (todayMinutes >= 360) { // 6 hours
        notifications.push({
          id: 'daily_goal_progress',
          type: 'info',
          title: 'Making Progress',
          message: `${Math.round((480 - todayMinutes) / 60 * 10) / 10} hours left to reach your daily goal.`,
          timestamp: new Date()
        });
      }

      // Break reminder (if working for more than 2 hours without break)
      if (activeEntry.length > 0 && !activeEntry[0].isBreak) {
        const workStartTime = new Date(activeEntry[0].checkIn);
        const minutesWorking = (Date.now() - workStartTime.getTime()) / (1000 * 60);
        
        if (minutesWorking > 120) { // 2 hours
          notifications.push({
            id: 'break_reminder',
            type: 'warning',
            title: 'Take a Break',
            message: `You've been working for ${Math.round(minutesWorking / 60 * 10) / 10} hours. Consider taking a short break.`,
            timestamp: new Date()
          });
        }
      }

      // Overtime alert (more than 10 hours today)
      if (todayMinutes > 600) {
        notifications.push({
          id: 'overtime_alert',
          type: 'warning',
          title: 'Overtime Alert',
          message: `You've worked ${Math.round(todayMinutes / 60 * 10) / 10} hours today. Don't forget to rest!`,
          timestamp: new Date()
        });
      }

      // Weekly goal progress
      const weeklyGoal = 2400; // 40 hours
      if (weekMinutes >= weeklyGoal) {
        notifications.push({
          id: 'weekly_goal_reached',
          type: 'success',
          title: 'Weekly Goal Achieved!',
          message: `You've completed ${Math.round(weekMinutes / 60 * 10) / 10} hours this week!`,
          timestamp: new Date()
        });
      }

      res.json({
        notifications,
        stats: {
          todayMinutes,
          weekMinutes,
          hasActiveTimer: activeEntry.length > 0
        }
      });
    } catch (error) {
      console.error("Notifications error:", error);
      res.status(500).json({ error: "Failed to fetch notifications" });
    }
  });

  // Dismiss notification
  app.delete("/api/notifications/:id", auth, async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      
      // In a real app, you'd store dismissed notifications in the database
      // For now, we'll just acknowledge the dismissal
      res.json({ message: `Notification ${id} dismissed` });
    } catch (error) {
      console.error("Dismiss notification error:", error);
      res.status(500).json({ error: "Failed to dismiss notification" });
    }
  });

  // Get productivity insights
  app.get("/api/insights", auth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { days = 30 } = req.query;
      
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - Number(days));

      // Get productivity trends
      const dailyStats = await db
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
          entryCount: sql<number>`count(*) filter (where ${timeEntries.isBreak} = false)`
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.userId, user[0].id),
            gte(timeEntries.checkIn, startDate)
          )
        )
        .groupBy(sql`date(${timeEntries.checkIn})`)
        .orderBy(sql`date(${timeEntries.checkIn})`);

      // Get hourly productivity pattern
      const hourlyPattern = await db
        .select({
          hour: sql<number>`extract(hour from ${timeEntries.checkIn})`,
          avgMinutes: sql<number>`
            avg(
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
        .where(
          and(
            eq(timeEntries.userId, user[0].id),
            gte(timeEntries.checkIn, startDate),
            eq(timeEntries.isBreak, false)
          )
        )
        .groupBy(sql`extract(hour from ${timeEntries.checkIn})`)
        .orderBy(sql`extract(hour from ${timeEntries.checkIn})`);

      // Calculate insights
      const totalWorkMinutes = dailyStats.reduce((sum, day) => sum + (day.totalMinutes || 0), 0);
      const avgDailyMinutes = totalWorkMinutes / dailyStats.length;
      const mostProductiveHour = hourlyPattern.reduce((max, hour) => 
        (hour.avgMinutes || 0) > (max.avgMinutes || 0) ? hour : max, hourlyPattern[0]);

      const insights = {
        summary: {
          totalWorkHours: Math.round(totalWorkMinutes / 60 * 10) / 10,
          avgDailyHours: Math.round(avgDailyMinutes / 60 * 10) / 10,
          mostProductiveHour: mostProductiveHour?.hour || 9,
          daysAnalyzed: dailyStats.length
        },
        trends: dailyStats,
        hourlyPattern,
        recommendations: [
          avgDailyMinutes < 480 ? 'Consider setting daily time goals to improve consistency' : null,
          mostProductiveHour && mostProductiveHour.hour > 10 ? 'You seem most productive later in the day' : 'You appear to be a morning person!',
          'Take regular breaks to maintain productivity throughout the day'
        ].filter(Boolean)
      };

      res.json(insights);
    } catch (error) {
      console.error("Insights error:", error);
      res.status(500).json({ error: "Failed to fetch insights" });
    }
  });
}