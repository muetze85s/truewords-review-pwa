export type GapHourClass = {
  fromSeconds: number;
  toSeconds: number | null;
  counts: number[];
};

export type HourlyAggregates = {
  timezone: string;
  timezoneNote: string;
  skippedNoTimestamp: number;
  msgPerHourBySender: Record<string, number[]>;
  gapStartHour: {
    minGapSeconds: number;
    classes: { '1-4h': GapHourClass; '4-12h': GapHourClass; over12h: GapHourClass };
  };
};

export declare function hourlyAggregates(
  entries: Array<{ t: number; from: string }>,
  options?: { timeZone?: string },
): HourlyAggregates;
