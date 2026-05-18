export type ReturnPoint = { date: string; value: number };

export type SeriesData = {
  id: string;
  name: string;
  source: "french" | "yahoo" | "custom";
  returns: ReturnPoint[];
  active?: boolean;
};

export type FrenchDatasetMeta = {
  id: string;
  region: Region;
  family: Family;
  label: string;
};

export type Region =
  | "US"
  | "Developed"
  | "Developed ex US"
  | "Europe"
  | "Asia Pacific ex Japan"
  | "North America"
  | "Emerging Markets";

export type Family =
  | "Size / Book-to-Market"
  | "Size / Profitability"
  | "Size / Momentum"
  | "Size"
  | "Profitability"
  | "Momentum"
  | "Industry / Sector";
