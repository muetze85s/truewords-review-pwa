export type SegmentationMessage = { id?: string | number; [key: string]: unknown };

export type SegmentationBoundary = {
  afterEventId: string;
  beforeEventId: string;
  reason: string;
  gapMinutes: number;
};

export type SegmentationResult = {
  situations: unknown[];
  assignments: Record<string, number>;
  boundaries: SegmentationBoundary[];
  decisions: unknown[];
};

export declare function segmentConversationWindow(messages: SegmentationMessage[]): SegmentationResult;
