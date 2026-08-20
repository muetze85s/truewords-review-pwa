export declare function logGapsFromTimestamps(seconds: number[]): {
  values: number[]; clamped: number; minSeconds: number; maxSeconds: number;
};

export type MixtureFit = {
  k: number;
  weights: number[];
  means: number[];
  sigmas: number[];
  logLikelihood: number;
  bic: number;
  aic: number;
  iterations: number;
  converged: boolean;
  n: number;
};

export declare function fitGaussianMixture(
  values: number[],
  k: number,
  options?: { maxIterations?: number; tolerance?: number },
): MixtureFit;

export declare function decisionBoundaries(
  fit: { weights: number[]; means: number[]; sigmas: number[] },
): Array<{ between: [number, number]; log10: number | null }>;

export declare function histogram(values: number[], bins: number): {
  bins: number; min: number; max: number; width: number; counts: number[]; edges: number[];
};

export declare function fitRange(
  values: number[],
  options?: { maxK?: number; maxIterations?: number; tolerance?: number },
): { fits: MixtureFit[]; bestK: number };
