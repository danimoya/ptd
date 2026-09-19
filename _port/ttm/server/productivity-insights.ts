import { Express, Request, Response } from "express";
import { eq, and, gte, lte, sql, desc } from "drizzle-orm";
import { db } from "../db";
import { timeEntries, customers } from "../db/schema";
import { AuthenticatedRequest } from "./types";
import { getWebSocketManager } from "./websocket";
import { auth } from "./auth";

interface ProductivityInsight {
  id: string;
  type: 'goal_achievement' | 'break_reminder' | 'focus_session' | 'weekly_summary' | 'efficiency_tip';
  title: string;
  message: string;
  priority: 'low' | 'medium' | 'high' | 'success';
  actionable: boolean;
  data?: any;
  createdAt: string;
}

interface WorkSessionAnalysis {
  averageSessionLength: number;
  totalWorkTime: number;
  breakFrequency: number;
  peakProductivityHours: number[];
  weeklyTrend: 'improving' | 'declining' | 'stable';
  consistencyScore: number;
}

export class ProductivityInsightsEngine {
  private wsManager = getWebSocketManager();

  async analyzeUserProductivity(userId: number, days: number = 7): Promise<WorkSessionAnalysis> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get work sessions
    const workSessions = await db
      .select({
        checkIn: timeEntries.checkIn,
        checkOut: timeEntries.checkOut,
        isBreak: timeEntries.isBreak,
        duration: sql<number>`
          case 
            when ${timeEntries.checkOut} is not null 
            then extract(epoch from (${timeEntries.checkOut} - ${timeEntries.checkIn}))/60
            else 0
          end
        `,
        hour: sql<number>`extract(hour from ${timeEntries.checkIn})`
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.userId, userId),
          gte(timeEntries.checkIn, startDate),
          sql`${timeEntries.checkOut} is not null`
        )
      )
      .orderBy(desc(timeEntries.checkIn));

    const workOnlySessions = workSessions.filter(s => !s.isBreak);
    const breakSessions = workSessions.filter(s => s.isBreak);

    // Calculate metrics
    const totalWorkTime = workOnlySessions.reduce((sum, s) => sum + (s.duration || 0), 0);
    const averageSessionLength = workOnlySessions.length > 0 
      ? totalWorkTime / workOnlySessions.length 
      : 0;

    // Peak productivity hours (top 3 hours with most work time)
    const hourlyTotals = workOnlySessions.reduce((acc, session) => {
      const hour = session.hour || 0;
      acc[hour] = (acc[hour] || 0) + (session.duration || 0);
      return acc;
    }, {} as Record<number, number>);

    const peakProductivityHours = Object.entries(hourlyTotals)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([hour]) => parseInt(hour));

    // Break frequency (breaks per day)
    const uniqueDays = new Set(breakSessions.map(s => 
      s.checkIn.toISOString().split('T')[0]
    )).size;
    const breakFrequency = uniqueDays > 0 ? breakSessions.length / uniqueDays : 0;

    // Weekly trend analysis (compare first half vs second half of period)
    const midPoint = new Date(startDate.getTime() + (Date.now() - startDate.getTime()) / 2);
    const firstHalfSessions = workOnlySessions.filter(s => s.checkIn < midPoint);
    const secondHalfSessions = workOnlySessions.filter(s => s.checkIn >= midPoint);

    const firstHalfAvg = firstHalfSessions.length > 0 
      ? firstHalfSessions.reduce((sum, s) => sum + (s.duration || 0), 0) / firstHalfSessions.length 
      : 0;
    const secondHalfAvg = secondHalfSessions.length > 0 
      ? secondHalfSessions.reduce((sum, s) => sum + (s.duration || 0), 0) / secondHalfSessions.length 
      : 0;

    let weeklyTrend: 'improving' | 'declining' | 'stable' = 'stable';
    const trendThreshold = 0.1; // 10% change
    
    if (secondHalfAvg > firstHalfAvg * (1 + trendThreshold)) {
      weeklyTrend = 'improving';
    } else if (secondHalfAvg < firstHalfAvg * (1 - trendThreshold)) {
      weeklyTrend = 'declining';
    }

    // Consistency score (based on standard deviation of daily work times)
    const dailyTotals = workOnlySessions.reduce((acc, session) => {
      const day = session.checkIn.toISOString().split('T')[0];
      acc[day] = (acc[day] || 0) + (session.duration || 0);
      return acc;
    }, {} as Record<string, number>);

    const dailyValues = Object.values(dailyTotals);
    const avgDaily = dailyValues.reduce((sum, val) => sum + val, 0) / Math.max(1, dailyValues.length);
    const variance = dailyValues.reduce((sum, val) => sum + Math.pow(val - avgDaily, 2), 0) / Math.max(1, dailyValues.length);
    const stdDev = Math.sqrt(variance);
    const consistencyScore = Math.max(0, Math.min(100, 100 - (stdDev / avgDaily * 100)));

    return {
      averageSessionLength,
      totalWorkTime,
      breakFrequency,
      peakProductivityHours,
      weeklyTrend,
      consistencyScore
    };
  }

  async generateInsights(userId: number): Promise<ProductivityInsight[]> {
    const analysis = await this.analyzeUserProductivity(userId);
    const insights: ProductivityInsight[] = [];

    // Goal achievement insights
    const dailyGoal = 8 * 60; // 8 hours in minutes
    const todayWork = await this.getTodayWorkTime(userId);
    
    if (todayWork >= dailyGoal) {
      insights.push({
        id: `goal-${Date.now()}`,
        type: 'goal_achievement',
        title: 'Daily Goal Achieved! 🎯',
        message: `Congratulations! You've completed ${Math.round(todayWork / 60 * 10) / 10} hours of focused work today.`,
        priority: 'success',
        actionable: false,
        data: { workTime: todayWork, goal: dailyGoal },
        createdAt: new Date().toISOString()
      });
    } else if (todayWork >= dailyGoal * 0.8) {
      insights.push({
        id: `progress-${Date.now()}`,
        type: 'goal_achievement',
        title: 'Almost There!',
        message: `You're ${Math.round((dailyGoal - todayWork) / 60 * 10) / 10} hours away from your daily goal.`,
        priority: 'medium',
        actionable: true,
        data: { remaining: dailyGoal - todayWork },
        createdAt: new Date().toISOString()
      });
    }

    // Break reminder insights
    if (analysis.breakFrequency < 2) {
      insights.push({
        id: `break-${Date.now()}`,
        type: 'break_reminder',
        title: 'Take More Breaks',
        message: 'Regular breaks can improve focus and prevent burnout. Try taking a 15-minute break every 90 minutes.',
        priority: 'medium',
        actionable: true,
        data: { currentFrequency: analysis.breakFrequency, recommended: 3 },
        createdAt: new Date().toISOString()
      });
    }

    // Focus session insights
    if (analysis.averageSessionLength > 120) {
      insights.push({
        id: `focus-${Date.now()}`,
        type: 'focus_session',
        title: 'Excellent Focus!',
        message: `Your average work session is ${Math.round(analysis.averageSessionLength)} minutes. You're maintaining great concentration.`,
        priority: 'success',
        actionable: false,
        data: { sessionLength: analysis.averageSessionLength },
        createdAt: new Date().toISOString()
      });
    } else if (analysis.averageSessionLength < 45) {
      insights.push({
        id: `focus-improve-${Date.now()}`,
        type: 'focus_session',
        title: 'Boost Your Focus',
        message: 'Your work sessions are quite short. Try using the Pomodoro technique: 25 minutes of focused work followed by a 5-minute break.',
        priority: 'medium',
        actionable: true,
        data: { currentLength: analysis.averageSessionLength, suggested: 25 },
        createdAt: new Date().toISOString()
      });
    }

    // Efficiency tips based on peak hours
    if (analysis.peakProductivityHours.length > 0) {
      const peakHour = analysis.peakProductivityHours[0];
      const timeOfDay = peakHour < 12 ? 'morning' : peakHour < 17 ? 'afternoon' : 'evening';
      
      insights.push({
        id: `efficiency-${Date.now()}`,
        type: 'efficiency_tip',
        title: `Your Peak ${timeOfDay.charAt(0).toUpperCase() + timeOfDay.slice(1)} Hours`,
        message: `You're most productive around ${peakHour}:00. Schedule your most important tasks during this time.`,
        priority: 'low',
        actionable: true,
        data: { peakHour, timeOfDay, peakHours: analysis.peakProductivityHours },
        createdAt: new Date().toISOString()
      });
    }

    // Weekly trend insights
    if (analysis.weeklyTrend === 'improving') {
      insights.push({
        id: `trend-${Date.now()}`,
        type: 'weekly_summary',
        title: 'Upward Trend! 📈',
        message: 'Your productivity has been improving this week. Keep up the great work!',
        priority: 'success',
        actionable: false,
        data: { trend: analysis.weeklyTrend, consistencyScore: analysis.consistencyScore },
        createdAt: new Date().toISOString()
      });
    } else if (analysis.weeklyTrend === 'declining') {
      insights.push({
        id: `trend-decline-${Date.now()}`,
        type: 'weekly_summary',
        title: 'Productivity Dip',
        message: 'Your productivity has decreased this week. Consider reviewing your schedule and taking breaks.',
        priority: 'medium',
        actionable: true,
        data: { trend: analysis.weeklyTrend, suggestion: 'schedule_review' },
        createdAt: new Date().toISOString()
      });
    }

    // Consistency insights
    if (analysis.consistencyScore > 80) {
      insights.push({
        id: `consistency-${Date.now()}`,
        type: 'weekly_summary',
        title: 'Consistent Performance',
        message: `You maintain excellent consistency with a ${Math.round(analysis.consistencyScore)}% score. This stability is key to long-term success.`,
        priority: 'success',
        actionable: false,
        data: { consistencyScore: analysis.consistencyScore },
        createdAt: new Date().toISOString()
      });
    } else if (analysis.consistencyScore < 60) {
      insights.push({
        id: `consistency-improve-${Date.now()}`,
        type: 'efficiency_tip',
        title: 'Improve Consistency',
        message: 'Your work patterns vary significantly. Try establishing a regular routine to improve consistency.',
        priority: 'medium',
        actionable: true,
        data: { consistencyScore: analysis.consistencyScore, recommendation: 'routine' },
        createdAt: new Date().toISOString()
      });
    }

    return insights;
  }

  private async getTodayWorkTime(userId: number): Promise<number> {
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const result = await db
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
          eq(timeEntries.userId, userId),
          gte(timeEntries.checkIn, todayStart),
          lte(timeEntries.checkIn, todayEnd)
        )
      );

    return result[0]?.totalMinutes || 0;
  }

  async sendInsightsToUser(userId: number): Promise<void> {
    const insights = await this.generateInsights(userId);
    
    if (this.wsManager && insights.length > 0) {
      // Send high priority insights immediately
      const highPriorityInsights = insights.filter(i => i.priority === 'high' || i.priority === 'success');
      
      for (const insight of highPriorityInsights) {
        this.wsManager.sendNotification(userId, {
          type: 'productivity_insight',
          ...insight
        });
      }
    }
  }
}

export function registerProductivityInsights(app: Express) {
  const insightsEngine = new ProductivityInsightsEngine();

  // Get productivity insights
  app.get("/api/insights", auth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const insights = await insightsEngine.generateInsights(user[0].id);
      
      res.json({ insights });
    } catch (error) {
      console.error("Insights error:", error);
      res.status(500).json({ error: "Failed to generate insights" });
    }
  });

  // Get detailed productivity analysis
  app.get("/api/productivity-analysis", auth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const { days = 7 } = req.query;
      
      const analysis = await insightsEngine.analyzeUserProductivity(
        user[0].id, 
        parseInt(days as string)
      );
      
      res.json({ analysis });
    } catch (error) {
      console.error("Analysis error:", error);
      res.status(500).json({ error: "Failed to analyze productivity" });
    }
  });

  // Trigger insight generation and real-time notifications
  app.post("/api/insights/generate", auth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      
      await insightsEngine.sendInsightsToUser(user[0].id);
      
      res.json({ success: true, message: "Insights generated and sent" });
    } catch (error) {
      console.error("Generate insights error:", error);
      res.status(500).json({ error: "Failed to generate insights" });
    }
  });

  // Get personalized recommendations
  app.get("/api/recommendations", auth, async (req: Request, res: Response) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      const analysis = await insightsEngine.analyzeUserProductivity(user[0].id);
      
      const recommendations = [];

      // Schedule optimization
      if (analysis.peakProductivityHours.length > 0) {
        recommendations.push({
          category: 'schedule',
          title: 'Optimize Your Schedule',
          description: `Schedule important tasks during your peak hours: ${analysis.peakProductivityHours.join(', ')}:00`,
          impact: 'high',
          effort: 'low'
        });
      }

      // Break optimization
      if (analysis.breakFrequency < 2) {
        recommendations.push({
          category: 'wellness',
          title: 'Increase Break Frequency',
          description: 'Take breaks every 60-90 minutes to maintain focus and prevent burnout',
          impact: 'medium',
          effort: 'low'
        });
      }

      // Session length optimization
      if (analysis.averageSessionLength < 45) {
        recommendations.push({
          category: 'focus',
          title: 'Extend Work Sessions',
          description: 'Try the Pomodoro technique: 25-minute focused sessions with 5-minute breaks',
          impact: 'high',
          effort: 'medium'
        });
      } else if (analysis.averageSessionLength > 120) {
        recommendations.push({
          category: 'wellness',
          title: 'Break Up Long Sessions',
          description: 'Consider breaking sessions longer than 2 hours with short breaks',
          impact: 'medium',
          effort: 'low'
        });
      }

      // Consistency improvement
      if (analysis.consistencyScore < 70) {
        recommendations.push({
          category: 'routine',
          title: 'Build Consistent Habits',
          description: 'Establish regular work hours and stick to a daily routine',
          impact: 'high',
          effort: 'high'
        });
      }

      res.json({ recommendations, analysis });
    } catch (error) {
      console.error("Recommendations error:", error);
      res.status(500).json({ error: "Failed to generate recommendations" });
    }
  });
}