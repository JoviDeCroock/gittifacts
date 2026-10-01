/** Time-zone offsets as clients see them: "+05:30", "-01:30", "Z". */

/**
 * Formats a UTC offset given in minutes east of UTC (Asia/Kolkata is +330, Newfoundland
 * standard time is -210) as `±HH:MM`, or "Z" for UTC.
 */
export function formatOffset(minutes: number): string {
  if (!Number.isInteger(minutes) || Math.abs(minutes) > 14 * 60) {
    throw new RangeError(`offset out of range: ${minutes}`);
  }
  if (minutes === 0) return "Z";
  const sign = minutes > 0 ? "+" : "-";
  const hours = Math.floor(minutes / 60);
  const rest = Math.abs(minutes % 60);
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

/** The current time at `offsetMinutes`, as an ISO-8601 string with that offset. */
export function nowAt(offsetMinutes: number, now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const local = shifted.toISOString().slice(0, 19);
  return `${local}${formatOffset(offsetMinutes)}`;
}
