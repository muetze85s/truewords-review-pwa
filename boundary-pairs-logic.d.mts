export declare function hashSeed(text: string): number;

export declare function mulberry32(seed: number): () => number;

export declare function pickRoundStart(options: {
  datasetId: string;
  round: number;
  sequenceLength: number;
  windowSize?: number;
  existingRanges?: Array<{ start: number; count: number }>;
  maxAttempts?: number;
}): number;

export type SeamPairing = {
  pairs: Array<[number, number]>;
  onlyA: number[];
  onlyB: number[];
};

export declare function pairSeams(a: number[], b: number[], tolerance?: number): SeamPairing;

export declare function agreementF1(pairing: SeamPairing): number;

export declare function cohensKappa(pairing: SeamPairing, totalSeams: number): number;

export type BoundaryMark = { position: number; mark: 'cut' | 'doubt' };
export type DoubtMode = 'skip' | 'cut' | 'none';

export declare function resolveMarks(
  marks: BoundaryMark[],
  doubtMode?: DoubtMode,
): { cuts: number[]; excluded: number[] };

export type ReviewerComparison = SeamPairing & {
  n: number;
  excluded: number[];
  agreementF1: number;
  kappa: number;
};

export declare function compareReviewers(
  marksA: BoundaryMark[],
  marksB: BoundaryMark[],
  options: { totalSeams: number; tolerance?: number; doubtMode?: DoubtMode },
): ReviewerComparison;

export type BoundaryResolution = { position: number; decision: 'cut' | 'no_cut' | 'open' };

export declare function toPositionalResolutions(
  rows: Array<{ seam_message_id: string; decision: 'cut' | 'no_cut' | 'open' }>,
  positions: Map<string, number>,
): BoundaryResolution[];

export declare function combinedBoundary(
  pairing: SeamPairing,
  resolutions?: BoundaryResolution[],
): {
  cuts: number[];
  uncertain: number[];
};

export type SegmentationInputMessage = {
  id: string;
  from: string;
  t: number;
  text: string;
  kind: 'text' | 'medien' | 'anruf' | 'leer';
  replyToId?: string;
};

export declare function toSegmentationInput(
  messages: SegmentationInputMessage[],
): Array<{
  id: string;
  date_unixtime: number;
  from: string;
  text: string;
  truewords_service_type?: string;
  truewords_media_type?: string;
  reply_to_message_id?: string;
}>;

export declare function buildRoundView(options: {
  reviewer: 'Philipp' | 'Lena';
  messages: unknown[];
  philippMarks: unknown[];
  lenaMarks: unknown[];
  philippSubmittedAt: string | null;
  lenaSubmittedAt: string | null;
}): {
  ok: true;
  reviewer: 'Philipp' | 'Lena';
  messages: unknown[];
  seams: number;
  marks: unknown[];
  submitted: boolean;
  submittedAt: string | null;
  otherSubmitted: boolean;
};

export declare function agreementGate(options: {
  reviewer: 'Philipp' | 'Lena';
  philippSubmittedAt: string | null;
  lenaSubmittedAt: string | null;
}): { waitingFor: 'Philipp' | 'Lena' } | null;
