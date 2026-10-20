import postgres from 'postgres';

// Additive migration. No assignments are seeded. RLS denies direct Data API
// access; the existing authenticated backend uses its established DB role.
export const FAST_SCHEMA = `
CREATE TABLE IF NOT EXISTS fast_unit_assignments (
 category text NOT NULL CHECK (category IN ('basic','upgraded','premium')),
 furnishing text NOT NULL CHECK (furnishing IN ('furnished','unfurnished')),
 unit_numbers text NOT NULL DEFAULT '',
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by text,
 PRIMARY KEY(category, furnishing),
 CHECK (length(unit_numbers) <= 1000)
);
ALTER TABLE fast_unit_assignments ENABLE ROW LEVEL SECURITY;
`;
export function validateFast(category: unknown, furnishing: unknown, value: unknown, revision: unknown) {
 if (!['basic','upgraded','premium'].includes(String(category)) || !['furnished','unfurnished'].includes(String(furnishing))) throw Error('Invalid Fast cell.');
 if (typeof value !== 'string' || value.length > 1000) throw Error('Enter unit numbers as text, up to 1,000 characters.');
 const units=value.trim() ? value.trim().split(/[\s,;]+/).filter(Boolean) : [];
 if (units.length>50 || units.some(u=>!/^\d[a-zA-Z0-9-]{0,19}$/.test(u))) throw Error('Use up to 50 unit numbers, separated by commas or spaces (for example 103, 120-a).');
 if (!Number.isInteger(revision) || Number(revision)<0 || Number(revision)>2147483646) throw Error('Invalid cell revision. Reload and try again.');
 return {category:String(category), furnishing:String(furnishing), value:units.join(', '), revision:Number(revision)};
}
export async function readFast(sql: postgres.Sql) {
 return sql`SELECT category, furnishing, unit_numbers, revision, updated_at::text FROM fast_unit_assignments ORDER BY category, furnishing`;
}
export async function writeFast(sql: postgres.Sql, cell: ReturnType<typeof validateFast>, actor: string | null) {
 const updated=await sql`UPDATE fast_unit_assignments SET unit_numbers=${cell.value},revision=revision+1,updated_at=now(),updated_by=${actor}
 WHERE category=${cell.category} AND furnishing=${cell.furnishing} AND revision=${cell.revision}
 RETURNING category,furnishing,unit_numbers,revision,updated_at::text`;
 if(updated[0])return {saved:updated[0]};
 if(cell.revision===0){
  const inserted=await sql`INSERT INTO fast_unit_assignments(category,furnishing,unit_numbers,updated_by)
   VALUES(${cell.category},${cell.furnishing},${cell.value},${actor}) ON CONFLICT DO NOTHING
   RETURNING category,furnishing,unit_numbers,revision,updated_at::text`;
  if(inserted[0])return {saved:inserted[0]};
 }
 const [current]=await sql`SELECT category,furnishing,unit_numbers,revision,updated_at::text FROM fast_unit_assignments WHERE category=${cell.category} AND furnishing=${cell.furnishing}`;
 return {current:current??{category:cell.category,furnishing:cell.furnishing,unit_numbers:'',revision:0}};
}
