/**
 * The Helm chart says what Syncle it runs, and where the image comes from.
 * Both are said elsewhere too — the API's package, the installer, the compose
 * file — and a release that bumped one and not the other would ship a chart
 * pointing at the previous version, or at nothing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8');
const chart = read('deploy/helm/syncle/Chart.yaml');
const values = read('deploy/helm/syncle/values.yaml');

describe('the Helm chart', () => {
  it('runs the version of Syncle this repository is', () => {
    const own = (
      JSON.parse(read('apps/api/package.json')) as { version: string }
    ).version;
    expect(chart).toMatch(
      new RegExp(`^appVersion: '${own.replace(/\./g, '\\.')}'$`, 'm'),
    );
  });

  it('pulls the image the installer and the compose file pull', () => {
    const installer = /IMAGE_REPO="([^"]+)"/.exec(read('install.sh'))![1]!;
    expect(values).toMatch(
      new RegExp(`^  repository: ${installer.replace(/\//g, '\\/')}$`, 'm'),
    );
    expect(read('docker-compose.app.yml')).toContain(`${installer}:latest`);
  });

  it('is versioned itself, so a change to it is a release of it', () => {
    expect(chart).toMatch(/^version: \d+\.\d+\.\d+$/m);
  });

  it('passes every tunable through: the compose file names them one by one, the chart takes them as a map', () => {
    // the compose file lists every SYNCLE_* setting the API reads (a test holds it to that);
    // the chart takes any of them under api.env, and must say so where people look
    expect(values).toMatch(/^ {2}env: \{\}$/m);
    expect(values).toContain('every SYNCLE_* tunable the API reads');
    const template = read('deploy/helm/syncle/templates/api.yaml');
    expect(template).toContain('range $name, $value := .Values.api.env');
  });
});
