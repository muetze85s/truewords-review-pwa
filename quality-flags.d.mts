export interface QualityFlag {
  /** Fester Anzeigecode (Z1–Z3), an den key gebunden. */
  code: string;
  key: string;
  label: string;
  hint: string;
}

export declare const QUALITY_FLAGS: QualityFlag[];

export declare const QUALITY_FLAG_KEYS: string[];

export declare const SEGMENTATION_BROKEN_FLAG_KEYS: string[];

export declare function isValidQualityFlag(key: string): boolean;

export declare function qualityFlagByKey(key: string): QualityFlag | undefined;

export declare function qualityCodeByKey(key: string): string;
