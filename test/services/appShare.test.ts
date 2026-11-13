import { describe, expect, it } from 'vitest';
import { buildLandingPage, wifiJoinCode } from '../../src/services/appShare';

describe('wifiJoinCode', () => {
  it('builds the WIFI: text phone cameras recognise', () => {
    expect(wifiJoinCode('DIRECT-ab-Gossip', 'abcdefghjk')).toBe(
      'WIFI:T:WPA;S:DIRECT-ab-Gossip;P:abcdefghjk;;'
    );
  });

  it('escapes the characters the format reserves', () => {
    expect(wifiJoinCode('a;b', 'p:q"r\\s,t')).toBe(
      'WIFI:T:WPA;S:a\\;b;P:p\\:q\\"r\\\\s\\,t;;'
    );
  });
});

describe('buildLandingPage', () => {
  const texts = {
    lang: 'en',
    title: 'Install Gossip',
    androidSteps: 'Tap <Download>',
    download: 'Download & install',
    iosTitle: 'iPhone',
    iosSteps: 'Use Safari',
    webAppUrl: 'https://example.org/?a="b"',
  };

  it('links the APK and the web app', () => {
    const page = buildLandingPage(texts);
    expect(page).toContain('href="/Gossip.apk"');
    expect(page).toContain('https://example.org/?a=&quot;b&quot;');
  });

  it('escapes translated texts', () => {
    const page = buildLandingPage(texts);
    expect(page).toContain('Tap &lt;Download&gt;');
    expect(page).toContain('Download &amp; install');
    expect(page).not.toContain('<Download>');
  });
});
