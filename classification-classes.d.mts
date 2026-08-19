export type ClassGroup = 'risk' | 'positive' | 'apology';

export interface ClassificationClass {
  /** Fester Anzeigecode (N1–N10 / P1–P9 / E1), an den key gebunden. */
  code: string;
  key: string;
  label: string;
  group: ClassGroup;
  selfImplicating: boolean;
  autoClassificationEnabled: boolean;
  hint: string;
}

export declare const CODEBOOK_VERSION: number;

export declare const GROUP_LABELS: Record<ClassGroup, string>;

export declare const CLASSIFICATION_CLASSES: ClassificationClass[];

export declare const CLASSIFICATION_KEYS: string[];

export declare const SELF_IMPLICATING_KEYS: string[];

export declare function isValidPatternKey(key: string): boolean;

export declare function classByKey(key: string): ClassificationClass | undefined;

export declare function classesByGroup(group: ClassGroup): ClassificationClass[];

export declare function codeByKey(key: string): string;
