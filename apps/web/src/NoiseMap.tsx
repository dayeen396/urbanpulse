import { useEffect, useRef, useState } from "react";
import * as L from "leaflet";
import { io } from "socket.io-client";
import { getNoiseReports, socketUrl, type NoiseReport } from "./api";
import "leaflet/dist/leaflet.css";

interface NoiseMapProps {
  accessToken?: string;
  onReportUpdate?: (report: NoiseReport) => void;
  onLocationPick?: (latitude: number, longitude: number) => void;
  onConnected?: () => void;
}

function popupContent(report: NoiseReport): HTMLElement {
  const content = document.createElement("div");
  content.className = "map-popup";
  const heading = document.createElement("strong");
  heading.textContent = report.predictedClass
    ? `Noise estimate: ${report.predictedClass}`
    : "Noise submission";
  const detail = document.createElement("span");
  detail.textContent = report.status === "processed" && report.mode === "stub"
    ? "Stub result only · no trained model or dB estimate"
    : report.status === "processed" && report.approximateDb !== null
      ? `Approx. ${report.approximateDb} dB · uncalibrated`
      : `Processing status: ${report.status}`;
  const source = document.createElement("span");
  source.textContent = report.isSimulated ? "Simulated demo data" : "Crowdsourced estimate";
  content.append(heading, detail, source);
  return content;
}

export function NoiseMap({ accessToken, onReportUpdate, onLocationPick, onConnected }: NoiseMapProps) {
  const mapElement = useRef<HTMLDivElement>(null);
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    if (!mapElement.current) return;
    const map = L.map(mapElement.current, { scrollWheelZoom: false }).setView([23.8103, 90.4125], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const markers = new Map<string, L.CircleMarker>();
    const reportById = new Map<string, NoiseReport>();
    const liveVersions = new Map<string, number>();
    const deletedReportIds = new Set<string>();
    let liveSequence = 0;
    let selectedPin: L.CircleMarker | undefined;
    let active = true;

    const upsertReport = (report: NoiseReport, fromLiveEvent = false) => {
      if (!active || deletedReportIds.has(report.id)) return;
      if (fromLiveEvent) liveVersions.set(report.id, ++liveSequence);
      const current = reportById.get(report.id);
      if (current?.status === "processed" && report.status !== "processed") return;
      reportById.set(report.id, report);
      const marker = markers.get(report.id) ?? L.circleMarker([report.latitude, report.longitude], {
        radius: 8,
        color: "#b54f2f",
        weight: 2,
        fillColor: report.status === "processed" ? "#e77e46" : "#f4b65d",
        fillOpacity: 0.88,
      }).addTo(map);
      marker.setLatLng([report.latitude, report.longitude]);
      marker.setPopupContent(popupContent(report));
      markers.set(report.id, marker);
      onReportUpdate?.(report);
    };

    const refreshReports = () => {
      const requestSequence = liveSequence;
      return getNoiseReports(accessToken)
        .then((reports) => {
          if (!active) return;
          const currentIds = new Set(reports.map((report) => report.id));
          for (const [reportId, marker] of markers) {
            if (!currentIds.has(reportId) && (liveVersions.get(reportId) ?? 0) <= requestSequence) {
              marker.remove();
              markers.delete(reportId);
              reportById.delete(reportId);
            }
          }
          for (const report of reports) {
            if ((liveVersions.get(report.id) ?? 0) <= requestSequence) upsertReport(report);
          }
        })
        .catch((error: unknown) => setMapError(error instanceof Error ? error.message : "Could not load map reports."));
    };
    void refreshReports();

    const socket = io(socketUrl, { transports: ["websocket", "polling"] });
    socket.on("report:new", (report: NoiseReport) => upsertReport(report, true));
    socket.on("report:processed", (report: NoiseReport) => upsertReport(report, true));
    socket.on("job:progress", ({ reportId, progress, status }: { reportId: string; progress: number; status: NoiseReport["status"] }) => {
      const current = reportById.get(reportId);
      if (!current) return;
      upsertReport({ ...current, status, progress }, true);
    });
    socket.on("report:deleted", ({ reportId }: { reportId: string }) => {
      liveVersions.set(reportId, ++liveSequence);
      deletedReportIds.add(reportId);
      markers.get(reportId)?.remove();
      markers.delete(reportId);
      reportById.delete(reportId);
    });
    socket.on("connect_error", () => {
      setMapError("Live updates are reconnecting; existing map reports remain available.");
    });
    socket.on("connect", () => {
      setMapError(null);
      void refreshReports();
      onConnected?.();
    });
    const pickLocation = (event: L.LeafletMouseEvent) => {
      if (!onLocationPick) return;
      selectedPin?.remove();
      selectedPin = L.circleMarker(event.latlng, {
        radius: 8,
        color: "#1d663e",
        weight: 3,
        fillColor: "#b9e2c1",
        fillOpacity: 1,
      }).addTo(map);
      onLocationPick(event.latlng.lat, event.latlng.lng);
    };
    map.on("click", pickLocation);

    return () => {
      active = false;
      map.off("click", pickLocation);
      socket.disconnect();
      map.remove();
    };
  }, [accessToken, onConnected, onLocationPick, onReportUpdate]);

  return (
    <section className="overflow-hidden rounded-[1.7rem] border border-[#d6dfd3] bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#e7ece4] px-5 py-4">
        <div>
          <h2 className="font-semibold">Neighborhood noise map</h2>
          <p className="text-xs text-[#607779]">{onLocationPick ? "Tap the map to place your report pin · Dhaka" : "Crowdsourced reports · Dhaka"}</p>
        </div>
        <span className="rounded-full bg-[#fff0e7] px-3 py-1 text-xs font-semibold text-[#a34325]">● Noise layer</span>
      </div>
      <div ref={mapElement} className="noise-map" aria-label="Live noise report map" />
      {mapError && <p className="border-t border-[#e7ece4] px-5 py-3 text-sm text-[#9b4328]">{mapError}</p>}
      <p className="border-t border-[#e7ece4] px-5 py-3 text-xs leading-5 text-[#607779]">
        Colored points are community submissions, not official station readings. Map locations are rounded for display.
      </p>
    </section>
  );
}
