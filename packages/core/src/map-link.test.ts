import { describe, expect, it } from 'vitest';
import { MAX_MAP_URL_LENGTH, mapLinkHref, parseMapUrl } from './map-link';

describe('parseMapUrl', () => {
  it('accepts http and https addresses, trimmed and normalised', () => {
    expect(parseMapUrl('https://map.example.com')).toBe('https://map.example.com/');
    expect(parseMapUrl('  http://192.168.1.20:4000/guild  ')).toBe(
      'http://192.168.1.20:4000/guild',
    );
    expect(parseMapUrl('HTTPS://Map.Example.com/guild?x=1#top')).toBe(
      'https://map.example.com/guild?x=1#top',
    );
  });

  it('refuses anything a link must not go to', () => {
    for (const text of [
      '',
      '   ',
      'map.example.com',
      '/guild',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://map.example.com',
      'https://user:pw@map.example.com',
      `https://map.example.com/${'a'.repeat(MAX_MAP_URL_LENGTH)}`,
    ]) {
      expect(parseMapUrl(text), text).toBeNull();
    }
  });
});

describe('mapLinkHref', () => {
  it('is the address only while the link is on', () => {
    expect(mapLinkHref({ enabled: true, url: 'https://map.example.com/' })).toBe(
      'https://map.example.com/',
    );
    expect(mapLinkHref({ enabled: false, url: 'https://map.example.com/' })).toBeNull();
    expect(mapLinkHref({ enabled: true, url: null })).toBeNull();
    expect(mapLinkHref({ enabled: true, url: 'javascript:alert(1)' })).toBeNull();
  });
});
