/**
 * pages.ts — Dedicated page-level API endpoints for CynthiaOS frontend pages.
 *
 * These endpoints are SEPARATE from the Jasmine AI tool endpoints.
 * - Jasmine endpoints (/api/jasmine/*): cached, AI-optimised, filtered
 * - Page endpoints (/api/pages/*): always fresh DB queries, full data, no cache
 *
 * Mounted at /api/pages/* in index.ts
 */

import { Router, Request, Response } from 'express';
import postgres from 'postgres';

const router: Router = Router();

function getDb(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return postgres(url, { ssl: 'require' });
}

// ── COLLECTIONS RISK ─────────────────────────────────────────────────────────
// Returns ALL delinquency records — both current AND past tenants.
// The frontend separates them into two sections.
router.get('/pages/collections', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    const rows = await sql<{
      unit_id: string;
      tenant_id: string;
      tenant_status: string;
      balance_due: string;
      total_outstanding: string;
      days_overdue: number;
      risk_level: string;
      full_name: string | null;
    }[]>`
      SELECT
        d.unit_id,
        d.tenant_id,
        d.tenant_status,
        d.balance_due::text,
        d.total_outstanding::text,
        d.days_overdue,
        d.risk_level,
        (
          SELECT gt.full_name
          FROM gold_tenants gt
          WHERE gt.unit_id = d.unit_id
          ORDER BY (gt.lease_status ILIKE '%primary%') DESC, gt.full_name ASC
          LIMIT 1
        ) AS full_name
      FROM gold_delinquency_records d
      ORDER BY
        CASE d.tenant_status WHEN 'current' THEN 0 ELSE 1 END,
        d.days_overdue DESC NULLS LAST,
        d.balance_due DESC NULLS LAST
    `;

    const records = rows.map(r => ({
      unit_id:           r.unit_id,
      tenant_id:         r.tenant_id,
      tenant_status:     r.tenant_status,
      tenant_name:       r.full_name,
      balance_due:       parseFloat(r.balance_due),
      total_outstanding: parseFloat(r.total_outstanding),
      days_overdue:      r.days_overdue,
      risk_level:        r.risk_level,
    }));

    const current = records.filter(r => r.tenant_status === 'current');
    const past    = records.filter(r => r.tenant_status !== 'current');

    res.json({
      current_tenants: current,
      past_tenants:    past,
      summary: {
        current_total_overdue:     current.reduce((s, r) => s + r.balance_due, 0),
        current_total_outstanding: current.reduce((s, r) => s + r.total_outstanding, 0),
        past_total_overdue:        past.reduce((s, r) => s + r.balance_due, 0),
        past_total_outstanding:    past.reduce((s, r) => s + r.total_outstanding, 0),
        high_risk_count:           records.filter(r => r.risk_level === 'high').length,
      },
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── AR AGING ─────────────────────────────────────────────────────────────────
// Returns all aged receivables grouped by tenant with full bucket breakdown.
// Optional ?bucket=30|60|90|90_plus filter.
router.get('/pages/ar-aging', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const bucket = String(req.query.bucket ?? 'all').toLowerCase();

    const rows = await sql<{
      unit_id: string;
      tenant_id: string;
      tenant_status: string;
      total_balance: string;
      bucket_0_30: string;
      bucket_31_60: string;
      bucket_61_90: string;
      bucket_90_plus: string;
      dominant_bucket: string;
      risk_score: string;
      full_name: string | null;
    }[]>`
      SELECT
        ar.unit_id,
        ar.tenant_id,
        ar.tenant_status,
        ar.total_balance::text,
        ar.bucket_0_30::text,
        ar.bucket_31_60::text,
        ar.bucket_61_90::text,
        ar.bucket_90_plus::text,
        ar.dominant_bucket,
        ar.risk_score::text,
        (
          SELECT gt.full_name
          FROM gold_tenants gt
          WHERE gt.unit_id = ar.unit_id
          ORDER BY (gt.lease_status ILIKE '%primary%') DESC, gt.full_name ASC
          LIMIT 1
        ) AS full_name
      FROM gold_aged_receivables ar
      WHERE
        ${bucket === 'all'}
        OR (${bucket === '30'} AND ar.bucket_0_30 > 0)
        OR (${bucket === '60'} AND ar.bucket_31_60 > 0)
        OR (${bucket === '90'} AND ar.bucket_61_90 > 0)
        OR (${bucket === '90_plus'} AND ar.bucket_90_plus > 0)
      ORDER BY ar.total_balance DESC NULLS LAST
    `;

    const receivables = rows.map(r => ({
      unit_id:        r.unit_id,
      tenant_id:      r.tenant_id,
      tenant_status:  r.tenant_status,
      tenant_name:    r.full_name,
      total_amount:   parseFloat(r.total_balance),
      amount_0_to_30: parseFloat(r.bucket_0_30),
      amount_30_to_60: parseFloat(r.bucket_31_60),
      amount_60_to_90: parseFloat(r.bucket_61_90),
      amount_90_plus:  parseFloat(r.bucket_90_plus),
      dominant_bucket: r.dominant_bucket,
      risk_score:      parseFloat(r.risk_score),
    }));

    res.json({
      receivables,
      total_outstanding: receivables.reduce((s, r) => s + r.total_amount, 0),
      count: receivables.length,
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── FINANCIALS — INCOME STATEMENT ────────────────────────────────────────────
// Returns the latest income statement with MTD + YTD figures.
router.get('/pages/financials/income-statement', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();

    const rows = await sql<{
      report_date: string;
      total_income: string;
      rental_income: string;
      other_income: string;
      total_expenses: string;
      operating_expenses: string;
      net_operating_income: string;
      profit_margin: string;
      total_income_mtd: string;
      rental_income_mtd: string;
      other_income_mtd: string;
      total_expenses_mtd: string;
      operating_expenses_mtd: string;
      net_operating_income_mtd: string;
    }[]>`
      SELECT
        report_date::text,
        total_income::text,
        rental_income::text,
        other_income::text,
        total_expenses::text,
        operating_expenses::text,
        net_operating_income::text,
        profit_margin::text,
        total_income_mtd::text,
        rental_income_mtd::text,
        other_income_mtd::text,
        total_expenses_mtd::text,
        operating_expenses_mtd::text,
        net_operating_income_mtd::text
      FROM gold_income_statements
      ORDER BY report_date DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      res.json({ income_statement: null });
      return;
    }

    const r = rows[0];
    const ytdTotalIncome = parseFloat(r.total_income);
    const ytdTotalExpenses = parseFloat(r.total_expenses);
    const expenseToIncomeRatio = ytdTotalIncome === 0 ? null : ytdTotalExpenses / ytdTotalIncome;
    // Production reconciliation on 2026-07-14 found that the AppFolio feed contains
    // only a small subset of normal operating-expense categories. Keep the source
    // figures intact, but disclose when they are not plausible as a complete scope.
    const expenseScopeIsPartial = expenseToIncomeRatio !== null && expenseToIncomeRatio < 0.1;

    res.json({
      income_statement: {
        report_date:              r.report_date,
        expense_scope: {
          status: expenseScopeIsPartial ? 'partial' : 'reported',
          is_complete: expenseScopeIsPartial ? false : null,
          expense_to_income_ratio: expenseToIncomeRatio,
          profit_margin_usable_for_full_property_performance: !expenseScopeIsPartial,
          note: expenseScopeIsPartial
            ? 'The AppFolio income-statement feed contains only a partial operating-expense account scope; totals and margin must not be treated as complete property performance.'
            : 'Expenses are reported as supplied by the AppFolio income-statement feed; completeness has not been independently certified.',
        },
        ytd: {
          total_income:           ytdTotalIncome,
          rental_income:          parseFloat(r.rental_income),
          other_income:           parseFloat(r.other_income),
          total_expenses:         ytdTotalExpenses,
          operating_expenses:     parseFloat(r.operating_expenses),
          net_operating_income:   parseFloat(r.net_operating_income),
          profit_margin:          parseFloat(r.profit_margin),
        },
        mtd: {
          total_income:           parseFloat(r.total_income_mtd),
          rental_income:          parseFloat(r.rental_income_mtd),
          other_income:           parseFloat(r.other_income_mtd),
          total_expenses:         parseFloat(r.total_expenses_mtd),
          operating_expenses:     parseFloat(r.operating_expenses_mtd),
          net_operating_income:   parseFloat(r.net_operating_income_mtd),
        },
      },
    });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── FINANCIALS — GENERAL LEDGER ───────────────────────────────────────────────
// Returns GL entries with optional date range and account filters.
router.get('/pages/financials/general-ledger', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const startDate = req.query.start_date ? String(req.query.start_date) : null;
    const endDate   = req.query.end_date   ? String(req.query.end_date)   : null;
    const account   = req.query.account    ? String(req.query.account)    : null;

    const rows = await sql<{
      txn_id: string;
      post_date: string;
      txn_type: string;
      gl_account_name: string;
      bank_account: string;
      debit: string;
      credit: string;
      net_amount: string;
      party_name: string;
      party_type: string;
      unit_id: string;
      description: string;
      reference: string;
      month_label: string;
      quarter_label: string;
    }[]>`
      SELECT
        txn_id::text,
        post_date::text,
        txn_type,
        gl_account_name,
        bank_account,
        debit::text,
        credit::text,
        net_amount::text,
        party_name,
        party_type,
        unit_id,
        description,
        reference,
        month_label,
        quarter_label
      FROM gold_general_ledger
      WHERE
        (${startDate === null} OR post_date >= ${startDate}::date)
        AND (${endDate === null} OR post_date <= ${endDate}::date)
        AND (${account === null} OR gl_account_name ILIKE ${'%' + (account ?? '') + '%'})
      ORDER BY post_date DESC, txn_id DESC
    `;

    const entries = rows.map(r => ({
      txn_id:          r.txn_id,
      post_date:       r.post_date,
      txn_type:        r.txn_type,
      account:         r.gl_account_name,
      bank_account:    r.bank_account,
      debit:           parseFloat(r.debit),
      credit:          parseFloat(r.credit),
      net_amount:      parseFloat(r.net_amount),
      party_name:      r.party_name,
      party_type:      r.party_type,
      unit_id:         r.unit_id,
      description:     r.description,
      reference:       r.reference,
      month:           r.month_label,
      quarter:         r.quarter_label,
    }));

    res.json({ entries, count: entries.length });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── LEASING PIPELINE — PROSPECTS ─────────────────────────────────────────────
// Returns all prospects/guest cards with optional status filter.
router.get('/pages/leasing-pipeline/prospects', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const status = req.query.status ? String(req.query.status) : null;

    const rows = await sql<{
      guest_card_id: string;
      prospect_name: string;
      email: string;
      phone: string;
      status: string;
      lead_type: string;
      source: string;
      unit_id: string;
      unit_name: string;
      bed_bath_preference: string;
      max_rent: string;
      move_in_preference: string;
      received_at: string;
      last_activity_date: string;
      last_activity_at: string;
      inactivity_days: number;
      is_stale: boolean;
      last_activity_type: string;
      assigned_user: string;
      credit_score: number;
    }[]>`
      SELECT
        guest_card_id::text,
        prospect_name,
        email,
        phone,
        status,
        lead_type,
        source,
        unit_id,
        unit_name,
        bed_bath_preference,
        max_rent::text,
        move_in_preference::text,
        received_at::text,
        last_activity_date::text,
        COALESCE(last_activity_date, received_at)::text AS last_activity_at,
        GREATEST(0, CURRENT_DATE - COALESCE(last_activity_date, received_at)::date)::integer AS inactivity_days,
        (COALESCE(last_activity_date, received_at)::date < CURRENT_DATE - INTERVAL '30 days') AS is_stale,
        last_activity_type,
        assigned_user,
        credit_score
      FROM gold_prospects
      WHERE ${status === null} OR status ILIKE ${status ?? ''}
      ORDER BY received_at DESC NULLS LAST
    `;

    const prospects = rows.map(r => ({
      guest_card_id:       r.guest_card_id,
      name:                r.prospect_name,
      email:               r.email,
      phone:               r.phone,
      status:              r.status,
      lead_type:           r.lead_type,
      source:              r.source,
      unit_id:             r.unit_id,
      unit_name:           r.unit_name,
      bed_bath_preference: r.bed_bath_preference,
      max_rent:            r.max_rent ? parseFloat(r.max_rent) : null,
      move_in_preference:  r.move_in_preference,
      received_at:         r.received_at,
      last_activity_date:  r.last_activity_date,
      last_activity_at:    r.last_activity_at,
      inactivity_days:     r.inactivity_days,
      is_stale:            r.is_stale,
      staleness_threshold_days: 30,
      last_activity_type:  r.last_activity_type,
      assigned_user:       r.assigned_user,
      credit_score:        r.credit_score,
    }));

    res.json({ prospects, count: prospects.length });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── LEASING PIPELINE — APPLICANTS ────────────────────────────────────────────
// Returns all rental applications with optional status filter.
router.get('/pages/leasing-pipeline/applicants', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const status = req.query.status ? String(req.query.status) : null;

    const rows = await sql<{
      rental_application_id: string;
      applicant_name: string;
      email: string;
      phone: string;
      unit_id: string;
      unit_name: string;
      property_name: string;
      status: string;
      application_status: string;
      received_date: string;
      desired_move_in: string;
      lease_start_date: string;
      monthly_rent: string;
      source: string;
      assigned_user: string;
      time_to_conversion_days: string;
    }[]>`
      SELECT
        rental_application_id::text,
        applicant_name,
        email,
        phone,
        unit_id,
        unit_name,
        property_name,
        status,
        application_status,
        received_date::text,
        desired_move_in::text,
        lease_start_date::text,
        monthly_rent::text,
        source,
        assigned_user,
        time_to_conversion_days::text
      FROM gold_rental_applications
      WHERE ${status === null} OR status ILIKE ${status ?? ''}
      ORDER BY received_date DESC NULLS LAST
    `;

    const applicants = rows.map(r => ({
      application_id:          r.rental_application_id,
      name:                    r.applicant_name,
      email:                   r.email,
      phone:                   r.phone,
      unit_id:                 r.unit_id,
      unit_name:               r.unit_name,
      property_name:           r.property_name,
      status:                  r.status,
      application_status:      r.application_status,
      received_date:           r.received_date,
      desired_move_in:         r.desired_move_in,
      lease_start_date:        r.lease_start_date,
      monthly_rent:            r.monthly_rent ? parseFloat(r.monthly_rent) : null,
      source:                  r.source,
      assigned_user:           r.assigned_user,
      time_to_conversion_days: r.time_to_conversion_days ? parseFloat(r.time_to_conversion_days) : null,
    }));

    res.json({ applicants, count: applicants.length });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── UNIT TURNS ───────────────────────────────────────────────────────────────
// Returns all unit turn records with optional event_type filter.
router.get('/pages/unit-turns', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const eventType = req.query.event_type ? String(req.query.event_type) : null;

    const rows = await sql<{
      unit_id: string;
      tenant_id: string;
      event_type: string;
      move_in_date: string;
      move_out_date: string;
      expected_move_in_date: string;
      turn_end_date: string;
      days_to_complete: number;
      target_days: number;
      total_billed: string;
      report_date: string;
      status: string;
    }[]>`
      WITH normalized AS (
        SELECT
          REGEXP_REPLACE(
            REGEXP_REPLACE(
              LOWER(REGEXP_REPLACE(TRIM(unit_id), '\\s*[_-]\\s*', '-', 'g')),
              '^([0-9]+)-\\1-', '\\1-'
            ),
            '-+', '-', 'g'
          ) AS unit_id,
          tenant_id,
          event_type,
          move_in_date,
          move_out_date,
          expected_move_in_date,
          turn_end_date,
          days_to_complete,
          target_days,
          total_billed,
          report_date,
          created_at
        FROM gold_unit_turnover
      ),
      deduped AS (
        SELECT DISTINCT ON (
          unit_id,
          move_out_date,
          expected_move_in_date,
          turn_end_date,
          days_to_complete
        )
          *,
          CASE
            WHEN move_out_date > CURRENT_DATE THEN 'scheduled'
            WHEN turn_end_date IS NOT NULL AND turn_end_date <= CURRENT_DATE THEN 'completed'
            ELSE 'in_progress'
          END AS status
        FROM normalized
        ORDER BY
          unit_id,
          move_out_date,
          expected_move_in_date,
          turn_end_date,
          days_to_complete,
          report_date DESC NULLS LAST,
          created_at DESC
      )
      SELECT
        unit_id,
        tenant_id,
        event_type,
        move_in_date::text,
        move_out_date::text,
        expected_move_in_date::text,
        turn_end_date::text,
        days_to_complete,
        target_days,
        total_billed::text,
        report_date::text,
        status
      FROM deduped
      WHERE ${eventType === null} OR event_type ILIKE ${eventType ?? ''}
      ORDER BY move_out_date DESC NULLS LAST
    `;

    const turns = rows.map(r => ({
      unit_id:               r.unit_id,
      tenant_id:             r.tenant_id,
      event_type:            r.event_type,
      move_in_date:          r.move_in_date,
      move_out_date:         r.move_out_date,
      expected_move_in_date: r.expected_move_in_date,
      turn_end_date:         r.turn_end_date,
      days_to_complete:      r.days_to_complete,
      target_days:           r.target_days,
      total_billed:          r.total_billed ? parseFloat(r.total_billed) : null,
      report_date:           r.report_date,
      status:                r.status,
      is_current:            r.status === 'in_progress',
    }));

    res.json({ turns, count: turns.length });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

// ── VENDORS ──────────────────────────────────────────────────────────────────
// Returns all vendors with optional trade and do_not_use filters.
router.get('/pages/vendors', async (req: Request, res: Response) => {
  let sql: postgres.Sql | null = null;
  try {
    sql = getDb();
    const trade     = req.query.trade      ? String(req.query.trade)      : null;
    const doNotUse  = req.query.do_not_use ? String(req.query.do_not_use) : null;

    const rows = await sql<{
      vendor_id: string;
      company_name: string;
      full_name: string;
      email: string;
      phone_numbers: string;
      vendor_type: string;
      vendor_trades: string;
      tags: string;
      payment_type: string;
      vendor_address: string;
      vendor_city: string;
      vendor_state: string;
      do_not_use: boolean;
      send_1099: boolean;
      portal_activated: boolean;
      liability_ins_expires: string;
      workers_comp_expires: string;
    }[]>`
      SELECT
        vendor_id::text,
        company_name,
        full_name,
        email,
        phone_numbers,
        vendor_type,
        vendor_trades,
        tags,
        payment_type,
        vendor_address,
        vendor_city,
        vendor_state,
        do_not_use,
        send_1099,
        portal_activated,
        liability_ins_expires::text,
        workers_comp_expires::text
      FROM gold_vendors
      WHERE
        (${trade === null} OR vendor_trades ILIKE ${'%' + (trade ?? '') + '%'})
        AND (${doNotUse === null} OR do_not_use = ${doNotUse === 'true'})
      ORDER BY company_name ASC NULLS LAST
    `;

    const vendors = rows.map(r => ({
      vendor_id:             r.vendor_id,
      company_name:          r.company_name,
      full_name:             r.full_name,
      email:                 r.email,
      phone_numbers:         r.phone_numbers,
      vendor_type:           r.vendor_type,
      vendor_trades:         r.vendor_trades,
      tags:                  r.tags,
      payment_type:          r.payment_type,
      address:               [r.vendor_address, r.vendor_city, r.vendor_state].filter(Boolean).join(', '),
      do_not_use:            r.do_not_use,
      send_1099:             r.send_1099,
      portal_activated:      r.portal_activated,
      liability_ins_expires: r.liability_ins_expires,
      workers_comp_expires:  r.workers_comp_expires,
    }));

    res.json({ vendors, count: vendors.length });
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error });
  } finally {
    if (sql) await sql.end();
  }
});

export default router;
