import { describe, expect, it } from 'vitest';
import {
  auditHosts,
  findHosts,
  formatViolations,
} from '../../scripts/audit-hosts.mjs';

const file = (text: string) => ({ path: 'dist/assets/index.js', text });

describe('allowed-hosts check', () => {
  it('passes a bundle that names only allowed hosts', () => {
    const violations = auditHosts([
      file(
        'fetch("https://api.usegossip.com/v2/messages");' +
          'open("https://dontkillmyapp.com/xiaomi");' +
          'ns="http://www.w3.org/2000/svg"'
      ),
    ]);
    expect(violations).toEqual([]);
  });

  it('passes a known-inert host', () => {
    expect(
      auditHosts([
        file('locateFile:()=>"https://fastly.jsdelivr.net/npm/zxing-wasm"'),
      ])
    ).toEqual([]);
  });

  it("passes the build's own API host", () => {
    expect(
      auditHosts([file('"https://api.staging.example/v2"')], {
        apiUrl: 'https://api.staging.example/v2',
      })
    ).toEqual([]);
  });

  it('fails an unknown host with a message that explains what to do', () => {
    const violations = auditHosts([
      file('fetch("https://telemetry.example.com/collect")'),
      file('img.src="//cdn.example.org/pixel.gif"'),
    ]);

    expect(violations.map(v => v.host)).toEqual([
      'telemetry.example.com',
      'cdn.example.org',
    ]);
    const message = formatViolations(violations);
    expect(message).toContain('telemetry.example.com');
    expect(message).toContain('dist/assets/index.js');
    expect(message).toContain('privacy-first');
    expect(message).toContain('IP address');
    expect(message).toContain('override that default');
    expect(message).toContain('STOP and ask the project owner');
    expect(message).toContain('Do NOT add the host');
  });

  it('ignores custom schemes and comments', () => {
    expect(
      findHosts(
        'gossip://share file://localhost/x server://singlefetch // a comment.example'
      )
    ).toEqual([]);
  });

  it('reads hosts of git+https and websocket URLs', () => {
    expect(
      findHosts('git+https://evil.example wss://relay.example:443/x').map(
        h => h.host
      )
    ).toEqual(['evil.example', 'relay.example']);
  });
});
