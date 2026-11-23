import { localDateString } from "../shared/names";
import type { ExerciseType } from "../modules/workout";

export function countPhrase(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

export function formatMonthKey(yearMonth: string): string {
  const [year, month] = yearMonth.split("-").map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function formatWeekdayDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export function formatRangeLabel(start: string, end: string): string {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const left = new Date(startYear, startMonth - 1, startDay).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: startYear === endYear ? undefined : "numeric",
  });
  const right = new Date(endYear, endMonth - 1, endDay).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${left} – ${right}`;
}

export function formatExportedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function relativeDay(isoDate: string, today = new Date()): string {
  const todayKey = localDateString(today);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isoDate === todayKey) return "Today";
  if (isoDate === localDateString(yesterday)) return "Yesterday";
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function minutesBetween(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const minutes = Math.round((Date.parse(end) - Date.parse(start)) / 60000);
  return minutes > 0 ? minutes : null;
}

export function daysInclusive(start: string, end: string): number {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const from = Date.UTC(startYear, startMonth - 1, startDay);
  const to = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.round((to - from) / 86400000) + 1;
}

export function defaultTrendRange(today = new Date()): { start: string; end: string } {
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return { start: localDateString(start), end: localDateString(today) };
}

export function currentWeek(today = new Date()) {
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    return {
      key: localDateString(date),
      name: date.toLocaleDateString("en-US", { weekday: "short" }),
      number: String(date.getDate()),
    };
  });
}

export function exerciseTypeLabel(type: ExerciseType): string {
  switch (type) {
    case "barbell":
      return "Barbell · Total weight";
    case "dumbbell":
      return "Dumbbell · Weight per hand";
    case "machine":
      return "Machine · Total weight";
    case "bodyweight":
      return "Bodyweight · Reps";
    case "duration":
      return "Timed · Duration";
  }
}

export function formatPoundsDisplay(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return value;
  return amount.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

export function oneParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
