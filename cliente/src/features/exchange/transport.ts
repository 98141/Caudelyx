import { postBinary, postDownload } from '../../shared/api';
import { bytesHash } from './intent';
import { DiscardedRequest } from '../../shared/contracts';
import type { TemplateDownload } from './types';

const TEMPLATE_NAME = /^[a-z0-9-]+\.xlsx$/;
const EXPORT_NAME = /^caudelyx-[a-z]+-[0-9a-f-]{36}\.(xlsx|csv|pdf)$/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export async function templateBytes(item: TemplateDownload): Promise<Uint8Array> {
  if (item.mediaType !== XLSX || !TEMPLATE_NAME.test(item.filename) || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.contentBase64)) {
    throw new Error('unsafe-template');
  }
  const binary = atob(item.contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytes.byteLength !== item.bytes || bytes.byteLength > 131072 || await bytesHash(bytes) !== item.sha256) throw new Error('unsafe-template');
  return bytes;
}

export function saveBytes(filename: string, mediaType: string, bytes: Uint8Array, kind: 'template' | 'export'): void {
  const allowed = kind === 'template' ? TEMPLATE_NAME.test(filename) && mediaType === XLSX : EXPORT_NAME.test(filename) && ['text/csv; charset=utf-8', XLSX, 'application/pdf'].includes(mediaType);
  if (!allowed || /[<>"'`]/.test(filename)) throw new Error('unsafe-download');
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: mediaType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function uploadWorkbook(path: string, bytes: Uint8Array, extra: { ifMatch: string; idempotencyKey: string }): Promise<{ etag: string | null; status: number }> {
  const result = await postBinary<unknown>(path, bytes, XLSX, extra);
  return { etag: result.etag, status: result.status };
}

export async function downloadExport(path: string, extra: { ifMatch: string; idempotencyKey: string }, isCurrent = () => true): Promise<void> {
  const file = await postDownload(path, extra);
  if (!file.sha256 || !/^[0-9a-f]{64}$/.test(file.sha256) || file.bytes.length > 33554432 || await bytesHash(file.bytes) !== file.sha256) throw new Error('unsafe-download');
  if (!isCurrent()) throw new DiscardedRequest();
  saveBytes(file.filename, file.mediaType.split(';')[0] === 'text/csv' ? 'text/csv; charset=utf-8' : file.mediaType, file.bytes, 'export');
}
