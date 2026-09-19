import { describe, it, expect } from 'vitest';
import { cn, formatDuration, formatTime } from '../../client/src/lib/utils';

describe('Utility Functions', () => {
  describe('cn (className utility)', () => {
    it('merges class names correctly', () => {
      expect(cn('bg-red-500', 'text-white')).toBe('bg-red-500 text-white');
    });

    it('handles conditional classes', () => {
      expect(cn('base-class', true && 'conditional-class')).toBe('base-class conditional-class');
      expect(cn('base-class', false && 'conditional-class')).toBe('base-class');
    });

    it('merges tailwind classes correctly', () => {
      expect(cn('p-2', 'p-4')).toBe('p-4');
      expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500');
    });

    it('handles undefined and null values', () => {
      expect(cn('base-class', undefined, null, 'another-class')).toBe('base-class another-class');
    });
  });

  describe('formatDuration', () => {
    it('formats seconds correctly', () => {
      expect(formatDuration(30)).toBe('00:00:30');
    });

    it('formats minutes correctly', () => {
      expect(formatDuration(90)).toBe('00:01:30');
    });

    it('formats hours correctly', () => {
      expect(formatDuration(3661)).toBe('01:01:01');
    });

    it('handles zero seconds', () => {
      expect(formatDuration(0)).toBe('00:00:00');
    });

    it('handles large durations', () => {
      expect(formatDuration(86400)).toBe('24:00:00'); // 24 hours
    });

    it('handles negative durations', () => {
      expect(formatDuration(-30)).toBe('00:00:00'); // Should handle gracefully
    });
  });

  describe('formatTime', () => {
    it('formats time correctly', () => {
      const date = new Date('2024-01-01T15:30:45');
      expect(formatTime(date)).toBe('3:30 PM');
    });

    it('formats AM time correctly', () => {
      const date = new Date('2024-01-01T09:15:30');
      expect(formatTime(date)).toBe('9:15 AM');
    });

    it('formats noon correctly', () => {
      const date = new Date('2024-01-01T12:00:00');
      expect(formatTime(date)).toBe('12:00 PM');
    });

    it('formats midnight correctly', () => {
      const date = new Date('2024-01-01T00:00:00');
      expect(formatTime(date)).toBe('12:00 AM');
    });
  });
});