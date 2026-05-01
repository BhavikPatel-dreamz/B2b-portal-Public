declare global {
  // eslint-disable-next-line no-var
  var __dashboardStatsCache:
    | Map<string, { data: unknown; timestamp: number }>
    | undefined;
}

export const dashboardStatsCache: Map<
  string,
  { data: unknown; timestamp: number }
> =
  globalThis.__dashboardStatsCache ??
  (globalThis.__dashboardStatsCache = new Map());

export const DASHBOARD_STATS_TTL = 3 * 60 * 1000; // 3 min

export const clearDashboardStatsCache = (shop: string) => {
  const key = `dashboard-stats-${shop}`;
  dashboardStatsCache.delete(key);
  console.log("Dashboard stats cache cleared for:", key);
};
