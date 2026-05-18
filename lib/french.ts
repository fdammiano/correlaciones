import JSZip from "jszip";
import type { FrenchDatasetMeta, ReturnPoint } from "./types";

const BASE = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp";

export const FRENCH_DATASETS: FrenchDatasetMeta[] = [
  // US
  { id: "6_Portfolios_2x3", region: "US", family: "Size / Book-to-Market", label: "6 Portfolios Size × Book-to-Market" },
  { id: "6_Portfolios_ME_OP_2x3", region: "US", family: "Size / Profitability", label: "6 Portfolios Size × OP" },
  { id: "10_Industry_Portfolios", region: "US", family: "Industry / Sector", label: "10 Industry Portfolios" },
  { id: "12_Industry_Portfolios", region: "US", family: "Industry / Sector", label: "12 Industry Portfolios" },
  { id: "30_Industry_Portfolios", region: "US", family: "Industry / Sector", label: "30 Industry Portfolios" },
  { id: "48_Industry_Portfolios", region: "US", family: "Industry / Sector", label: "48 Industry Portfolios" },

  // Developed
  { id: "Developed_6_Portfolios_ME_BE-ME", region: "Developed", family: "Size / Book-to-Market", label: "Developed 6 Portfolios Size × BE/ME" },
  { id: "Developed_6_Portfolios_ME_OP", region: "Developed", family: "Size / Profitability", label: "Developed 6 Portfolios Size × OP" },

  // Developed ex US
  { id: "Developed_ex_US_6_Portfolios_ME_BE-ME", region: "Developed ex US", family: "Size / Book-to-Market", label: "Developed ex-US 6 Portfolios Size × BE/ME" },
  { id: "Developed_ex_US_6_Portfolios_ME_OP", region: "Developed ex US", family: "Size / Profitability", label: "Developed ex-US 6 Portfolios Size × OP" },

  // Europe
  { id: "Europe_6_Portfolios_ME_BE-ME", region: "Europe", family: "Size / Book-to-Market", label: "Europe 6 Portfolios Size × BE/ME" },
  { id: "Europe_6_Portfolios_ME_OP", region: "Europe", family: "Size / Profitability", label: "Europe 6 Portfolios Size × OP" },

  // Asia Pacific ex Japan
  { id: "Asia_Pacific_ex_Japan_6_Portfolios_ME_BE-ME", region: "Asia Pacific ex Japan", family: "Size / Book-to-Market", label: "Asia Pacific ex-Japan 6 Portfolios Size × BE/ME" },
  { id: "Asia_Pacific_ex_Japan_6_Portfolios_ME_OP", region: "Asia Pacific ex Japan", family: "Size / Profitability", label: "Asia Pacific ex-Japan 6 Portfolios Size × OP" },

  // North America
  { id: "North_America_6_Portfolios_ME_BE-ME", region: "North America", family: "Size / Book-to-Market", label: "North America 6 Portfolios Size × BE/ME" },
  { id: "North_America_6_Portfolios_ME_OP", region: "North America", family: "Size / Profitability", label: "North America 6 Portfolios Size × OP" },

  // Emerging Markets (Ken French publica 5 portafolios, no 6)
  { id: "Emerging_5_Portfolios_BEME", region: "Emerging Markets", family: "Size / Book-to-Market", label: "Emerging 5 Portfolios BE/ME" },
  { id: "Emerging_5_Portfolios_OP", region: "Emerging Markets", family: "Size / Profitability", label: "Emerging 5 Portfolios OP" },
];

export type FrenchTable = {
  title: string;
  columns: string[];
  rows: { date: string; values: (number | null)[] }[];
};

const MISSING = new Set([-99.99, -999, -99.9999]);

function monthEndISO(yyyymm: string): string | null {
  if (yyyymm.length !== 6 || !/^\d{6}$/.test(yyyymm)) return null;
  const y = parseInt(yyyymm.slice(0, 4), 10);
  const m = parseInt(yyyymm.slice(4, 6), 10);
  if (m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0));
  return last.toISOString().slice(0, 10);
}

export function parseFrenchCSV(text: string): FrenchTable[] {
  const lines = text.split(/\r?\n/);
  const tables: FrenchTable[] = [];
  let i = 0;
  let lastTitle = "";

  while (i < lines.length) {
    const raw = lines[i];
    const line = (raw ?? "").trim();
    if (!line) {
      i++;
      continue;
    }

    // header row looks like: ",col1,col2,..." (starts with comma) — sometimes preceded by a title line
    const looksLikeHeader = line.startsWith(",") && line.includes(",");
    if (!looksLikeHeader) {
      // remember as potential title
      lastTitle = line;
      i++;
      continue;
    }

    const columns = line.split(",").slice(1).map((c) => c.trim());
    const rows: { date: string; values: (number | null)[] }[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const rl = (lines[j] ?? "").trim();
      if (!rl) break;
      const parts = rl.split(",").map((p) => p.trim());
      const dateStr = parts[0];
      if (!/^\d{4,8}$/.test(dateStr)) break;
      if (dateStr.length !== 6) {
        // skip annual rows (4 digits) — we only want monthly
        j++;
        continue;
      }
      const iso = monthEndISO(dateStr);
      if (!iso) {
        j++;
        continue;
      }
      const values = parts.slice(1).map((p) => {
        const n = parseFloat(p);
        if (Number.isNaN(n) || MISSING.has(n)) return null;
        return n / 100;
      });
      rows.push({ date: iso, values });
      j++;
    }
    if (rows.length > 0) {
      tables.push({ title: lastTitle, columns, rows });
    }
    i = j;
    lastTitle = "";
  }
  return tables;
}

export async function fetchFrenchDataset(name: string): Promise<FrenchTable> {
  const url = `${BASE}/${name}_CSV.zip`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (CorrelationsApp/1.0)",
      Accept: "*/*",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Ken French fetch failed (${res.status}) for ${name}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = await JSZip.loadAsync(buf);
  const csvName = Object.keys(zip.files).find((f) => /\.csv$/i.test(f));
  if (!csvName) throw new Error(`No CSV inside ${name}_CSV.zip`);
  const text = await zip.files[csvName].async("string");

  const tables = parseFrenchCSV(text);
  if (tables.length === 0) throw new Error(`Could not parse ${name}`);

  // pick first monthly table; prefer titles containing "Monthly" + "Value Weighted"
  const scored = tables.map((t, idx) => {
    const title = t.title.toLowerCase();
    let score = 0;
    if (title.includes("monthly")) score += 10;
    if (title.includes("value")) score += 5;
    if (title.includes("equal")) score -= 1;
    if (title.includes("annual")) score -= 100;
    score += Math.min(t.rows.length, 1500) / 1000;
    return { t, idx, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].t;
}
