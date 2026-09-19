
import React from 'react';
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function CustomerGoalSelect({ weeklyGoal, setWeeklyGoal }) {
  return (
    <div className="space-y-2">
      <Label htmlFor="weeklyGoal">Weekly Goal (hours)</Label>
      <Input
        id="weeklyGoal"
        type="number"
        value={weeklyGoal}
        onChange={(e) => setWeeklyGoal(Number(e.target.value))}
        min={0}
        max={168}
      />
    </div>
  );
}
