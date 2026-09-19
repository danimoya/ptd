import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Progress } from './ui/progress';
import { Badge } from './ui/badge';
import { formatDuration } from '../lib/utils';
import { Clock, Target, TrendingUp, Users, Activity, BarChart3 } from 'lucide-react';

interface DashboardData {
  todayStats: {
    totalMinutes: number;
    breakMinutes: number;
    activeTimer: {
      id: number;
      checkIn: string;
      isBreak: boolean;
      customerId: number | null;
      customerName: string | null;
    } | null;
    completedTasks: number;
  };
  weekStats: {
    totalMinutes: number;
    dailyAverage: number;
    peakDay: string;
    goalProgress: number;
  };
  recentActivity: {
    id: number;
    checkIn: string;
    checkOut: string | null;
    isBreak: boolean;
    customerName: string | null;
    duration: number;
  }[];
  topCustomers: {
    customerId: number | null;
    customerName: string | null;
    totalMinutes: number;
    sessionCount: number;
  }[];
}

async function fetchDashboardData(): Promise<DashboardData> {
  const response = await fetch('/api/dashboard', {
    headers: {
      'Authorization': `Bearer ${localStorage.getItem('token')}`
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to fetch dashboard data');
  }
  
  return response.json();
}

export default function RealTimeDashboard() {
  const [wsConnected, setWsConnected] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());

  const { data: dashboardData, refetch } = useQuery({
    queryKey: ['dashboard'],
    queryFn: fetchDashboardData,
    refetchInterval: 30000 // Refetch every 30 seconds
  });

  // Update current time every second
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // WebSocket connection for real-time updates
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return;

    const wsUrl = `ws://${window.location.host}/ws?token=${token}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWsConnected(true);
      console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      switch (message.type) {
        case 'timer_start':
        case 'timer_stop':
        case 'dashboard_update':
          refetch();
          break;
        case 'notification':
          // Handle notifications here
          console.log('Notification:', message.data);
          break;
      }
    };

    ws.onclose = () => {
      setWsConnected(false);
      console.log('WebSocket disconnected');
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setWsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [refetch]);

  if (!dashboardData) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {[...Array(8)].map((_, i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader className="space-y-2">
              <div className="h-4 bg-gray-200 rounded w-3/4"></div>
              <div className="h-3 bg-gray-200 rounded w-1/2"></div>
            </CardHeader>
            <CardContent>
              <div className="h-8 bg-gray-200 rounded w-full"></div>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const { todayStats, weekStats, recentActivity, topCustomers } = dashboardData;
  
  // Calculate active timer duration
  const activeTimerDuration = todayStats.activeTimer 
    ? Math.floor((currentTime.getTime() - new Date(todayStats.activeTimer.checkIn).getTime()) / 1000)
    : 0;

  const dailyGoalMinutes = 480; // 8 hours
  const dailyProgress = Math.min(100, (todayStats.totalMinutes / dailyGoalMinutes) * 100);

  return (
    <div className="space-y-6">
      {/* Connection Status */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Real-Time Dashboard</h2>
        <div className="flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${wsConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
          <span className="text-sm text-gray-600">
            {wsConnected ? 'Live updates' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Active Timer Section */}
      {todayStats.activeTimer && (
        <Card className="border-blue-500 bg-blue-50">
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Activity className="w-5 h-5 text-blue-600" />
              <span>Active Timer</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {todayStats.activeTimer.isBreak ? 'Break Time' : 'Work Session'}
                </p>
                <p className="text-sm text-gray-600">
                  {todayStats.activeTimer.customerName || 'No customer selected'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-blue-600">
                  {formatDuration(activeTimerDuration)}
                </p>
                <p className="text-sm text-gray-600">
                  Started {new Date(todayStats.activeTimer.checkIn).toLocaleTimeString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Today's Work</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatDuration(todayStats.totalMinutes * 60)}
            </div>
            <Progress value={dailyProgress} className="mt-3" />
            <p className="text-xs text-muted-foreground mt-2">
              {Math.round(dailyProgress)}% of daily goal
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tasks Completed</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{todayStats.completedTasks}</div>
            <p className="text-xs text-muted-foreground">
              Break time: {formatDuration(todayStats.breakMinutes * 60)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Weekly Progress</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatDuration(weekStats.totalMinutes * 60)}
            </div>
            <Progress value={weekStats.goalProgress} className="mt-3" />
            <p className="text-xs text-muted-foreground mt-2">
              {Math.round(weekStats.goalProgress)}% of weekly goal
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Daily Average</CardTitle>
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatDuration(weekStats.dailyAverage * 60)}
            </div>
            <p className="text-xs text-muted-foreground">
              Peak day: {weekStats.peakDay}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity and Top Customers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Activity className="w-5 h-5" />
              <span>Recent Activity</span>
            </CardTitle>
            <CardDescription>Your latest time entries</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentActivity.slice(0, 5).map((entry) => (
                <div key={entry.id} className="flex items-center justify-between p-2 border rounded">
                  <div className="flex items-center space-x-3">
                    <Badge variant={entry.isBreak ? 'secondary' : 'default'} className="text-xs">
                      {entry.isBreak ? 'Break' : 'Work'}
                    </Badge>
                    <div>
                      <p className="text-sm font-medium">
                        {entry.customerName || 'No customer'}
                      </p>
                      <p className="text-xs text-gray-600">
                        {new Date(entry.checkIn).toLocaleTimeString()}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {formatDuration(entry.duration * 60)}
                    </p>
                    <p className="text-xs text-gray-600">
                      {entry.checkOut ? 'Completed' : 'Active'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Users className="w-5 h-5" />
              <span>Top Customers This Week</span>
            </CardTitle>
            <CardDescription>Ranked by time spent</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {topCustomers.slice(0, 5).map((customer, index) => (
                <div key={customer.customerId || 'no-customer'} className="flex items-center justify-between p-2 border rounded">
                  <div className="flex items-center space-x-3">
                    <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-xs font-bold text-blue-600">
                      {index + 1}
                    </div>
                    <div>
                      <p className="text-sm font-medium">
                        {customer.customerName || 'No customer'}
                      </p>
                      <p className="text-xs text-gray-600">
                        {customer.sessionCount} sessions
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium">
                      {formatDuration(customer.totalMinutes * 60)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}