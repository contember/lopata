import { useState, useEffect } from "preact/hooks";

export function useRoute(): string {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");

  useEffect(() => {
    const handler = () => setRoute(location.hash.slice(1) || "/");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return route;
}

export function navigate(path: string) {
  location.hash = path;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function classNames(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
