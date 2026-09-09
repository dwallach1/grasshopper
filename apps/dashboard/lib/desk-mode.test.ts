import { describe, expect, test } from 'bun:test';

import { isPublicDesk, publicDeskOrigin } from './desk-mode';

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

  test('public origin stays empty unless set', () => {
    const urlWas = process.env.NEXT_PUBLIC_DESK_URL;
    delete process.env.NEXT_PUBLIC_DESK_URL;
    expect(publicDeskOrigin()).toBe('');
    process.env.NEXT_PUBLIC_DESK_URL = 'https://example.workers.dev/';
    expect(publicDeskOrigin()).toBe('https://example.workers.dev');
    if (urlWas === undefined) delete process.env.NEXT_PUBLIC_DESK_URL;
    else process.env.NEXT_PUBLIC_DESK_URL = urlWas;
  });
});
