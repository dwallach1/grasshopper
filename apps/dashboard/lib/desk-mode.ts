export function isPublicDesk(): boolean {
  return (process.env.NEXT_PUBLIC_DESK_MODE || '').trim().toLowerCase() === 'public';
}

export function publicDeskSnapshotPath(): string {
  return (process.env.PUBLIC_DESK_SNAPSHOT_PATH || '').trim();
}

export function publicDeskOrigin(): string {
  const raw = (process.env.NEXT_PUBLIC_DESK_URL || '').trim();
  return raw.replace(/\/$/, '');
}
