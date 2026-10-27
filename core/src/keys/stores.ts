import type { Db } from '../db/db.js';
import { toDate, toDateOrNull } from '../db/db.js';
import type { KeyRecord, KeyStatus, KeyStore } from './types.js';

export class MemoryKeyStore implements KeyStore {
  readonly #rows = new Map<string, KeyRecord>();
  async list(): Promise<KeyRecord[]> {
    return [...this.#rows.values()].map((r) => structuredClone(r)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async get(id: string): Promise<KeyRecord | null> {
    const r = this.#rows.get(id);
    return r ? structuredClone(r) : null;
  }
  async insert(k: KeyRecord): Promise<void> {
    if (this.#rows.has(k.id)) throw new Error('duplicate key id');
    this.#rows.set(k.id, structuredClone(k));
  }
  async update(k: KeyRecord): Promise<void> {
    if (this.#rows.has(k.id)) this.#rows.set(k.id, structuredClone(k));
  }
  async delete(id: string): Promise<boolean> {
    return this.#rows.delete(id);
  }
}

interface Row {
  id: string;
  name: string;
  source_url: string;
  last4: string;
  model: string;
  model_name: string;
  api_base: string | null;
  litellm_model_id: string;
  status: KeyStatus;
  models_synced_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLS = 'id, name, source_url, last4, model, model_name, api_base, litellm_model_id, status, models_synced_at, created_at, updated_at';

const toRec = (r: Row): KeyRecord => ({
  id: r.id,
  name: r.name,
  sourceUrl: r.source_url,
  last4: r.last4,
  model: r.model,
  modelName: r.model_name,
  apiBase: r.api_base,
  litellmModelId: r.litellm_model_id,
  status: r.status,
  modelsSyncedAt: toDateOrNull(r.models_synced_at),
  createdAt: toDate(r.created_at),
  updatedAt: toDate(r.updated_at),
});

const vals = (k: KeyRecord) => [
  k.id,
  k.name,
  k.sourceUrl,
  k.last4,
  k.model,
  k.modelName,
  k.apiBase,
  k.litellmModelId,
  k.status,
  k.modelsSyncedAt,
  k.createdAt,
  k.updatedAt,
];

export class PgKeyStore implements KeyStore {
  constructor(private readonly db: Db) {}
  async list(): Promise<KeyRecord[]> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM provider_keys ORDER BY created_at, id`);
    return rows.map(toRec);
  }
  async get(id: string): Promise<KeyRecord | null> {
    const { rows } = await this.db.query<Row>(`SELECT ${COLS} FROM provider_keys WHERE id = $1`, [id]);
    return rows[0] ? toRec(rows[0]) : null;
  }
  async insert(k: KeyRecord): Promise<void> {
    await this.db.query(`INSERT INTO provider_keys (${COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, vals(k));
  }
  async update(k: KeyRecord): Promise<void> {
    await this.db.query(
      `UPDATE provider_keys SET name=$2, source_url=$3, last4=$4, model=$5, model_name=$6, api_base=$7,
              litellm_model_id=$8, status=$9, models_synced_at=$10, updated_at=$11 WHERE id=$1`,
      [k.id, k.name, k.sourceUrl, k.last4, k.model, k.modelName, k.apiBase, k.litellmModelId, k.status, k.modelsSyncedAt, k.updatedAt],
    );
  }
  async delete(id: string): Promise<boolean> {
    const { rows } = await this.db.query('DELETE FROM provider_keys WHERE id = $1 RETURNING id', [id]);
    return rows.length > 0;
  }
}
