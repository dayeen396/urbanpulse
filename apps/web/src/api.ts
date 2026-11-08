export interface NoiseReport {
  id: string;
  latitude: number;
  longitude: number;
  status: string;
  predictedClass: string | null;
  userLabel?: string | null;
  confidence: number | null;
  approximateDb: number | null;
  mode: string;
  modelVersion: string | null;
  analysis?: NoiseAnalysis | null;
  isSimulated: boolean;
  createdAt: string;
  progress?: number;
}

export type NoiseClass = "horn" | "construction" | "siren" | "traffic" | "engine" | "crowd" | "other";

export interface NoiseModelResult {
  available: boolean;
  reason?: string;
  predictedClass?: NoiseClass;
  confidence?: number;
  modelVersion?: string;
  classProbabilities?: Partial<Record<NoiseClass, number>>;
}

export interface NoiseAnalysis {
  audio?: {
    durationSeconds: number;
    sampleRateHz: number;
    channelsAnalyzed: number;
    sampleCount: number;
    rmsAmplitude: number;
    peakAmplitude: number;
    clippedSamplesPercent: number;
  };
  acousticFeatures?: {
    zeroCrossingRate: number;
    spectralCentroidHz: number;
    spectralBandwidthHz: number;
    spectralRolloffHz: number;
    spectralFlatness: number;
    mfccMeans: number[];
  };
  spectrogram?: {
    scale: string;
    frequencyBins: number;
    timeBins: number;
    values: number[][];
  };
  models?: {
    classical?: NoiseModelResult;
    random_forest?: NoiseModelResult;
    neural?: NoiseModelResult;
  };
  modelAgreement?: "agree" | "disagree" | "comparison_unavailable";
  inferenceDurationMs?: number;
  provenance?: {
    analysisVersion: string;
    resampling: string;
    spectrogram: string;
    dbEstimate: string;
  };
}

export interface AuthResult {
  user: { id: string; email: string; display_name: string; role: "citizen" | "official" | "admin" };
  accessToken: string;
  refreshToken: string;
}

export interface ModelMetrics {
  accuracy: number;
  macro_f1: number;
  confusion_matrix: number[][];
  class_labels: string[];
}

export interface NoiseMetrics {
  task: "noise-classification";
  trained: boolean;
  mode: string;
  model_version?: string;
  message?: string;
  trained_at?: string;
  dataset?: {
    manifest: string;
    samples: number;
    training_samples: number;
    evaluation_samples: number;
    class_counts: Record<string, number>;
    sources: string[];
    evaluation: string;
  };
  models: {
    classical: { available: boolean; algorithm?: string; version?: string; metrics: ModelMetrics | null };
    random_forest: { available: boolean; algorithm?: string; version?: string; metrics: ModelMetrics | null };
    neural: { available: boolean; algorithm?: string; version?: string; metrics: ModelMetrics | null };
  };
}

const apiBaseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:3000/api/v1";
export const socketUrl = apiBaseUrl.replace(/\/api\/v1\/?$/, "");
const authStorageKey = "urbanpulse.auth";

function readStoredAuth(): AuthResult | null {
  const saved = sessionStorage.getItem(authStorageKey);
  if (!saved) return null;
  try {
    return JSON.parse(saved) as AuthResult;
  } catch {
    sessionStorage.removeItem(authStorageKey);
    return null;
  }
}

async function request<T>(path: string, token?: string, init: RequestInit = {}, canRefresh = true): Promise<T> {
  const savedAuth = readStoredAuth();
  const activeToken = savedAuth?.accessToken ?? token;
  const headers = new Headers(init.headers);
  if (activeToken) headers.set("Authorization", `Bearer ${activeToken}`);
  const response = await fetch(`${apiBaseUrl}${path}`, { ...init, headers });

  if (response.status === 401 && canRefresh && savedAuth?.refreshToken) {
    const refreshResponse = await fetch(`${apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: savedAuth.refreshToken }),
    });
    if (refreshResponse.ok) {
      const refreshed = await refreshResponse.json() as AuthResult;
      sessionStorage.setItem(authStorageKey, JSON.stringify(refreshed));
      return request<T>(path, refreshed.accessToken, init, false);
    }
    sessionStorage.removeItem(authStorageKey);
    window.dispatchEvent(new Event("urbanpulse:auth-expired"));
  }

  if (response.status === 204) return undefined as T;
  const payload = await response.json() as { error?: { message?: string } } & T;
  if (!response.ok) throw new Error(payload.error?.message ?? `Request failed (${response.status})`);
  return payload;
}

export function signIn(email: string, password: string): Promise<AuthResult> {
  return request<AuthResult>("/auth/login", undefined, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

export function signUp(email: string, password: string, displayName: string): Promise<AuthResult> {
  return request<AuthResult>("/auth/register", undefined, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
}

export async function signOut(token: string, refreshToken: string): Promise<void> {
  const activeRefreshToken = readStoredAuth()?.refreshToken ?? refreshToken;
  await request<void>("/auth/logout", token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: activeRefreshToken }),
  });
}

export async function getNoiseReports(token?: string): Promise<NoiseReport[]> {
  const response = await request<{ reports: NoiseReport[] }>("/reports/noise?limit=250", token);
  return response.reports;
}

export async function getMyNoiseReports(token: string): Promise<NoiseReport[]> {
  const response = await request<{ reports: NoiseReport[] }>("/reports/noise/mine", token);
  return response.reports;
}

export function submitNoiseReport(token: string, audio: File, latitude: number, longitude: number) {
  const body = new FormData();
  body.set("audio", audio);
  body.set("latitude", String(latitude));
  body.set("longitude", String(longitude));
  return request<{ report: NoiseReport; jobId: string }>("/reports/noise", token, {
    method: "POST",
    body,
  });
}

export function deleteNoiseReport(token: string, reportId: string): Promise<void> {
  return request<void>(`/reports/noise/${encodeURIComponent(reportId)}`, token, { method: "DELETE" });
}

export function correctNoiseLabel(token: string, reportId: string, label: NoiseClass): Promise<{ report: NoiseReport }> {
  return request<{ report: NoiseReport }>(`/reports/noise/${encodeURIComponent(reportId)}/label`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
}

export function getNoiseMetrics(token: string): Promise<NoiseMetrics> {
  return request<NoiseMetrics>("/admin/noise-metrics", token);
}
