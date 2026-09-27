// Faux Supabase en mémoire : reproduit juste ce que le worker utilise.
type Row = Record<string, any>;
export const tables: Record<string, Row[]> = { wa_conversations: [], wa_messages: [] };
let seq = 0;

export function resetDb() {
  tables.wa_conversations = [];
  tables.wa_messages = [];
  seq = 0;
}

class Query implements PromiseLike<{ data: any; error: any }> {
  private filters: ((r: Row) => boolean)[] = [];
  private orderBy?: { col: string; asc: boolean };
  private max?: number;
  private one = false;
  private op: 'select' | 'update' = 'select';
  private patch?: Row;
  private cols?: string[];
  constructor(private table: string) {}
  select(cols?: string) { this.op = 'select'; this.cols = cols?.split(',').map((c) => c.trim()); return this; }
  update(p: Row) { this.op = 'update'; this.patch = p; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  order(col: string, o: { ascending: boolean }) { this.orderBy = { col, asc: o.ascending }; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.one = true; return this; }
  private run() {
    let rows = tables[this.table].filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'update') { rows.forEach((r) => Object.assign(r, this.patch)); return { data: null, error: null }; }
    if (this.orderBy) {
      const { col, asc } = this.orderBy;
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.max !== undefined) rows = rows.slice(0, this.max);
    if (this.cols) rows = rows.map((r) => Object.fromEntries(this.cols!.map((c) => [c, r[c]])));
    return { data: this.one ? (rows[0] ?? null) : rows, error: null };
  }
  then<T1, T2>(ok?: ((v: any) => T1) | null, ko?: ((e: any) => T2) | null) {
    return Promise.resolve(this.run()).then(ok, ko);
  }
}

export const fakeDb = {
  from(table: string) {
    return {
      select: (cols?: string) => new Query(table).select(cols),
      update: (p: Row) => new Query(table).update(p),
      async upsert(row: Row, { onConflict }: { onConflict: string }) {
        const existing = tables[table].find((r) => r[onConflict] === row[onConflict]);
        if (existing) Object.assign(existing, row);
        else tables[table].push({ status: 'bot', ...row });
        return { data: null, error: null };
      },
      async insert(row: Row) {
        if (table === 'wa_messages' && row.wa_message_id &&
            tables.wa_messages.some((r) => r.wa_message_id === row.wa_message_id)) {
          return { data: null, error: { code: '23505', message: 'duplicate' } };
        }
        // created_at strictement croissant pour un tri déterministe
        tables[table].push({ ...row, created_at: String(++seq).padStart(6, '0') });
        return { data: null, error: null };
      },
    };
  },
};
