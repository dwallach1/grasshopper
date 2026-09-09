import { describe, expect, test } from 'bun:test';

import { parseUnknownJson, readBoundedJson } from './http';

describe('parseUnknownJson', () => {
  test('parses objects and rejects HTML or Cloudflare text pages', () => {
    expect(parseUnknownJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseUnknownJson('  [1, 2]  ')).toEqual([1, 2]);
    expect(parseUnknownJson('')).toBeNull();
    expect(() => parseUnknownJson('<!DOCTYPE html><html>')).toThrow('Response was not JSON');
    expect(() => parseUnknownJson('error code: 1102')).toThrow('Response was not JSON');
    expect(() => parseUnknownJson('{not json')).toThrow('Response was not JSON');
  });
});

describe('readBoundedJson', () => {
  test('does not throw a raw JSON.parse SyntaxError for HTML', async () => {
    const response = new Response('<!DOCTYPE html>', {
      headers: { 'content-type': 'text/html' },
    });
    await expect(readBoundedJson(response, 1024)).rejects.toThrow('Response was not JSON');
  });
});
