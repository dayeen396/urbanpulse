import { useEffect, useRef } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { NoiseAnalysis, NoiseClass } from "./api";

type NoiseModelName = "classical" | "random_forest" | "neural";

const MODEL_NAMES: Record<NoiseModelName, string> = {
  classical: "Classical · SVM",
  random_forest: "Classical · Random forest",
  neural: "Neural · ResNet-18",
};

function Spectrogram({ analysis }: { analysis: NoiseAnalysis }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spectrogram = analysis.spectrogram;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spectrogram?.values.length) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    canvas.width = spectrogram.timeBins;
    canvas.height = spectrogram.frequencyBins;
    spectrogram.values.forEach((row, rowIndex) => {
      row.forEach((rawValue, columnIndex) => {
        const value = Math.max(0, Math.min(1, rawValue));
        const hue = 235 - value * 220;
        const lightness = 12 + value * 48;
        context.fillStyle = `hsl(${hue} 85% ${lightness}%)`;
        context.fillRect(columnIndex, canvas.height - rowIndex - 1, 1, 1);
      });
    });
  }, [spectrogram]);

  if (!spectrogram) return null;
  return (
    <figure>
      <figcaption className="mb-2 text-sm font-semibold">Log-mel spectrogram</figcaption>
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-[#607779]" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Frequency ↑</span>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Log-mel spectrogram: frequency on the vertical axis and time on the horizontal axis, showing normalized audio energy"
          className="h-52 w-full rounded-lg bg-[#122e30]"
          style={{ imageRendering: "pixelated" }}
        />
      </div>
      <div className="mt-1 flex justify-between pl-7 text-[11px] text-[#607779]">
        <span>Start</span><span>Time →</span><span>End</span>
      </div>
      <p className="mt-1 text-[11px] text-[#607779]">
        Normalized log-mel energy · {spectrogram.frequencyBins} × {spectrogram.timeBins} display bins (downsampled)
      </p>
    </figure>
  );
}

export function NoiseAnalysisPanel({
  analysis,
  mode,
}: {
  analysis: NoiseAnalysis | null | undefined;
  mode: string;
}) {
  if (!analysis) {
    return <p className="mt-3 text-sm text-[#607779]">Detailed signal analysis is unavailable for this report.</p>;
  }

  const audio = analysis.audio;
  const features = analysis.acousticFeatures;
  const selectedModel = mode === "classical" || mode === "random_forest" || mode === "neural"
    ? analysis.models?.[mode]
    : undefined;
  const classProbabilities = selectedModel?.classProbabilities;
  const probabilityData = classProbabilities
    ? (Object.entries(classProbabilities) as [NoiseClass, number][])
      .map(([name, probability]) => ({ name, probability: probability * 100 }))
    : [];
  const modelResults = (["classical", "random_forest", "neural"] as const).map((name) => ({
    name,
    result: analysis.models?.[name],
  }));

  return (
    <div className="mt-4 space-y-5 border-t border-[#e7ece4] pt-4">
      <section>
        <h3 className="text-sm font-semibold">Signal quality & capture</h3>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[
            ["Duration", audio ? `${audio.durationSeconds.toFixed(2)} s` : "Unavailable"],
            ["Analysis rate", audio ? `${audio.sampleRateHz.toLocaleString()} Hz · mono` : "Unavailable"],
            ["Peak amplitude", audio ? audio.peakAmplitude.toFixed(4) : "Unavailable"],
            ["RMS amplitude", audio ? audio.rmsAmplitude.toFixed(4) : "Unavailable"],
            ["Clipped samples", audio ? `${audio.clippedSamplesPercent.toFixed(2)}%` : "Unavailable"],
            ["Inference time", analysis.inferenceDurationMs === undefined ? "Unavailable" : `${analysis.inferenceDurationMs.toFixed(1)} ms`],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-[#f2f5ee] p-3">
              <p className="text-[11px] text-[#607779]">{label}</p>
              <p className="mt-1 text-sm font-semibold">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold">Acoustic descriptors</h3>
        {features ? (
          <>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {[
                ["Spectral centroid", `${features.spectralCentroidHz.toLocaleString()} Hz`],
                ["Spectral bandwidth", `${features.spectralBandwidthHz.toLocaleString()} Hz`],
                ["Spectral rolloff", `${features.spectralRolloffHz.toLocaleString()} Hz`],
                ["Zero-crossing rate", features.zeroCrossingRate.toFixed(4)],
                ["Spectral flatness", features.spectralFlatness.toFixed(4)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-lg border border-[#e7ece4] p-3">
                  <p className="text-[11px] text-[#607779]">{label}</p>
                  <p className="mt-1 text-sm font-semibold">{value}</p>
                </div>
              ))}
            </div>
            <div className="mt-3">
              <p className="mb-2 text-xs font-semibold text-[#496365]">Mean MFCC coefficients (13)</p>
              <div className="grid grid-cols-7 gap-1 sm:grid-cols-[repeat(13,minmax(0,1fr))]">
                {features.mfccMeans.map((value, index) => (
                  <div key={index} className="rounded bg-[#f2f5ee] px-1 py-2 text-center">
                    <p className="text-[9px] text-[#607779]">C{index}</p>
                    <p className="text-[10px] font-semibold">{value.toFixed(1)}</p>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : <p className="mt-2 text-sm text-[#607779]">Acoustic features are not available.</p>}
      </section>

      <section>
        <h3 className="text-sm font-semibold">Model comparison</h3>
        <p className="mt-1 text-xs text-[#607779]">
          These are per-model outputs for this clip, not evaluation metrics. Only the currently selected model determines the report label.
        </p>
        <div className="mt-2 grid gap-2 lg:grid-cols-3">
          {modelResults.map(({ name, result }) => (
            <div key={name} className="rounded-lg border border-[#e7ece4] p-3">
              <p className="text-xs font-bold">{MODEL_NAMES[name]}</p>
              {result?.available ? (
                <p className="mt-1 text-sm">
                  {result.predictedClass} · {((result.confidence ?? 0) * 100).toFixed(1)}% model confidence
                  <span className="block text-[11px] text-[#607779]">{result.modelVersion}</span>
                </p>
              ) : (
                <p className="mt-1 text-xs text-[#607779]">{result?.reason ?? "No model output was recorded."}</p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-xs text-[#607779]">
          Available-model agreement: {analysis.modelAgreement === "agree" ? "all available models predict the same class"
            : analysis.modelAgreement === "disagree" ? "available models predict different classes"
              : "model comparison unavailable"}
        </p>
      </section>

      {probabilityData.length > 0 ? (
        <section>
          <h3 className="text-sm font-semibold">Selected model class probabilities</h3>
          <div className="mt-2 h-64 w-full" role="img" aria-label="Bar chart showing class probabilities from the selected model">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={probabilityData} margin={{ top: 8, right: 12, bottom: 24, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" angle={-24} textAnchor="end" interval={0} height={54} tick={{ fontSize: 10 }} />
                <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 10 }} />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}%`, "Class probability"]} />
                <Bar dataKey="probability" fill="#d8663d" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>
      ) : (
        <p className="rounded-lg bg-[#fff7df] p-3 text-sm text-[#6e5c34]">
          No class probabilities are available because no trained noise model is installed. The fallback label is not a prediction.
        </p>
      )}

      <Spectrogram analysis={analysis} />
      {analysis.provenance && (
        <p className="text-[11px] leading-5 text-[#607779]">
          Pipeline {analysis.provenance.analysisVersion} · {analysis.provenance.resampling} · {analysis.provenance.spectrogram}.
        </p>
      )}
    </div>
  );
}
