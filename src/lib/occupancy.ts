import postgres from 'postgres';

interface OccupancyRow {
  unit_id: string; status: string; unit_group: string | null; created_at: string | null;
  exclude_from_occupancy: boolean; exclude_from_vacancy: boolean; exclude_from_revenue: boolean;
  unit_type: string | null; building: string | null; days_vacant: string | null;
  market_rent: string | null; monthly_rent: string | null; tenant_name: string | null; vacancy_status: string | null;
  source_report_date: string | null; has_source_status: boolean;
}

export function sourceFreshness(reportDate: string | null, now = new Date()) {
  const age = reportDate ? now.getTime() - Date.parse(reportDate) : NaN;
  const state = !Number.isFinite(age) || age < 0 ? 'unknown' : age > 48 * 3600000 ? 'stale' : 'current';
  return { source_report_date: reportDate, retrieved_at: now.toISOString(), freshness: state,
    warnings: state === 'current' ? [] : [`Occupancy source ${state}; availability requires verification.`] };
}

export async function getOccupancyFreshness(sql: postgres.Sql) {
  const [row] = await sql`SELECT MAX(report_date)::text AS report_date,
    COALESCE(SUM(jsonb_array_length(raw_data->'results')), 0)::int AS source_rows
    FROM bronze_appfolio_reports WHERE report_type = 'unit_vacancy'
      AND report_date = (SELECT MAX(report_date) FROM bronze_appfolio_reports WHERE report_type='unit_vacancy')`;
  const result = sourceFreshness(row?.report_date ?? null);
  if (!row?.source_rows) { result.freshness = 'unknown'; result.warnings.push('Latest vacancy report has no source rows; completeness is unknown.'); }
  return result;
}

// Status is read only from the same view as Home. Bronze enriches attributes,
// never overrides status. No response cache: failures cannot revive old lists.
export async function loadOccupancy(sql: postgres.Sql) {
  const rows = await sql<OccupancyRow[]>`
    WITH latest AS (
      SELECT MAX(report_date) AS dt FROM bronze_appfolio_reports WHERE report_type='unit_vacancy'
    ), uv AS (
      SELECT DISTINCT ON (LOWER(REGEXP_REPLACE(TRIM(e->>'Unit'), '\\s*-\\s*', '-', 'g')))
        LOWER(REGEXP_REPLACE(TRIM(e->>'Unit'), '\\s*-\\s*', '-', 'g')) AS unit_id, e
      FROM bronze_appfolio_reports b, jsonb_array_elements(b.raw_data->'results') e, latest
      WHERE b.report_type='unit_vacancy' AND b.report_date=latest.dt
      ORDER BY LOWER(REGEXP_REPLACE(TRIM(e->>'Unit'), '\\s*-\\s*', '-', 'g'))
    )
    SELECT o.unit_id, o.unit_status AS status, o.unit_group, o.created_at::text, o.exclude_from_occupancy,
      COALESCE(x.exclude_from_vacancy, false) AS exclude_from_vacancy,
      COALESCE(x.exclude_from_revenue, false) AS exclude_from_revenue,
      uv.e->>'UnitType' AS unit_type, uv.e->>'Property' AS building,
      uv.e->>'DaysVacant' AS days_vacant,
      COALESCE(uv.e->>'ComputedMarketRent', uv.e->>'MarketRent') AS market_rent,
      rr.e->>'Rent' AS monthly_rent,
      rr.e->>'Tenant' AS tenant_name,
      COALESCE(uv.e->>'VacancyStatus', uv.e->>'UnitStatus') AS vacancy_status,
      (SELECT dt::text FROM latest) AS source_report_date,
      (NULLIF(TRIM(uv.e->>'UnitStatus'), '') IS NOT NULL) AS has_source_status
    FROM v_unit_occupancy o LEFT JOIN uv USING (unit_id)
    LEFT JOIN jasmine_unit_overrides x USING (unit_id)
    LEFT JOIN LATERAL (
      SELECT e FROM bronze_appfolio_reports b, jsonb_array_elements(b.raw_data->'results') e
      WHERE b.report_type='rent_roll'
        AND b.report_date=(SELECT MAX(report_date) FROM bronze_appfolio_reports WHERE report_type='rent_roll')
        AND LOWER(REGEXP_REPLACE(TRIM(e->>'Unit'), '\\s*-\\s*', '-', 'g'))=o.unit_id
        AND e->>'Status' ILIKE '%current%'
      ORDER BY e->>'Tenant' LIMIT 1
    ) rr ON true
    ORDER BY o.unit_id
  `;
  return rows.map(r => {
    const number = (v: unknown) => { const n = v == null || String(v).trim() === '' ? NaN : Number(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
    const held = /family|employee/i.test(r.unit_group ?? '');
    return { ...r, days_vacant: number(r.days_vacant), market_rent: number(r.market_rent), monthly_rent: number(r.monthly_rent),
      available_to_lease: sourceFreshness(r.source_report_date).freshness === 'current'
        && r.status === 'vacant' && r.has_source_status && !held && !r.exclude_from_vacancy && !r.exclude_from_occupancy
        && /^(vacant[- ]+)?unrented/i.test(r.vacancy_status ?? ''),
      leasing_excluded: held || r.exclude_from_vacancy || r.exclude_from_occupancy,
      status_warning: r.has_source_status ? null : 'No latest vacancy-report row; canonical status uses fallback.' };
  });
}

export function occupancyList(rows: Awaited<ReturnType<typeof loadOccupancy>>, status = 'all', building = '', minDays?: number, unitType = '') {
  const units = rows.filter(r => (status === 'all' || r.status === status)
    && (!building || String(r.building ?? '').toLowerCase().includes(building.toLowerCase()))
    && (!unitType || String(r.unit_type ?? '').toLowerCase().includes(unitType.toLowerCase()))
    && (status === 'all' || !r.leasing_excluded)
    && (minDays === undefined || (r.status === 'vacant' && r.days_vacant !== null && r.days_vacant >= minDays)));
  const groups: Record<string, number> = {};
  for (const r of units) { const key = r.unit_type || 'Unknown type'; groups[key] = (groups[key] ?? 0) + 1; }
  return { units, total_count: units.length, counts_by_type: groups,
    vacant_now: units.filter(r => r.status === 'vacant').length,
    notice: units.filter(r => r.status === 'notice').length,
    available_to_lease: units.filter(r => r.available_to_lease).length };
}
