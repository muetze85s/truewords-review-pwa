export declare function anonymizeSituation(
  messages: Array<{ from?: string; text?: string; kind?: string }>,
): { text: string; labelCount: number };

export declare function buildClassificationPrompt(input: {
  situationText: string;
  codebookSection: string;
  keys: string[];
}): { system: string; user: string };

export declare function parseClassificationJson(
  text: string,
  keys: string[],
): { classes: Record<string, 0 | 1> } | null;
