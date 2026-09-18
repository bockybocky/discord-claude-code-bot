export type CalendarCandidate = {
  summary: string;
  start: string;
  durationMinutes: number;
  timeZone: "Asia/Taipei";
};

const DATE_PATTERN = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|號)?/;
const TIME_PATTERN = /(凌晨|清晨|早上|上午|中午|下午|傍晚|晚上|晚間)?\s*(\d{1,2})\s*(?::|：|點)\s*(\d{1,2})?\s*(?:分)?/;
const QUESTION_OR_LOOKUP_PATTERN = /[?？]|幫我查|查詢|查一下|天氣|班機|航班|幾點|什麼時候|是否|可不可以|能不能|如何|怎麼/;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function normalizeHour(rawHour: number, period: string | undefined): number | undefined {
  if (rawHour < 0 || rawHour > 23) return undefined;
  if (!period) return rawHour;
  if (rawHour > 12) return undefined;
  if (["下午", "傍晚", "晚上", "晚間", "中午"].includes(period)) {
    return rawHour < 12 ? rawHour + 12 : rawHour;
  }
  if (["凌晨", "清晨", "早上", "上午"].includes(period)) {
    return rawHour === 12 ? 0 : rawHour;
  }
  return rawHour;
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 2000 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function taipeiYear(now: Date): number {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS).getUTCFullYear();
}

export function parseCalendarCandidate(text: string, now = new Date()): CalendarCandidate | undefined {
  if (QUESTION_OR_LOOKUP_PATTERN.test(text)) return undefined;
  const dateMatch = DATE_PATTERN.exec(text);
  const timeMatch = TIME_PATTERN.exec(text);
  if (!dateMatch || !timeMatch) return undefined;

  const explicitYear = dateMatch[1] ? Number(dateMatch[1]) : undefined;
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = normalizeHour(Number(timeMatch[2]), timeMatch[1]);
  const minute = timeMatch[3] === undefined ? 0 : Number(timeMatch[3]);
  if (hour === undefined || minute < 0 || minute > 59) return undefined;

  const summary = text
    .replace(dateMatch[0], "")
    .replace(timeMatch[0], "")
    .replace(/^[\s，,、；;：:。.!！?？—-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!summary) return undefined;

  let year = explicitYear ?? taipeiYear(now);
  for (let attempt = 0; attempt < (explicitYear ? 1 : 9); attempt += 1, year += 1) {
    if (!validDate(year, month, day)) continue;
    const start = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
    if (Date.parse(start) > now.getTime()) {
      return {
        summary,
        start,
        durationMinutes: 60,
        timeZone: "Asia/Taipei",
      };
    }
  }
  return undefined;
}
