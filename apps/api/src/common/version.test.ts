import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeVersion, resolveVersion } from './version';

const pkg = (path: string): { version: string } =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../..', path), 'utf8'));

describe('normalizeVersion', () => {
  it('reads a release tag however it is spelled', () => {
    expect(normalizeVersion('v1.3.0')).toBe('1.3.0');
    expect(normalizeVersion('1.3.0')).toBe('1.3.0');
    expect(normalizeVersion('refs/tags/v2.0.0-rc.1')).toBe('2.0.0-rc.1');
    expect(normalizeVersion('  v1.4.2+build.7 ')).toBe('1.4.2+build.7');
  });

  it('is not fooled by a branch name or a commit: an image built from main is not "version main"', () => {
    for (const notAVersion of [
      'main',
      'fix/version-reporting',
      'a1b2c3d',
      'v',
      'vNext',
      '1.3',
      '',
      '   ',
      undefined,
    ]) {
      expect(normalizeVersion(notAVersion)).toBeNull();
    }
  });
});

describe('resolveVersion', () => {
  it('prefers what the image build baked in', () => {
    expect(resolveVersion({ SYNCLE_VERSION: 'v9.8.7' })).toMatchObject({
      version: '9.8.7',
      source: 'build',
    });
  });

  it('falls back to the package when the build said nothing useful', () => {
    const own = pkg('apps/api/package.json').version;
    expect(resolveVersion({})).toMatchObject({
      version: own,
      source: 'package',
    });
    expect(resolveVersion({ SYNCLE_VERSION: '' })).toMatchObject({
      version: own,
      source: 'package',
    });
    expect(resolveVersion({ SYNCLE_VERSION: 'main' })).toMatchObject({
      version: own,
      source: 'package',
    });
    expect(resolveVersion({}).node).toBe(process.versions.node);
  });
});

describe('the packages', () => {
  it('all carry the same version: they are released together', () => {
    const versions = [
      'package.json',
      'apps/api/package.json',
      'apps/web/package.json',
      'packages/core/package.json',
      'website/package.json',
    ].map((p) => [p, pkg(p).version] as const);
    const root = versions[0]![1];
    expect(root).toMatch(/^\d+\.\d+\.\d+/);
    expect(versions.filter(([, v]) => v !== root)).toEqual([]);
  });

  it('are not behind the newest release the changelog records', () => {
    const changelog = readFileSync(
      resolve(__dirname, '../../../..', 'CHANGELOG.md'),
      'utf8',
    );
    const released = [
      ...changelog.matchAll(/^## \[(\d+)\.(\d+)\.(\d+)\]/gm),
    ].map((m) => m.slice(1, 4).map(Number));
    expect(released.length).toBeGreaterThan(0);
    const newest = released.sort(
      (a, b) => b[0]! - a[0]! || b[1]! - a[1]! || b[2]! - a[2]!,
    )[0]!;
    const own = pkg('package.json')
      .version.split(/[.-]/)
      .slice(0, 3)
      .map(Number);
    const behind =
      own[0]! < newest[0]! ||
      (own[0] === newest[0] && own[1]! < newest[1]!) ||
      (own[0] === newest[0] && own[1] === newest[1] && own[2]! < newest[2]!);
    // it said 1.0.0 through 1.1, 1.2 and 1.3
    expect(
      behind,
      `package.json says ${own.join('.')}, CHANGELOG.md has ${newest.join('.')}`,
    ).toBe(false);
  });
});
