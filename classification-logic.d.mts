export interface DerivedSituation {
  situationIndex: number;
  startPos: number;
  endPos: number;
  startMessageId: string;
  endMessageId: string;
  messageCount: number;
}

export declare function deriveSituations(messageIds: string[], cutPositions: number[]): DerivedSituation[];

export interface KappaStat {
  n: number;
  agreement: number | null;
  kappa: number | null;
  degenerate: boolean;
  n11: number;
  n10: number;
  n01: number;
  n00: number;
  aPositives: number;
  bPositives: number;
}

export declare function cohenKappaBinary(pairs: Array<[unknown, unknown]>): KappaStat;

export type Ampel = 'red' | 'yellow' | 'green' | 'none';

export declare function kappaAmpel(kappa: number | null | undefined): Ampel;

export declare const MIN_RELIABLE_SITUATIONS: number;

export declare function isReliable(n: number, minReliable?: number): boolean;

export interface MarkRowLike {
  situation_id: number | string;
  present: number | boolean;
  [key: string]: unknown;
}

export interface KeyAgreement {
  key: string;
  n: number;
  agreementPercent: number | null;
  kappa: number | null;
  degenerate: boolean;
  reliable: boolean;
  ampel: Ampel | 'insufficient';
  aPositives: number;
  bPositives: number;
}

export declare function agreementByKey(options: {
  situationIds: Array<number | string>;
  marksA: MarkRowLike[];
  marksB: MarkRowLike[];
  keys: string[];
  keyField?: string;
  minReliable?: number;
}): KeyAgreement[];

export interface ClassificationResolutionRow {
  situation_id: number | string;
  decided_by: string;
  resolved_present: number | boolean;
  [key: string]: unknown;
}

export interface AgreedClassification {
  situation_id: number;
  key: string;
  resolved: boolean;
  resolvedPresent: number | null;
  philipp: number | null;
  lena: number | null;
}

export declare function agreeClassificationResolutions(
  rows: ClassificationResolutionRow[],
  keyField?: string,
): AgreedClassification[];

export interface SituationDispute {
  key: string;
  philipp: number;
  lena: number;
  resolved: boolean;
  resolvedPresent: number | null;
  votes: { philipp: number | null; lena: number | null };
}

export declare function krippendorffAlphaBinary(
  units: Array<Array<number | null | undefined>>,
): { alpha: number | null; n: number; degenerate: boolean };

export interface SelfImplicationEntry {
  key: string;
  philippBearer: { n: number; kappa: number | null };
  lenaBearer: { n: number; kappa: number | null };
  gap: number | null;
}

export declare function selfImplicationSplit(input: {
  situations: Array<{ id: number | string; bearer: 'Philipp' | 'Lena' | null }>;
  marksP: MarkRowLike[];
  marksL: MarkRowLike[];
  keys: string[];
  keyField?: string;
}): SelfImplicationEntry[];

export declare function autoEnableDecision(
  kappaHH: number | null,
  kappaHL: number | null,
  opts?: { hhMin?: number; hlMin?: number },
): { eligible: boolean; humanHumanOk: boolean; humanLlmOk: boolean; hhMin: number; hlMin: number };

export declare function disputesForSituation(options: {
  situationId: number | string;
  marksA: MarkRowLike[];
  marksB: MarkRowLike[];
  resolutions: ClassificationResolutionRow[];
  keys: string[];
  keyField?: string;
}): SituationDispute[];
