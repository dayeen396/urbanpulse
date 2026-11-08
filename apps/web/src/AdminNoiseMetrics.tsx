import { useEffect, useState } from "react";
import { getNoiseMetrics, type NoiseMetrics, type ModelMetrics } from "./api";

interface AdminNoiseMetricsProps {
  accessToken: string;
}

function EvaluationCard({
  title,
  algorithm,
  version,
  metrics,
}: {
  title: string;
  algorithm?: string;
  version?: string;
  metrics: ModelMetrics | null;
}) {
  return (
    <article className="rounded-2xl border border-[#d6dfd3] bg-white p-5">
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-[#bc5930]">{title}</p>
      <p className="mt-2 text-sm leading-6 text-[#496365]">{algorithm ?? "No trained model available yet."}</p>
      {metrics ? (
        <>
          <p className="mt-4 text-xs text-[#607779]">Version {version ?? "unknown"} · measured on held-out evaluation data</p>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-[#f2f5ee] p-3">
              <p className="text-xs text-[#607779]">Accuracy</p>
              <p className="mt-1 text-2xl font-semibold">{(metrics.accuracy * 100).toFixed(1)}%</p>
            </div>
            <div className="rounded-xl bg-[#f2f5ee] p-3">
              <p className="text-xs text-[#607779]">Macro F1</p>
              <p className="mt-1 text-2xl font-semibold">{metrics.macro_f1.toFixed(3)}</p>
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <p className="mb-2 text-xs font-semibold text-[#496365]">Confusion matrix · actual rows / predicted columns</p>
            <table className="w-full border-collapse text-center text-[10px]">
              <thead><tr><th className="p-1 text-left">Class</th>{metrics.class_labels.map((label) => <th key={label} className="max-w-12 p-1 font-medium">{label}</th>)}</tr></thead>
              <tbody>
                {metrics.confusion_matrix.map((row, rowIndex) => (
                  <tr key={metrics.class_labels[rowIndex]}>
                    <th className="whitespace-nowrap p-1 text-left font-semibold">{metrics.class_labels[rowIndex]}</th>
                    {row.map((count, columnIndex) => <td key={metrics.class_labels[columnIndex]} className="border border-[#e7ece4] p-1">{count}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="mt-4 rounded-lg bg-[#fff7df] p-3 text-sm text-[#6e5c34]">No evaluation results recorded. Metrics are intentionally omitted until a real labeled evaluation is run.</p>
      )}
    </article>
  );
}

export function AdminNoiseMetrics({ accessToken }: AdminNoiseMetricsProps) {
  const [metrics, setMetrics] = useState<NoiseMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getNoiseMetrics(accessToken)
      .then((result) => {
        if (active) setMetrics(result);
      })
      .catch((requestError: unknown) => {
        if (active) setError(requestError instanceof Error ? requestError.message : "Could not load noise model metrics.");
      });
    return () => { active = false; };
  }, [accessToken]);

  return (
    <main className="min-h-screen bg-[#f2f5ee] px-5 py-8 text-[#122e30] md:px-8">
      <div className="mx-auto max-w-6xl">
        <a href="/" className="text-sm font-semibold text-[#a34325]">← Back to UrbanPulse</a>
        <p className="mt-8 text-xs font-bold uppercase tracking-[0.18em] text-[#bc5930]">Admin · Model evaluation</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Noise classifier comparison</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#607779]">
          Metrics below are written by the training script from a stratified held-out evaluation split. Training-set accuracy is not reported as evaluation performance.
        </p>
        {error && <p role="alert" className="mt-5 rounded-xl bg-[#fff0e9] p-4 text-sm text-[#a33f28]">{error}</p>}
        {!metrics && !error && <p className="mt-6 text-sm text-[#607779]">Loading current model status…</p>}
        {metrics && (
          <>
            {!metrics.trained && (
              <div className="mt-6 rounded-xl border border-[#e5cf9f] bg-[#fff7df] p-4 text-sm leading-6 text-[#6e5c34]">
                {metrics.message ?? "No real labeled evaluation has been run yet."} The live classifier is currently in <strong>{metrics.mode}</strong> mode.
              </div>
            )}
            {metrics.dataset && (
              <div className="mt-5 rounded-xl border border-[#d6dfd3] bg-white p-4 text-sm text-[#496365]">
                <p><strong>Evaluation set:</strong> {metrics.dataset.evaluation_samples} clips; {metrics.dataset.samples} labeled records total.</p>
                <p className="mt-1"><strong>Protocol:</strong> {metrics.dataset.evaluation}</p>
                <p className="mt-1"><strong>Data sources:</strong> {metrics.dataset.sources.join(", ")}</p>
                {metrics.trained_at && <p className="mt-1"><strong>Trained:</strong> {new Date(metrics.trained_at).toLocaleString()}</p>}
              </div>
            )}
            <div className="mt-5 grid gap-5 xl:grid-cols-3">
              <EvaluationCard title="Classical baseline" {...metrics.models.classical} />
              <EvaluationCard title="Random forest baseline" {...metrics.models.random_forest} />
              <EvaluationCard title="Neural transfer model" {...metrics.models.neural} />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
