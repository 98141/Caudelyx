const STORAGE_KEY = 'caudelyx.s06.payments.draft';

export interface DraftOwner {
  userId: string;
  organizationId: string;
  roles: string;
}

export interface DraftBody {
  owner: DraftOwner;
  executionKey: string | null;
  frozen: string | null;
  fields: Record<string, string>;
}

export function ownerKey(owner: DraftOwner): string {
  return `${owner.userId}|${owner.organizationId}|${owner.roles}`;
}

export function readDraft(owner: DraftOwner): DraftBody | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DraftBody;
    if (!parsed?.owner || ownerKey(parsed.owner) !== ownerKey(owner)) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeDraft(draft: DraftBody): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

export function clearDraft(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
