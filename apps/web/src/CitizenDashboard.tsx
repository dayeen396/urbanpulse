import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { correctNoiseLabel, deleteNoiseReport, getMyNoiseReports, submitNoiseReport, type NoiseClass, type NoiseReport } from "./api";
import { NoiseMap } from "./NoiseMap";

const NoiseAnalysisPanel = lazy(() => import("./NoiseAnalysisPanel").then((module) => ({
  default: module.NoiseAnalysisPanel,
})));

const DHAKA_DEMO_LOCATION = { latitude: 23.8103, longitude: 90.4125 };

interface CitizenDashboardProps {
  accessToken: string;
  displayName: string;
  onSignOut: () => void;
}

export function CitizenDashboard({ accessToken, displayName, onSignOut }: CitizenDashboardProps) {
  const [reports, setReports] = useState<NoiseReport[]>([]);
  const ownedReportIds = useRef(new Set<string>());
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [latitude, setLatitude] = useState(String(DHAKA_DEMO_LOCATION.latitude));
  const [longitude, setLongitude] = useState(String(DHAKA_DEMO_LOCATION.longitude));
  const [locationStatus, setLocationStatus] = useState<"locating" | "located" | "manual" | "approximate">("locating");
  const [locationAccuracy, setLocationAccuracy] = useState<number | null>(null);
  const [locationIssue, setLocationIssue] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const [requestingMicrophone, setRequestingMicrophone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [labelDrafts, setLabelDrafts] = useState<Record<string, NoiseClass>>({});
  const [savingLabelId, setSavingLabelId] = useState<string | null>(null);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const locationRequestId = useRef(0);
  const recordingStarted = useRef(0);
  const recordingTimer = useRef<number | null>(null);

  const refreshMyReports = useCallback(() => {
    void getMyNoiseReports(accessToken)
      .then((items) => {
        ownedReportIds.current = new Set(items.map((item) => item.id));
        setReports(items);
      })
      .catch((requestError: unknown) => setError(requestError instanceof Error ? requestError.message : "Could not load your reports."));
  }, [accessToken]);

  const receiveReport = useCallback((report: NoiseReport) => {
    if (!ownedReportIds.current.has(report.id)) return;
    setReports((current) => [report, ...current.filter((item) => item.id !== report.id)].slice(0, 100));
    if (report.status === "processed") refreshMyReports();
  }, [refreshMyReports]);

  useEffect(() => {
    refreshMyReports();
    return () => {
      if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, [refreshMyReports]);

  const findLocation = useCallback(() => {
    const requestId = ++locationRequestId.current;
    const useDemoLocation = (reason: string) => {
      if (requestId !== locationRequestId.current) return;
      setLatitude(DHAKA_DEMO_LOCATION.latitude.toFixed(6));
      setLongitude(DHAKA_DEMO_LOCATION.longitude.toFixed(6));
      setLocationAccuracy(null);
      setLocationStatus("approximate");
      setLocationIssue(reason);
    };

    if (!navigator.geolocation) {
      useDemoLocation("Device location is unavailable.");
      return;
    }

    setLocationStatus("locating");
    setLocationIssue(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (requestId !== locationRequestId.current) return;
        setLatitude(coords.latitude.toFixed(6));
        setLongitude(coords.longitude.toFixed(6));
        setLocationAccuracy(Math.round(coords.accuracy));
        setLocationStatus("located");
        setLocationIssue(null);
      },
      (locationError) => {
        if (requestId !== locationRequestId.current) return;
        if (locationError.code === locationError.PERMISSION_DENIED) {
          useDemoLocation("Location permission is blocked.");
          return;
        }
        navigator.geolocation.getCurrentPosition(
          ({ coords }) => {
            if (requestId !== locationRequestId.current) return;
            setLatitude(coords.latitude.toFixed(6));
            setLongitude(coords.longitude.toFixed(6));
            setLocationAccuracy(Math.round(coords.accuracy));
            setLocationStatus("located");
            setLocationIssue(null);
          },
          (retryError) => {
            if (requestId !== locationRequestId.current) return;
            const reason = retryError.code === retryError.PERMISSION_DENIED
              ? "Location permission is blocked."
              : retryError.code === retryError.TIMEOUT || locationError.code === locationError.TIMEOUT
                ? "Your device/browser did not provide a GPS fix."
                : "Your device location could not be determined.";
            useDemoLocation(reason);
          },
          { enableHighAccuracy: true, timeout: 8_000, maximumAge: 60_000 },
        );
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );
  }, []);

  useEffect(() => {
    findLocation();
  }, [findLocation]);

  const stopRecording = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
  }, []);

  const microphoneErrorMessage = (recordingError: unknown): string => {
    const name = typeof recordingError === "object" && recordingError !== null && "name" in recordingError
      ? String(recordingError.name)
      : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Microphone access was denied. Allow microphone permission for this site in your browser settings, then retry.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No microphone was found. Connect or enable a microphone, then retry.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "The microphone is unavailable or in use by another app. Close other apps using it and check your system microphone privacy settings.";
    }
    if (name === "SecurityError") {
      return "Microphone access is blocked for this page. Open UrbanPulse on localhost or an HTTPS address and allow microphone permission.";
    }
    if (name === "AbortError") {
      return "The browser or operating system stopped microphone access. Check microphone permissions and try again.";
    }
    if (name === "TypeError") {
      return "Microphone access requires a secure page. Open UrbanPulse using localhost or an HTTPS address.";
    }
    return "Could not start audio recording. Check browser microphone permission and your microphone, or choose an audio file instead.";
  };

  const saveLabel = async (report: NoiseReport) => {
    const label = labelDrafts[report.id] ?? (report.predictedClass as NoiseClass | null) ?? "other";
    setSavingLabelId(report.id);
    setError(null);
    setMessage(null);
    try {
      const { report: updatedReport } = await correctNoiseLabel(accessToken, report.id, label);
      setReports((current) => current.map((item) => item.id === report.id ? updatedReport : item));
      setMessage("Your confirmed label was saved to help improve future models.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not save your label.");
    } finally {
      setSavingLabelId(null);
    }
  };

  const startRecording = async () => {
    setError(null);
    setMessage(null);
    if (!window.isSecureContext && !["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
      setError("Microphone access requires a secure page. Open UrbanPulse on localhost or an HTTPS address.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser does not support microphone recording on this page. Open UrbanPulse on localhost or HTTPS, or choose an audio file instead.");
      return;
    }
    setRequestingMicrophone(true);
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = audioStream;
      const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find((type) => MediaRecorder.isTypeSupported(type));
      const mediaRecorder = new MediaRecorder(audioStream, preferredType ? { mimeType: preferredType } : undefined);
      recorder.current = mediaRecorder;
      const chunks: BlobPart[] = [];
      let recorderFailed = false;
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      mediaRecorder.onstop = () => {
        if (recorderFailed || chunks.length === 0) {
          if (!recorderFailed) {
            setError("No audio data was captured. Check that the selected microphone is enabled and try again.");
          }
          audioStream.getTracks().forEach((track) => track.stop());
          stream.current = null;
          recorder.current = null;
          if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
          recordingTimer.current = null;
          setRecording(false);
          return;
        }
        const type = mediaRecorder.mimeType || "audio/webm";
        const extension = type.includes("mp4") ? "m4a" : "webm";
        const file = new File(chunks, `urbanpulse-recording.${extension}`, { type });
        const durationSeconds = Number(((Date.now() - recordingStarted.current) / 1000).toFixed(1));
        setRecordedSeconds(Math.round(durationSeconds));
        setAudioFile(file);
        setMessage(`Recording ready (~${durationSeconds}s).`);
        audioStream.getTracks().forEach((track) => track.stop());
        stream.current = null;
        recorder.current = null;
        if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
        recordingTimer.current = null;
        setRecording(false);
      };
      mediaRecorder.onerror = () => {
        recorderFailed = true;
        setError("The browser could not encode the microphone audio. Try another microphone or choose an audio file instead.");
        if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
        recordingTimer.current = null;
        if (mediaRecorder.state === "recording") mediaRecorder.stop();
      };
      recordingStarted.current = Date.now();
      setRecordedSeconds(0);
      setRecording(true);
      mediaRecorder.start(250);
      recordingTimer.current = window.setInterval(() => {
        const elapsed = (Date.now() - recordingStarted.current) / 1000;
        setRecordedSeconds(Math.floor(elapsed));
        if (elapsed >= 9.8) stopRecording();
      }, 200);
    } catch (recordingError) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      recorder.current = null;
      if (recordingTimer.current !== null) window.clearInterval(recordingTimer.current);
      recordingTimer.current = null;
      setRecording(false);
      setError(microphoneErrorMessage(recordingError));
    } finally {
      setRequestingMicrophone(false);
    }
  };

  const selectMapLocation = useCallback((lat: number, lon: number) => {
    locationRequestId.current += 1;
    setLatitude(lat.toFixed(6));
    setLongitude(lon.toFixed(6));
    setLocationAccuracy(null);
    setLocationStatus("manual");
    setLocationIssue(null);
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    if (!audioFile) {
      setError("Record a short clip or choose an audio file first.");
      return;
    }
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      setError("Enter valid latitude and longitude coordinates.");
      return;
    }
    setBusy(true);
    try {
      const result = await submitNoiseReport(accessToken, audioFile, lat, lon);
      ownedReportIds.current.add(result.report.id);
      setExpandedReportId(result.report.id);
      receiveReport(result.report);
      setMessage(`Report queued for analysis (job ${result.jobId}). Keep this page open for the live result.`);
      setAudioFile(null);
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not submit the audio report.");
    } finally {
      setBusy(false);
    }
  };

  const removeReport = async (report: NoiseReport) => {
    setError(null);
    try {
      await deleteNoiseReport(accessToken, report.id);
      ownedReportIds.current.delete(report.id);
      setReports((current) => current.filter((item) => item.id !== report.id));
      setMessage("Report and its private raw audio were deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete the report.");
    }
  };

  return (
    <main className="min-h-screen bg-[#f2f5ee] text-[#122e30]">
      <header className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-5 md:px-8">
        <a href="/" className="text-xl font-bold tracking-tight">UrbanPulse<span className="text-[#e57b45]">.</span></a>
        <div className="flex items-center gap-4 text-sm">
          <span className="hidden text-[#496365] sm:inline">Welcome, {displayName}</span>
          <button type="button" onClick={onSignOut} className="rounded-full border border-[#cbd7ce] px-4 py-2 font-semibold hover:bg-white">Sign out</button>
        </div>
      </header>
      <section className="mx-auto max-w-7xl px-5 pb-12 md:px-8">
        <div className="mb-7">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#bc5930]">Dhaka · Citizen pilot</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Your neighborhood signal</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#496365]">Share a short ambient clip without recording speech intentionally. Your raw audio is private and is never played or exposed on the public map.</p>
        </div>

        <div className="mb-6 rounded-xl border border-[#e5cf9f] bg-[#fff7df] px-4 py-3 text-sm leading-6 text-[#6e5c34]">
          Noise and dB values are indicative estimates, not official measurements. Model confidence is not a guarantee of correctness or a substitute for held-out evaluation metrics.
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.75fr)]">
          <NoiseMap
            accessToken={accessToken}
            onReportUpdate={receiveReport}
            onLocationPick={selectMapLocation}
            onConnected={refreshMyReports}
          />
          <section className="rounded-[1.7rem] border border-[#d6dfd3] bg-white p-5 shadow-sm md:p-6">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#bc5930]">Add a sound observation</p>
            <h2 className="mt-2 text-xl font-semibold">Capture a short clip</h2>
            <p className="mt-2 text-sm leading-6 text-[#607779]">Record 5–10 seconds or upload a supported audio file up to 10 MB. The server verifies that the clip is no longer than 10 seconds.</p>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              {!recording ? (
                <button type="button" disabled={requestingMicrophone} onClick={() => void startRecording()} className="rounded-full bg-[#123b3d] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[#205457] disabled:cursor-wait disabled:opacity-60">
                  {requestingMicrophone ? "Requesting microphone…" : audioFile ? "Record again" : "Start recording"}
                </button>
              ) : (
                <button type="button" disabled={recordedSeconds < 5} onClick={stopRecording} className="rounded-full bg-[#bd4e35] px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
                  Stop recording · {recordedSeconds}s
                </button>
              )}
              <span className="text-xs text-[#607779]">{recording ? "Recording stops just before 10 seconds to stay within the server limit." : "Allow microphone access when your browser asks. Recording requires localhost or HTTPS."}</span>
            </div>
            <div className="mt-4">
              <label htmlFor="audio-file" className="mb-1.5 block text-sm font-semibold">Or choose an audio file</label>
              <input
                id="audio-file"
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  setAudioFile(event.target.files?.[0] ?? null);
                  setMessage(null);
                  setError(null);
                }}
                className="block w-full text-sm text-[#496365] file:mr-3 file:rounded-full file:border-0 file:bg-[#edf2ed] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-[#123b3d]"
              />
              {audioFile && <p className="mt-2 truncate text-xs text-[#496365]">Selected: {audioFile.name} · {(audioFile.size / 1024 / 1024).toFixed(2)} MB</p>}
            </div>

            <form onSubmit={(event) => void submit(event)} className="mt-6 border-t border-[#e7ece4] pt-5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <label className="text-sm font-semibold">Where was this recorded?</label>
                  <p role="status" className="mt-1 text-xs text-[#607779]">
                    {locationStatus === "locating" ? "Finding device GPS… approximate Dhaka coordinates are filled until then."
                      : locationStatus === "located" ? `Using your device location${locationAccuracy === null ? "" : ` · accuracy about ${locationAccuracy} m`}.`
                        : locationStatus === "manual" ? "Using your selected map pin or entered coordinates."
                          : `${locationIssue ?? "GPS unavailable."} Approximate Dhaka demo coordinates are filled, not your actual position; tap the map or enter coordinates manually.`}
                  </p>
                </div>
                <button type="button" onClick={findLocation} className="text-xs font-bold text-[#a34325] hover:underline">
                  {locationStatus === "located" ? "Refresh GPS" : "Retry GPS"}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <label className="text-xs font-medium text-[#607779]">
                  Latitude
                  <input required inputMode="decimal" type="number" min="-90" max="90" step="any" value={latitude} onChange={(event) => { locationRequestId.current += 1; setLatitude(event.target.value); setLocationAccuracy(null); setLocationStatus("manual"); setLocationIssue(null); }} placeholder="Latitude" className="mt-1 block w-full rounded-lg border border-[#cfdbd0] px-3 py-2.5 text-sm text-[#122e30] outline-none focus:border-[#d8663d]" />
                </label>
                <label className="text-xs font-medium text-[#607779]">
                  Longitude
                  <input required inputMode="decimal" type="number" min="-180" max="180" step="any" value={longitude} onChange={(event) => { locationRequestId.current += 1; setLongitude(event.target.value); setLocationAccuracy(null); setLocationStatus("manual"); setLocationIssue(null); }} placeholder="Longitude" className="mt-1 block w-full rounded-lg border border-[#cfdbd0] px-3 py-2.5 text-sm text-[#122e30] outline-none focus:border-[#d8663d]" />
                </label>
              </div>
              <button disabled={busy || recording} type="submit" className="mt-5 w-full rounded-full bg-[#d8663d] px-5 py-3 text-sm font-semibold text-white hover:bg-[#bb512c] disabled:cursor-not-allowed disabled:opacity-50">
                {busy ? "Uploading securely…" : "Submit noise report"}
              </button>
            </form>

            {error && <p role="alert" className="mt-4 rounded-lg bg-[#fff0e9] px-3 py-2.5 text-sm text-[#a33f28]">{error}</p>}
            {message && <p role="status" className="mt-4 rounded-lg bg-[#edf6ee] px-3 py-2.5 text-sm text-[#315d3b]">{message}</p>}
          </section>
        </div>

        <section className="mt-7 rounded-[1.7rem] border border-[#d6dfd3] bg-white p-5 shadow-sm md:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#bc5930]">Private history</p>
              <h2 className="mt-1 text-xl font-semibold">My noise reports</h2>
            </div>
            <span className="text-xs text-[#607779]">{reports.length} shown · delete removes the report and raw audio</span>
          </div>
          {reports.length === 0 ? (
            <p className="mt-5 text-sm text-[#607779]">Your submissions will appear here after you contribute a recording.</p>
          ) : (
            <ul className="mt-4 divide-y divide-[#e7ece4]">
              {reports.map((report) => (
                <li key={report.id} className="py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      {report.status === "processed" ? (report.predictedClass ?? "Unclassified") : `Report ${report.status}${report.progress ? ` · ${report.progress}%` : ""}`}
                      {report.mode === "fallback" && report.status === "processed" && <span className="ml-2 rounded-full bg-[#fff3d4] px-2 py-1 text-[10px] font-bold uppercase text-[#755a1b]">Fallback</span>}
                      {report.mode === "stub" && report.status === "processed" && <span className="ml-2 rounded-full bg-[#fff3d4] px-2 py-1 text-[10px] font-bold uppercase text-[#755a1b]">Stub</span>}
                    </p>
                    <p className="mt-1 text-xs text-[#607779]">{new Date(report.createdAt).toLocaleString()} · {report.latitude.toFixed(4)}, {report.longitude.toFixed(4)}</p>
                    <p className="mt-1 text-xs text-[#607779]">
                      {report.status !== "processed" ? "Processing is pending."
                        : report.mode === "stub" || report.mode === "fallback" ? "No trained classifier is available; this fallback label is not a model prediction."
                        : `Model confidence: ${report.confidence === null ? "unavailable" : `${(report.confidence * 100).toFixed(1)}%`}.`}
                      {report.status === "processed" && (report.approximateDb === null ? " Indicative dB estimate unavailable."
                        : ` Indicative RMS estimate: ${report.approximateDb} dB (uncalibrated; not a sound-level measurement).`)}
                    </p>
                    {report.status === "processed" && report.confidence !== null && report.mode !== "fallback" && report.mode !== "stub" && (
                      <p className="mt-1 text-xs text-[#607779]">Selected model: {report.mode} · {report.modelVersion ?? "version unavailable"}</p>
                    )}
                    {report.status === "processed" && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <label htmlFor={`label-${report.id}`} className="text-xs text-[#607779]">Confirm or correct:</label>
                        <select
                          id={`label-${report.id}`}
                          value={labelDrafts[report.id] ?? report.userLabel ?? (report.predictedClass as NoiseClass | null) ?? "other"}
                          onChange={(event) => setLabelDrafts((current) => ({ ...current, [report.id]: event.target.value as NoiseClass }))}
                          className="rounded-lg border border-[#cfdbd0] px-2 py-1 text-xs"
                        >
                          {(["horn", "construction", "siren", "traffic", "engine", "crowd", "other"] as const).map((label) => <option key={label} value={label}>{label}</option>)}
                        </select>
                        <button
                          type="button"
                          disabled={savingLabelId === report.id}
                          onClick={() => void saveLabel(report)}
                          className="rounded-full border border-[#cbd7ce] px-3 py-1 text-xs font-semibold hover:bg-[#edf2ed] disabled:opacity-50"
                        >
                          {savingLabelId === report.id ? "Saving…" : "Save label"}
                        </button>
                        {report.userLabel && <span className="text-xs text-[#315d3b]">Saved label: {report.userLabel}</span>}
                      </div>
                    )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setExpandedReportId((current) => current === report.id ? null : report.id)}
                      className="rounded-full border border-[#cbd7ce] px-3 py-1.5 text-xs font-semibold hover:bg-[#edf2ed]"
                    >
                      {expandedReportId === report.id ? "Hide analysis" : "Full analysis"}
                    </button>
                    <button type="button" onClick={() => void removeReport(report)} className="rounded-full border border-[#d7dcd4] px-3 py-1.5 text-xs font-semibold text-[#7b3b2b] hover:bg-[#fff0e9]">Delete report</button>
                  </div>
                  {expandedReportId === report.id && (
                    <Suspense fallback={<p className="mt-4 text-sm text-[#607779]">Loading signal analysis…</p>}>
                      <NoiseAnalysisPanel analysis={report.analysis} mode={report.mode} />
                    </Suspense>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </section>
    </main>
  );
}
