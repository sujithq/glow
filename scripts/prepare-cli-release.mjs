import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectPath = 'tools/Glow.Cli/Glow.Cli.csproj';
const changelogPath = 'CHANGELOG.md';
const apply = process.argv.includes('--apply');

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function remoteTagExists(tag) {
  const result = spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], {
    encoding: 'utf8',
  });
  if (result.status === 128) {
    throw new Error(`Unable to query remote tags for ${tag}: ${result.stderr.trim()}`);
  }
  return result.status === 0;
}

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}

export function formatVersion(value) {
  return `${value.major}.${value.minor}.${value.patch}${value.prerelease ? `-${value.prerelease}` : ''}`;
}

export function bump(current, kind) {
  if (current.prerelease) {
    throw new Error(`Current version ${formatVersion(current)} is prerelease. Prepare it explicitly with a stable or successive prerelease version.`);
  }
  if (kind === 'major') return { major: current.major + 1, minor: 0, patch: 0 };
  if (kind === 'minor') return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

export function classifySubject(subject) {
  if (/^(\w+)(?:\([^)]*\))?!:/.test(subject)) return 'major';
  if (/\bBREAKING CHANGE:/i.test(subject)) return 'major';
  const type = /^([a-zA-Z]+)(?:\([^)]*\))?!?:/.exec(subject)?.[1]?.toLowerCase();
  if (type === 'feat') return 'minor';
  if (['fix', 'perf', 'refactor'].includes(type)) return 'patch';
  return null;
}

export function getUnreleasedSection(changelog) {
  const heading = /^## Unreleased[^\r\n]*\s*$/m.exec(changelog);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(changelog.slice(start + 1));
  const body = next
    ? changelog.slice(start + 1, start + 1 + next.index)
    : changelog.slice(start + 1);
  return body.trim();
}

export function transformChangelogForRelease(changelog, version, notes) {
  const heading = /^## Unreleased[^\r\n]*(?:\r?\n|$)/m.exec(changelog);
  if (!heading) throw new Error('CHANGELOG.md must contain an Unreleased section.');

  const start = heading.index + heading[0].length;
  const next = /^## /m.exec(changelog.slice(start));
  const end = next ? start + next.index : changelog.length;
  return (
    changelog.slice(0, heading.index) +
    '## Unreleased\n\n' +
    `## ${version}\n\n${notes.trim()}\n\n` +
    changelog.slice(end).replace(/^\s*/, '')
  );
}

export async function prepareCliRelease({ apply = false } = {}) {
  try {
    const status = git(['status', '--porcelain']);
    const project = await readFile(projectPath, 'utf8');
    const changelog = await readFile(changelogPath, 'utf8');
    const currentText = /<Version>\s*([^<\s]+)\s*<\/Version>/.exec(project)?.[1];
    if (!currentText) throw new Error(`No <Version> found in ${projectPath}`);
    const current = parseVersion(currentText);

    const tags = git(['tag', '--list', 'cli-v*', '--sort=-v:refname']).split('\n').filter(Boolean);
    const latestTag = tags.find((tag) => /^cli-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag));
    const range = latestTag ? `${latestTag}..HEAD` : 'HEAD';
    const subjects = git(['log', '--format=%s%n%b%n--END--', range])
      .split('\n')
      .filter((line) => line && line !== '--END--')
      .filter((line) => {
        if (/^Merge\b/i.test(line)) return false;
        return !['Signed-off-by:', 'Co-authored-by:'].some((prefix) => line.startsWith(prefix));
      });

    let highest = null;
    for (const subject of subjects) {
      const kind = classifySubject(subject);
      if (kind === 'major') { highest = 'major'; break; }
      if (kind === 'minor' && highest !== 'major') highest = 'minor';
      if (kind === 'patch' && !highest) highest = 'patch';
    }

    if (!highest) throw new Error(`No release-worthy Conventional Commit found since ${latestTag ?? 'the repository root'}.`);

    const next = bump(current, highest);
    const nextText = formatVersion(next);
    const tag = `cli-v${nextText}`;
    if (remoteTagExists(tag)) throw new Error(`Release tag ${tag} already exists remotely.`);

    const releaseNotes = getUnreleasedSection(changelog);
    if (!releaseNotes) throw new Error('CHANGELOG.md must contain non-empty ## Unreleased notes.');

    if (!apply) {
      return {
        currentVersion: currentText,
        baseTag: latestTag ?? '(repository root)',
        bump: highest,
        nextVersion: nextText,
        tag,
        notes: releaseNotes,
      };
    }

    if (status) {
      throw new Error('The worktree has uncommitted changes. Commit or stash them before applying a release bump.');
    }

    let updatedChangelog = transformChangelogForRelease(
      changelog.replace(/^## Unreleased[^\r\n]*\r?\n/, '## Unreleased\n'),
      nextText,
      releaseNotes,
    );

    const updatedProject = project.replace(
      /<Version>\s*[^<\s]+\s*<\/Version>/,
      `<Version>${nextText}</Version>`,
    );
    await writeFile(changelogPath, updatedChangelog);
    await writeFile(projectPath, updatedProject);
    return { prepared: true, version: nextText, tag };
  } catch (error) {
    throw new Error(`Release preparation failed: ${error.message}`, { cause: error });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepareCliRelease({ apply: process.argv.includes('--apply') })
    .then((result) => {
      if (result.prepared) {
        console.log(`Prepared ${result.tag}`);
      } else {
        console.log(`Current version: ${result.currentVersion}`);
        console.log(`Base tag: ${result.baseTag}`);
        console.log(`Calculated bump: ${result.bump}`);
        console.log(`Next version: ${result.nextVersion}`);
        console.log(`Release tag: ${result.tag}`);
        console.log(`Unreleased notes:\n${result.notes}`);
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
