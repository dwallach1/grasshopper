import { describe, expect, test } from 'bun:test';

import { isPublicDesk, publicDeskOrigin, publicDeskSnapshotPath } from './desk-mode';

describe('desk mode', () => {
  test('defaults to the operator desk', () => {
    const previous = process.env.NEXT_PUBLIC_DESK_MODE;
    delete process.env.NEXT_PUBLIC_DESK_MODE;
    expect(isPublicDesk()).toBe(false);
    process.env.NEXT_PUBLIC_DESK_MODE = 'public';
    expect(isPublicDesk()).toBe(true);
    process.env.NEXT_PUBLIC_DESK_MODE = 'PUBLIC';
    expect(isPublicDesk()).toBe(true);
    if (previous === undefined) delete process.env.NEXT_PUBLIC_DESK_MODE;
    else process.env.NEXT_PUBLIC_DESK_MODE = previous;
  });

  test('snapshot path and public origin stay empty unless set', () => {
    const pathWas = process.env.PUBLIC_DESK_SNAPSHOT_PATH;
    const urlWas = process.env.NEXT_PUBLIC_DESK_URL;
    delete process.env.PUBLIC_DESK_SNAPSHOT_PATH;
    delete process.env.NEXT_PUBLIC_DESK_URL;
    expect(publicDeskSnapshotPath()).toBe('');
    expect(publicDeskOrigin()).toBe('');
    process.env.PUBLIC_DESK_SNAPSHOT_PATH = '/tmp/desk.json';
    process.env.NEXT_PUBLIC_DESK_URL = 'https://example.workers.dev/';
    expect(publicDeskSnapshotPath()).toBe('/tmp/desk.json');
    expect(publicDeskOrigin()).toBe('https://example.workers.dev');
    if (pathWas === undefined) delete process.env.PUBLIC_DESK_SNAPSHOT_PATH;
    else process.env.PUBLIC_DESK_SNAPSHOT_PATH = pathWas;
    if (urlWas === undefined) delete process.env.NEXT_PUBLIC_DESK_URL;
    else process.env.NEXT_PUBLIC_DESK_URL = urlWas;
  });
});
