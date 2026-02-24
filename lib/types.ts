export type EditMagnitude = "TINY" | "SMALL" | "MEDIUM" | "LARGE";

export type WikiEditEvent = {
  id: string;
  title: string;
  sizeDelta: number;
  isBot: boolean;
  isRevert: boolean;
  timestamp: number;
  magnitude: EditMagnitude;
  pageUrl?: string;
  editUrl?: string;
};
