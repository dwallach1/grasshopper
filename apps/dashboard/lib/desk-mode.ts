export function isPublicDesk(): boolean {
  return (process.env.NEXT_PUBLIC_DESK_MODE || '').trim().toLowerCase() === 'public';
}

export function publicDeskOrigin(): string {
  const raw = (process.env.NEXT_PUBLIC_DESK_URL || '').trim();
  return raw.replace(/\/$/, '');
}
