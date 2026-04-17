export const carServiceBusiness = {
  name: 'Northside Auto Service',
  phone: '(03) 9123 4567',
  email: 'service@northsideauto.example',
  address: '42 Workshop Lane, Brunswick VIC 3056',
  suburb: 'Brunswick',
  state: 'VIC',
  timeZone: 'Australia/Melbourne',
  landmarks:
    'Near Sydney Road, two blocks from Brunswick station. Customer parking is available behind the workshop.',
};

export const carServiceHours = [
  { day: 'Monday', open: '08:00', close: '17:30', closed: false },
  { day: 'Tuesday', open: '08:00', close: '17:30', closed: false },
  { day: 'Wednesday', open: '08:00', close: '17:30', closed: false },
  { day: 'Thursday', open: '08:00', close: '17:30', closed: false },
  { day: 'Friday', open: '08:00', close: '17:00', closed: false },
  { day: 'Saturday', open: '08:30', close: '12:30', closed: false },
  { day: 'Sunday', open: '', close: '', closed: true },
];

export const serviceTypes = [
  'logbook service',
  'minor service',
  'major service',
  'oil change',
  'brake inspection',
  'tyre rotation',
  'roadworthy inspection',
  'diagnostic check',
];

const weekdaySlots = ['08:30', '10:00', '13:30', '15:00'];
const saturdaySlots = ['09:00', '10:30'];

export function dayIndex(date: Date): number {
  return date.getDay();
}

export function dayName(date: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: carServiceBusiness.timeZone,
    weekday: 'long',
  }).format(date);
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: carServiceBusiness.timeZone,
    dateStyle: 'full',
  }).format(date);
}

export function parseRequestedDate(value?: string): Date | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const today = new Date();
  if (normalized === 'today') {
    return today;
  }

  if (normalized === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function hoursForDate(date: Date) {
  const index = dayIndex(date);
  return carServiceHours[index];
}

export function availableSlots(date: Date, preferredTimeOfDay = 'any') {
  const hours = hoursForDate(date);
  if (!hours || hours.closed) {
    return [];
  }

  const slots = dayIndex(date) === 6 ? saturdaySlots : weekdaySlots;

  if (preferredTimeOfDay === 'morning') {
    return slots.filter((slot) => Number(slot.slice(0, 2)) < 12);
  }

  if (preferredTimeOfDay === 'afternoon') {
    return slots.filter((slot) => Number(slot.slice(0, 2)) >= 12);
  }

  return slots;
}

export function nextAvailability(options: {
  date?: string;
  preferredTimeOfDay?: string;
  limit?: number;
}) {
  const limit = options.limit ?? 5;
  const requestedDate = parseRequestedDate(options.date);
  const start = requestedDate ?? new Date();
  const results: Array<{
    date: string;
    day: string;
    times: string[];
  }> = [];

  for (let offset = 0; offset < 21 && results.length < limit; offset += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const times = availableSlots(date, options.preferredTimeOfDay);

    if (times.length > 0) {
      results.push({
        date: formatDate(date),
        day: dayName(date),
        times,
      });
    }
  }

  return results;
}
