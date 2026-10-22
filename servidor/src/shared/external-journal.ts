/* eslint-disable security/detect-non-literal-fs-filename -- Fixed operator-owned local paths, never HTTP input. */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, statSync, fstatSync, openSync, closeSync, fsyncSync, unlinkSync, mkdirSync, renameSync, readSync, type BigIntStats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { dirname } from 'node:path';
import type { SecurityEvidence } from './evidence.js';
import { AppError } from './errors.js';

export interface JournalEntry { _id: number; eventId: string; previous: string; state: SecurityEvidence; signature: string }
const INLINE_LIMIT = 64 * 1024;
const RECEIPT_LIMIT = 128 * 1024;
interface Position { stamp: string; bytes: number; sequence: number; signature: string }
interface Transition { before: Position; after: Position }
const unavailable = () => new AppError(503, 'SERVICE_UNAVAILABLE');
const stamp = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;

export class ExternalJournal {
  private rows: JournalEntry[] = [];
  private verifiedStamp: string | null = null;
  private verifiedSize = 0;
  private appending: { before: BigIntStats; finalSize: bigint } | null = null;
  readonly diagnostics = { fullAsyncReads: 0, incrementalAsyncReads: 0, boundedIncrementalReads: 0, boundedInlineReads: 0, appendedEntries: 0 };
  constructor(readonly path: string, private readonly key: Buffer) {}
  sign(data: Omit<JournalEntry, 'signature'>): string { return createHmac('sha256', this.key).update(JSON.stringify(data)).digest('hex'); }
  createEmpty(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, 'wx', 0o600);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  private validate(row: JournalEntry, sequence: number, previous: string): void {
    if (row._id !== sequence || row.previous !== previous || typeof row.eventId !== 'string' ||
      (row.state.format !== undefined && row.state.format !== 'delta-v1') ||
      row.signature !== this.sign({ _id: row._id, eventId: row.eventId, previous: row.previous, state: row.state })) throw unavailable();
  }
  signatureAt(sequence: number): string | undefined { return sequence === 0 ? '' : this.rows[sequence - 1]?.signature; }
  get length(): number { return this.rows.length; }

  private receiptMac(payload: unknown): string {
    return createHmac('sha256', this.key).update('append-v1:' + JSON.stringify(payload)).digest('hex');
  }
  private receipts(): Transition[] {
    let fd: number | undefined;
    try {
      fd = openSync(this.path + '.receipts.json', 'r');
      const bytes = Buffer.alloc(RECEIPT_LIMIT + 1), length = readSync(fd, bytes, 0, bytes.length, 0);
      if (length > RECEIPT_LIMIT) return [];
      const value = JSON.parse(bytes.subarray(0, length).toString('utf8')) as {payload:{version:number;transitions:Transition[]};signature:string};
      if (value.payload.version !== 1 || !Array.isArray(value.payload.transitions) || value.payload.transitions.length > 128 ||
        value.signature !== this.receiptMac(value.payload)) return [];
      return value.payload.transitions;
    } catch { return []; } finally { if (fd !== undefined) closeSync(fd); }
  }
  private attestAppend(before: Position, after: Position): void {
    const existing = this.receipts();
    const transitions = [...(existing.at(-1)?.after.stamp === before.stamp ? existing : []), {before, after}].slice(-128);
    const payload = {version:1, transitions};
    const temp = this.path + '.' + randomUUID() + '.receipts.tmp';
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify({payload,signature:this.receiptMac(payload)})); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.path + '.receipts.json');
    } catch {
      // Optional authenticated accelerator, never restoration evidence. Losing or
      // altering it forces a complete asynchronous verification of the journal.
      try { unlinkSync(temp); } catch { /* No authority or access decision depends on this cache. */ }
    }
  }
  private appendAnchor(target: BigIntStats): Position | null {
    if (!this.verifiedStamp || Number(target.size) <= this.verifiedSize) return null;
    const transitions = this.receipts();
    let position: Position = {stamp:this.verifiedStamp,bytes:this.verifiedSize,sequence:this.rows.length,signature:this.rows.at(-1)?.signature??''};
    let found = false;
    for (const transition of transitions) {
      if (!found) {
        if (JSON.stringify(transition.before) !== JSON.stringify(position)) continue;
        found = true;
      }
      if (JSON.stringify(transition.before) !== JSON.stringify(position) || transition.after.bytes <= position.bytes ||
        transition.after.sequence !== position.sequence + 1) return null;
      position = transition.after;
    }
    return found && position.stamp === stamp(target) && position.bytes === Number(target.size) ? position : null;
  }

  isVerified(): boolean {
    try {
      const before = statSync(this.path, { bigint: true });
      if (this.verifiedStamp === stamp(before)) return true;
      const write = this.appending;
      // An own, locked append may be in flight. Only the already-verified prefix is used
      // by the gate; no incomplete tail is promoted until write+fsync+close finish.
      if (write && this.verifiedStamp === stamp(write.before) && before.ino === write.before.ino && before.dev === write.before.dev &&
        before.size >= write.before.size && before.size <= write.finalSize) return true;
      const anchor = this.appendAnchor(before), tailBytes = Number(before.size) - this.verifiedSize;
      if (anchor && tailBytes > 0 && tailBytes <= INLINE_LIMIT) {
        const fd = openSync(this.path, 'r');
        try {
          const bytes = Buffer.alloc(tailBytes);
          if (readSync(fd, bytes, 0, bytes.length, this.verifiedSize) !== bytes.length || bytes.at(-1) !== 10) return false;
          const rows = [...this.rows]; let previous = rows.at(-1)?.signature ?? '';
          for (const text of bytes.toString('utf8').slice(0, -1).split('\n')) {
            const row = JSON.parse(text) as JournalEntry;
            this.validate(row, rows.length + 1, previous); rows.push(row); previous = row.signature;
          }
          if (rows.length !== anchor.sequence || previous !== anchor.signature ||
            stamp(fstatSync(fd, {bigint:true})) !== stamp(before) || stamp(statSync(this.path, {bigint:true})) !== stamp(before)) return false;
          this.rows = rows; this.verifiedStamp = stamp(before); this.verifiedSize = Number(before.size); this.diagnostics.boundedIncrementalReads++;
          return true;
        } finally { closeSync(fd); }
      }
      // Full-file inline fallback is only for SMALL files, bounded to64KiB.
      // Large unattested changes require asynchronous verification under the lock.
      if (before.size > BigInt(INLINE_LIMIT)) return false;
      const bytes = readFileSync(this.path);
      if (bytes.length !== Number(before.size) || (bytes.length && bytes.at(-1) !== 10)) return false;
      const rows = bytes.length ? bytes.toString('utf8').slice(0, -1).split('\n').map(s => JSON.parse(s) as JournalEntry) : [];
      let previous = '', sequence = 0;
      for (const row of rows) { this.validate(row, ++sequence, previous); previous = row.signature; }
      if (stamp(statSync(this.path, { bigint: true })) !== stamp(before)) return false;
      this.rows = rows; this.verifiedStamp = stamp(before); this.verifiedSize = bytes.length; this.diagnostics.boundedInlineReads++;
      return true;
    } catch { return false; }
  }

  async readVerified(force = false): Promise<JournalEntry[]> {
    try {
      const before = await stat(this.path, { bigint: true });
      if (!force && this.verifiedStamp === stamp(before)) return this.rows;
      const handle = await open(this.path, 'r');
      // Trust a cached prefix only with a domain-separated HMAC witness binding
      // its exact old inode/size/ctime/mtime to the writer's committed new stamp.
      // File growth alone is never proof that the old prefix is unchanged.
      const anchor = force ? null : this.appendAnchor(before), incremental = anchor !== null;
      const rows: JournalEntry[] = incremental ? [...this.rows] : [];
      let previous = rows.at(-1)?.signature ?? '', offset = incremental ? this.verifiedSize : 0, pending = Buffer.alloc(0);
      try {
        const chunk = Buffer.alloc(64 * 1024);
        while (true) {
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
          let newline: number;
          while ((newline = pending.indexOf(10)) !== -1) {
            const row = JSON.parse(pending.subarray(0, newline).toString('utf8')) as JournalEntry;
            this.validate(row, rows.length + 1, previous); rows.push(row); previous = row.signature;
            pending = pending.subarray(newline + 1);
            if (rows.length % 16 === 0) await setImmediate();
          }
          await setImmediate();
        }
        if (pending.length || offset !== Number(before.size) || stamp(await handle.stat({ bigint: true })) !== stamp(before) ||
          stamp(await stat(this.path, { bigint: true })) !== stamp(before)) throw unavailable();
        if (anchor && (rows.length !== anchor.sequence || previous !== anchor.signature)) throw unavailable();
      } finally { await handle.close(); }
      this.rows = rows; this.verifiedStamp = stamp(before); this.verifiedSize = offset;
      if (incremental) this.diagnostics.incrementalAsyncReads++; else this.diagnostics.fullAsyncReads++;
      return rows;
    } catch { throw unavailable(); }
  }

  async append(row: JournalEntry): Promise<void> {
    await this.readVerified();
    this.validate(row, this.rows.length + 1, this.rows.at(-1)?.signature ?? '');
    const bytes = Buffer.from(JSON.stringify(row) + '\n');
    const before = await stat(this.path, { bigint: true });
    if (stamp(before) !== this.verifiedStamp) throw unavailable();
    this.appending = { before, finalSize: before.size + BigInt(bytes.length) };
    try {
    const handle = await open(this.path, 'a');
    try {
      if (stamp(await handle.stat({ bigint: true })) !== this.verifiedStamp) throw unavailable();
      await handle.writeFile(bytes); await handle.sync();
      const after = await handle.stat({ bigint: true });
      if (after.size !== before.size + BigInt(bytes.length) || after.ino !== before.ino || after.dev !== before.dev ||
        stamp(await stat(this.path, { bigint: true })) !== stamp(after)) throw unavailable();
    } finally { await handle.close(); }
    // NTFS may finalize modification timestamps when the write handle closes.
    const committed = await stat(this.path, { bigint: true });
    if (committed.size !== before.size + BigInt(bytes.length) || committed.ino !== before.ino || committed.dev !== before.dev) throw unavailable();
    const oldPosition = {stamp:stamp(before),bytes:Number(before.size),sequence:this.rows.length,signature:this.rows.at(-1)?.signature??''};
    this.rows.push(row); this.verifiedStamp = stamp(committed); this.verifiedSize = Number(committed.size); this.diagnostics.appendedEntries++;
    this.attestAppend(oldPosition, {stamp:stamp(committed),bytes:Number(committed.size),sequence:this.rows.length,signature:row.signature});
    } finally { this.appending = null; }
  }
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    // Residual locks are never guessed safe, removed or silently adopted. Controller closes its gate.
    const lock = this.path + '.lock', nonce = randomUUID(), started = Date.now();
    let fd: number | undefined;
    for (let attempt = 0; fd === undefined; attempt++) {
      try { fd = openSync(lock, 'wx', 0o600); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
        // Briefly allow a peer to finish its tiny signed owner record after atomic creation.
        if (attempt >= 3) {
          try {
            const owner = JSON.parse(readFileSync(lock, 'utf8')) as { payload: { pid: number; nonce: string; createdAt: number }; signature: string };
            const signed = createHmac('sha256', this.key).update('lock:' + JSON.stringify(owner.payload)).digest('hex');
            if (owner.signature !== signed || !Number.isSafeInteger(owner.payload.pid) || owner.payload.pid <= 0 || Date.now() - owner.payload.createdAt > 5000) throw unavailable();
            process.kill(owner.payload.pid, 0);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw unavailable(); }
        }
        if (Date.now() - started > 5000) throw unavailable();
        await setTimeout(20);
      }
    }
    try {
      const payload = { pid: process.pid, nonce, createdAt: Date.now() };
      const signature = createHmac('sha256', this.key).update('lock:' + JSON.stringify(payload)).digest('hex');
      writeFileSync(fd, JSON.stringify({ payload, signature })); fsyncSync(fd);
      return await work();
    } finally {
      closeSync(fd);
      const owner = JSON.parse(readFileSync(lock, 'utf8')) as { payload?: { nonce?: string } };
      if (owner.payload?.nonce !== nonce) throw unavailable();
      unlinkSync(lock);
    }
  }
}
