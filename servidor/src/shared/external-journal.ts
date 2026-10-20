/* eslint-disable security/detect-non-literal-fs-filename -- Fixed operator-owned local paths outside Mongo, never HTTP input. */
import { createHmac } from 'node:crypto';
import { readFileSync, openSync, closeSync, appendFileSync, fsyncSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecurityState } from './evidence.js';
import { AppError } from './errors.js';

export interface JournalEntry { _id: number; eventId: string; previous: string; state: SecurityState; signature: string }
export class ExternalJournal {
  constructor(readonly path: string, private readonly key: Buffer) {}
  sign(data: Omit<JournalEntry, 'signature'>): string { return createHmac('sha256', this.key).update(JSON.stringify(data)).digest('hex'); }
  createEmpty(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'wx', 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  read(): JournalEntry[] {
    try {
      const text = readFileSync(this.path, 'utf8');
      if (text && !text.endsWith('\n')) throw new Error('Incomplete append');
      const entries = text ? text.slice(0, -1).split('\n').map(s => JSON.parse(s) as JournalEntry) : [];
      let previous = '', sequence = 0;
      for (const row of entries) {
        const data = { _id: row._id, eventId: row.eventId, previous: row.previous, state: row.state };
        if (row._id !== ++sequence || row.previous !== previous || typeof row.eventId !== 'string' || row.signature !== this.sign(data)) throw new Error('Invalid external evidence');
        previous = row.signature;
      }
      return entries;
    } catch { throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
  }
  append(row: JournalEntry): void {
    const entries = this.read(), last = entries.at(-1);
    if (row._id !== entries.length + 1 || row.previous !== (last?.signature ?? '') || row.signature !== this.sign({ _id: row._id, eventId: row.eventId, previous: row.previous, state: row.state })) throw new AppError(503, 'SERVICE_UNAVAILABLE');
    const fd = openSync(this.path, 'a');
    try { appendFileSync(fd, JSON.stringify(row) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    // A crash leaves the lock and closes operation; never silently discard an uncertain lock/journal.
    let fd: number;
    try { fd = openSync(this.path + '.lock', 'wx', 0o600); } catch { throw new AppError(503, 'SERVICE_UNAVAILABLE'); }
    try { return await work(); } finally { closeSync(fd); unlinkSync(this.path + '.lock'); }
  }
}
