export type LatLng = { lat: number; lng: number };

/** Straight-line distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median point: robust to one far-away candidate. */
export function centreOf(points: LatLng[]): LatLng | undefined {
  const lat = median(points.map((p) => p.lat));
  const lng = median(points.map((p) => p.lng));
  return lat === undefined || lng === undefined ? undefined : { lat, lng };
}

/** Typical distance from a point to a set of points (median), in km. */
export function typicalDistanceKm(from: LatLng, to: LatLng[]): number | undefined {
  return median(to.map((p) => haversineKm(from, p)));
}

/** Road distance is roughly 1.3× the straight line between consecutive points. */
export const ROAD_FACTOR = 1.3;

export function approxRouteKm(points: LatLng[]): number {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return km * ROAD_FACTOR;
}
