// Reads the Glow CLI release version and its CHANGELOG.md section.
// Usage: node scripts/cli-release.mjs [--notes <output-file>]
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

export function readVersion(project) {
  const version = project.match(/<Version>\s*([^<\s]+)\s*<\/Version>/)?.[1];
  if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Glow.Cli.csproj must contain a semantic <Version>, found "${version ?? ''}".`);
  }
  return version;
}

export function changelogSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## \\[?${escaped}\\]?(?:\\s.*)?$`, 'm');
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no "## ${version}" section.`);
  const rest = changelog.slice(match.index + match[0].length);
  const body = rest.split(/^## /m)[0].trim();
  if (!body) throw new Error(`CHANGELOG.md section "## ${version}" is empty.`);
  return body;
}

export function releaseNotes(changelog, version) {
  const readme = `https://github.com/sujithq/glow/blob/cli-v${version}/tools/Glow.Cli/README.md`;
  return `${changelogSection(changelog, version)}\n\n` +
    `### Install\n\nDownload \`Glow.Cli.${version}.nupkg\` and \`SHA256SUMS\`, verify the checksum, then follow the ` +
    `[tool README](${readme}) for installation and the Bicep, Terraform, and .NET workflows. ` +
    'This package is distributed through GitHub Releases, not NuGet.org.\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [project, changelog] = await Promise.all([
    readFile(new URL('tools/Glow.Cli/Glow.Cli.csproj', root), 'utf8'),
    readFile(new URL('CHANGELOG.md', root), 'utf8'),
  ]);
  const version = readVersion(project);
  const notes = releaseNotes(changelog, version);
  const notesIndex = process.argv.indexOf('--notes');
  if (notesIndex > 0) await writeFile(process.argv[notesIndex + 1], notes);
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=cli-v${version}\nprerelease=${version.includes('-')}\n`);
  }
  console.log(version);
}
