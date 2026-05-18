"use client";

import dynamic from "next/dynamic";

const Plot = dynamic(
  async () => {
    const Plotly = (await import("plotly.js-dist-min")).default;
    const createPlotlyComponent = (await import("react-plotly.js/factory"))
      .default;
    return createPlotlyComponent(Plotly as any);
  },
  { ssr: false, loading: () => <div className="text-sm text-zinc-500">Cargando gráfico…</div> },
);

type AnyObj = Record<string, unknown>;

export default function PlotlyChart({
  data,
  layout,
  height = 600,
}: {
  data: AnyObj[];
  layout?: AnyObj;
  height?: number;
}) {
  return (
    <Plot
      data={data as any}
      layout={
        {
          autosize: true,
          margin: { l: 50, r: 20, t: 50, b: 40 },
          paper_bgcolor: "white",
          plot_bgcolor: "white",
          ...(layout ?? {}),
        } as any
      }
      config={{ displaylogo: false, responsive: true } as any}
      style={{ width: "100%", height }}
      useResizeHandler
    />
  );
}
