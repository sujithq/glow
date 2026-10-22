import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { changelogSection, readVersion, releaseNotes } from '../scripts/cli-release.mjs';

const changelog = `# Changelog

## Unreleased

- Pending work.

## [1.1.0-beta.1] - 2026-10-01

- Beta feature.

## 1.0.1

- Fixed Terraform plans.

## 1.0.0

- First release.
`;

test('reads the semantic CLI version from the project file', () => {
  assert.equal(readVersion('<Project><PropertyGroup><Version>1.0.1</Version></PropertyGroup></Project>'), '1.0.1');
  assert.equal(readVersion('<Version> 1.1.0-beta.1 </Version>'), '1.1.0-beta.1');
  assert.throws(() => readVersion('<Project />'), /semantic <Version>/);
  assert.throws(() => readVersion('<Version>1.0</Version>'), /semantic <Version>/);
});

test('extracts exactly the changelog section for a version', () => {
  assert.equal(changelogSection(changelog, '1.0.1'), '- Fixed Terraform plans.');
  assert.equal(changelogSection(changelog, '1.1.0-beta.1'), '- Beta feature.');
  assert.equal(changelogSection(changelog, '1.0.0'), '- First release.');
  assert.throws(() => changelogSection(changelog, '1.0'), /no "## 1.0" section/);
  assert.throws(() => changelogSection(changelog, '2.0.0'), /no "## 2.0.0" section/);
  assert.throws(() => changelogSection('## 3.0.0\n\n## 2.0.0\n- x', '3.0.0'), /is empty/);
});

test('release notes link the versioned tool README', () => {
  const notes = releaseNotes(changelog, '1.0.1');
  assert.ok(notes.startsWith('- Fixed Terraform plans.'));
  assert.ok(notes.includes('Glow.Cli.1.0.1.nupkg'));
  assert.ok(notes.includes('/blob/cli-v1.0.1/tools/Glow.Cli/README.md'));
});

test('repository CHANGELOG documents the current CLI version', async () => {
  const [project, current] = await Promise.all([
    readFile(new URL('../tools/Glow.Cli/Glow.Cli.csproj', import.meta.url), 'utf8'),
    readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'),
  ]);
  assert.ok(changelogSection(current, readVersion(project)));
});
