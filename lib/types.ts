export type ReturnPoint = { date: string; value: number };

export type SeriesData = {
  id: string;
  name: string;
  source: "french" | "yahoo" | "custom";
  returns: ReturnPoint[];
  active?: boolean;
  highlighted?: boolean;
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
  | "Size / Dividend Yield"
  | "Size"
  | "Book-to-Market"
  | "Profitability"
  | "Momentum"
  | "Dividend Yield"
  | "Investment"
  | "Earnings/Price"
  | "Cashflow/Price"
  | "Industry / Sector";
