import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { changelogSection, readVersion, releaseNotes } from '../scripts/cli-release.mjs';
import { bump, classifySubject, formatVersion, getUnreleasedSection, parseVersion, transformChangelogForRelease } from '../scripts/prepare-cli-release.mjs';

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

test('calculated release bumps follow Conventional Commits', () => {
  assert.equal(classifySubject('feat(cli): add release automation'), 'minor');
  assert.equal(classifySubject('fix(cli): stop overwriting output'), 'patch');
  assert.equal(classifySubject('feat(cli)!: replace conversion API'), 'major');
  assert.equal(classifySubject('docs: update readme'), null);
  const current = parseVersion('1.2.3');
  assert.equal(formatVersion(bump(current, 'patch')), '1.2.4');
  assert.equal(formatVersion(bump(current, 'minor')), '1.3.0');
  assert.equal(formatVersion(bump(current, 'major')), '2.0.0');
});

test('Unreleased changelog notes are isolated from the next heading', () => {
  assert.equal(
    getUnreleasedSection('## Unreleased\n\n- One change.\n- Another change.\n\n## 1.0.0\n\n- Old change.\n'),
    '- One change.\n- Another change.',
  );
  assert.equal(getUnreleasedSection('# Changelog\n\n## 1.0.0\n\n- Old change.'), null);
});

test('applying a release replaces Unreleased without duplicating notes', () => {
  const source = '# Changelog\n\n## Unreleased\n\n- One change.\n- Another change.\n\n## 1.0.0\n\n- Old change.\n';
  const transformed = transformChangelogForRelease(source, '1.0.1', '- One change.\n- Another change.');
  assert.ok(transformed.includes('# Changelog\n\n## Unreleased\n\n## 1.0.1\n\n- One change.\n- Another change.'));
  assert.ok(transformed.includes('## 1.0.0\n\n- Old change.'));
  assert.equal(transformed.match(/One change/g)?.length, 1);
});
