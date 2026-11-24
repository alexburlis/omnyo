const WEEKDAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
  "Sundays",
];

const WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7])$/u;

export function describeWeeklyCron(cron: string): string | null {
  const match = WEEKLY.exec(cron.trim());

  if (!match) return null;

  const [, minute = "", hour = "", weekday = ""] = match;

  if (Number(minute) > 59 || Number(hour) > 23) return null;

  return `${WEEKDAYS[Number(weekday)]} at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}
