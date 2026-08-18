export interface QualityFlag {
  key: string;
  label: string;
  hint: string;
}

export declare const QUALITY_FLAGS: QualityFlag[];

export declare const QUALITY_FLAG_KEYS: string[];

export declare const SEGMENTATION_BROKEN_FLAG_KEYS: string[];

export declare function isValidQualityFlag(key: string): boolean;

export declare function qualityFlagByKey(key: string): QualityFlag | undefined;
