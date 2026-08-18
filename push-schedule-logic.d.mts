export declare function localParts(date: Date, timeZone: string): {
  ymd: string; hour: number; minute: number; minutesOfDay: number;
};
export declare function localYmd(date: Date, timeZone: string): string;
export declare function parseHhmm(value: string): number | null;
export declare function dueReminderSlots(input: {
  now: Date;
  timeZone: string;
  times: string[];
  enabled: boolean;
  submittedToday: boolean;
  sentSlotsToday?: number[];
}): number[];
export declare function disputeAlertDue(input: {
  enabled: boolean;
  openCount: number;
  threshold: number;
  sentToday: boolean;
  nowMinutesOfDay?: number;
  earliestMinutes?: number;
}): boolean;
