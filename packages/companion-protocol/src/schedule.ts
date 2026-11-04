/**
 * How check-ins and routines are written down, on the desk and the phone
 * alike: the one-line "when: what" composer split, a schedule's words, and
 * the list order. Pure, and moved here from the desktop's src/lib/agents.ts
 * (which re-exports them) so both clients word a schedule the same way.
 */

import type { CheckIn, Repeat } from './model';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "9:00 AM" in the user's locale, the same way `formatWhen` writes times. */
const clockText = (hour: number, minute: number) =>
  new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

/** "Every weekday at 9:00 AM", "Every 2 hours" — `schedule::describe`'s words, locale times. */
export function describeRepeat(repeat: Repeat): string {
  if (repeat.kind === 'every') {
    const { minutes } = repeat;
    if (minutes % 60 !== 0) return `Every ${minutes} minutes`;
    return minutes === 60 ? 'Every hour' : `Every ${minutes / 60} hours`;
  }
  const days = [...repeat.days].sort((a, b) => a - b).join(',');
  const named =
    days === '0,1,2,3,4,5,6'
      ? 'day'
      : days === '1,2,3,4,5'
        ? 'weekday'
        : days === '0,6'
          ? 'weekend day'
          : repeat.days
              .map((d) => DAY_NAMES[d % 7])
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1');
  return `Every ${named} at ${clockText(repeat.hour, repeat.minute)}`;
}

/** "Today 9:00 AM", "Tomorrow 9:00 AM", "Thu, Nov 5 9:00 AM". */
export function formatWhen(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const start = today.getTime();
  if (ts >= start && ts < start + dayMs) return `Today ${time}`;
  if (ts >= start + dayMs && ts < start + 2 * dayMs) return `Tomorrow ${time}`;
  const day = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${day} ${time}`;
}

/**
 * The schedule composer takes one line, "when: what" — "every weekday 9am:
 * brief me on Acme". The split is the first colon followed by a space, so
 * clock times ("9:30") stay whole. No such colon yet: it's all "when".
 */
export function splitScheduleInput(text: string): { when: string; note: string } {
  const match = /^(.*?):\s+([\s\S]*)$/.exec(text);
  if (!match) return { when: text.trim().replace(/:$/, ''), note: '' };
  return { when: match[1].trim(), note: match[2].trim() };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * The `when` words the schedule grammar reads back as this same schedule,
 * for Edit to prefill: "every weekday at 09:00", "every 2 hours",
 * "2026-11-20 09:00" (local). Mirrors `schedule::describe`.
 */
export function scheduleWhenPhrase(c: Pick<CheckIn, 'repeat' | 'nextAt'>): string {
  const r = c.repeat;
  if (!r) {
    const d = new Date(c.nextAt);
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    return `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  if (r.kind === 'every') {
    if (r.minutes % 60 !== 0) return `every ${r.minutes} minutes`;
    return r.minutes === 60 ? 'every hour' : `every ${r.minutes / 60} hours`;
  }
  const days = [...r.days].sort((a, b) => a - b);
  const key = days.join(',');
  const named =
    key === '0,1,2,3,4,5,6'
      ? 'day'
      : key === '1,2,3,4,5'
        ? 'weekday'
        : key === '0,6'
          ? 'weekend day'
          : days
              .map((d) => DAY_NAMES[d % 7].toLowerCase())
              .join(', ')
              .replace(/, ([^,]*)$/, ' and $1');
  return `every ${named} at ${pad2(r.hour)}:${pad2(r.minute)}`;
}

/** A row's secondary line: when it next runs, and how it repeats. */
export function describeCheckInTime(c: CheckIn, now = Date.now()): string {
  if (!c.repeat) return formatWhen(c.nextAt, now);
  const repeat = describeRepeat(c.repeat);
  if (c.paused) return `Paused · ${repeat}`;
  const next = formatWhen(c.nextAt, now).replace(/^(Today|Tomorrow)/, (w) => w.toLowerCase());
  return `${repeat} · next ${next}`;
}

/** Soonest first; paused ones last. */
export function sortCheckIns(checkIns: CheckIn[]): CheckIn[] {
  return [...checkIns].sort((a, b) =>
    a.paused !== b.paused ? (a.paused ? 1 : -1) : a.nextAt - b.nextAt
  );
}
