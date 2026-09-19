import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Badge } from './ui/badge';
import { formatDuration } from '../lib/utils';
import { TrendingUp, Clock, Calendar, BarChart3, Target, Lightbulb } from 'lucide-react';

interface PatternData {
  hourlyPatterns: {
    hour: number;
    avgDuration: number;
    sessionCount: number;
    totalMinutes: number;
  }[];
  weekdayPatterns: {
    dayOfWeek: number;
    dayName: string;
    avgDuration: number;
    totalMinutes: number;
  }[];
  breakPatterns: {
    avgBreakDuration: number;
    breakFrequency: number;
    totalBreakTime: number;
  };
  analysis: {
    mostProductiveHour: {
      hour: number;
      totalMinutes: number;
    };
    mostProductiveDay: {
      dayName: string;
      totalMinutes: number;
    };
    recommendedBreakInterval: number;
  };
}

async function fetchPatterns(days: number): Promise<PatternData> {
  const response = await fetch(`/api/patterns?days=${days}`, {
    headers: {
      'Authorization': `Bearer ${localStorage.getItem('token')}`
    }
  });
  
  if (!response.ok) {
    throw new Error('Failed to fetch patterns');
  }
  
  return response.json();
}

export default function ProductivityPatterns() {
  const [selectedPeriod, setSelectedPeriod] = React.useState('30');

  const { data: patterns, isLoading } = useQuery({
    queryKey: ['patterns', selectedPeriod],
    queryFn: () => fetchPatterns(parseInt(selectedPeriod))
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card className="animate-pulse">
          <CardHeader>
            <div className="h-6 bg-gray-200 rounded w-3/4"></div>
            <div className="h-4 bg-gray-200 rounded w-1/2"></div>
          </CardHeader>
          <CardContent>
            <div className="h-32 bg-gray-200 rounded"></div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!patterns) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <p className="text-gray-600">No pattern data available</p>
        </CardContent>
      </Card>
    );
  }

  const { hourlyPatterns, weekdayPatterns, breakPatterns, analysis } = patterns;

  // Find peak productivity hours (top 3)
  const topHours = [...hourlyPatterns]
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
    .slice(0, 3);

  // Calculate productivity score based on consistency
  const avgDailyMinutes = weekdayPatterns.reduce((sum, day) => sum + day.totalMinutes, 0) / weekdayPatterns.length;
  const consistency = weekdayPatterns.reduce((sum, day) => {
    const deviation = Math.abs(day.totalMinutes - avgDailyMinutes);
    return sum + (1 - Math.min(deviation / avgDailyMinutes, 1));
  }, 0) / weekdayPatterns.length;

  const productivityScore = Math.round(consistency * 100);

  return (
    <div className="space-y-6">
      {/* Header with period selector */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Productivity Patterns</h2>
          <p className="text-gray-600">Analyze your work habits and optimize your schedule</p>
        </div>
        <Select value={selectedPeriod} onValueChange={setSelectedPeriod}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">7 days</SelectItem>
            <SelectItem value="30">30 days</SelectItem>
            <SelectItem value="90">90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Key Insights */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Peak Hour</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {analysis.mostProductiveHour.hour}:00
            </div>
            <p className="text-xs text-muted-foreground">
              {formatDuration(analysis.mostProductiveHour.totalMinutes * 60)} total
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Best Day</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {analysis.mostProductiveDay.dayName}
            </div>
            <p className="text-xs text-muted-foreground">
              {formatDuration(analysis.mostProductiveDay.totalMinutes * 60)} average
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Consistency Score</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {productivityScore}%
            </div>
            <p className="text-xs text-muted-foreground">
              Daily work consistency
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Break Frequency</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {Math.round(breakPatterns.breakFrequency * 10) / 10}
            </div>
            <p className="text-xs text-muted-foreground">
              Breaks per day
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Hourly Pattern Visualization */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <BarChart3 className="w-5 h-5" />
            <span>Hourly Productivity Pattern</span>
          </CardTitle>
          <CardDescription>Your productivity throughout the day</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Top productive hours */}
            <div>
              <h4 className="font-medium mb-2">Peak Productivity Hours</h4>
              <div className="flex flex-wrap gap-2">
                {topHours.map((hour, index) => (
                  <Badge key={hour.hour} variant={index === 0 ? 'default' : 'secondary'}>
                    {hour.hour}:00 - {formatDuration(hour.totalMinutes * 60)}
                  </Badge>
                ))}
              </div>
            </div>

            {/* Hourly breakdown */}
            <div className="grid grid-cols-24 gap-1 mt-4">
              {Array.from({ length: 24 }, (_, i) => {
                const hourData = hourlyPatterns.find(h => h.hour === i);
                const intensity = hourData ? Math.min(100, (hourData.totalMinutes / 120) * 100) : 0; // Max 2 hours = 100%
                
                return (
                  <div
                    key={i}
                    className="h-16 rounded text-xs flex items-end justify-center text-white font-medium relative group"
                    style={{
                      backgroundColor: intensity > 0 
                        ? `hsl(${220 - (intensity * 0.6)}, 70%, ${50 + (intensity * 0.3)}%)`
                        : '#f3f4f6'
                    }}
                    title={`${i}:00 - ${formatDuration((hourData?.totalMinutes || 0) * 60)}`}
                  >
                    <span className="transform rotate-90 origin-center text-[10px]">
                      {i}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-gray-600 text-center">
              Hours of the day (darker colors = higher productivity)
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Weekly Pattern */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Weekly Pattern</CardTitle>
            <CardDescription>Productivity by day of week</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {weekdayPatterns.map((day) => {
                const maxMinutes = Math.max(...weekdayPatterns.map(d => d.totalMinutes));
                const percentage = maxMinutes > 0 ? (day.totalMinutes / maxMinutes) * 100 : 0;
                
                return (
                  <div key={day.dayOfWeek} className="flex items-center space-x-3">
                    <div className="w-12 text-sm font-medium">
                      {day.dayName.slice(0, 3)}
                    </div>
                    <div className="flex-1 bg-gray-200 rounded-full h-6 relative">
                      <div
                        className="bg-blue-500 h-6 rounded-full flex items-center justify-end pr-2"
                        style={{ width: `${percentage}%` }}
                      >
                        {percentage > 20 && (
                          <span className="text-white text-xs font-medium">
                            {formatDuration(day.totalMinutes * 60)}
                          </span>
                        )}
                      </div>
                    </div>
                    {percentage <= 20 && (
                      <div className="w-16 text-sm text-gray-600">
                        {formatDuration(day.totalMinutes * 60)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <Lightbulb className="w-5 h-5" />
              <span>Insights & Recommendations</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h4 className="font-medium text-sm mb-2">Break Analysis</h4>
              <div className="text-sm text-gray-600 space-y-1">
                <p>Average break duration: {formatDuration(breakPatterns.avgBreakDuration * 60)}</p>
                <p>Recommended break interval: {Math.round(analysis.recommendedBreakInterval)} minutes</p>
                <p>Total break time: {formatDuration(breakPatterns.totalBreakTime * 60)}</p>
              </div>
            </div>

            <div>
              <h4 className="font-medium text-sm mb-2">Optimization Tips</h4>
              <div className="text-sm text-gray-600 space-y-1">
                {productivityScore < 70 && (
                  <p>• Try to maintain more consistent daily work hours</p>
                )}
                {breakPatterns.breakFrequency < 2 && (
                  <p>• Consider taking more frequent breaks to maintain focus</p>
                )}
                {analysis.mostProductiveHour.hour > 14 && (
                  <p>• You're most productive in the afternoon - schedule important tasks then</p>
                )}
                {analysis.mostProductiveHour.hour < 10 && (
                  <p>• You're a morning person - tackle complex work early</p>
                )}
                <p>• Schedule breaks every {Math.round(analysis.recommendedBreakInterval)} minutes for optimal productivity</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}