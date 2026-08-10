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

export declare function combinedBoundary(pairing: SeamPairing): {
  cuts: number[];
  uncertain: number[];
};
