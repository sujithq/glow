#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { convertSolution } from '../src/solution-converter.js';

const help = `Usage: npm run convert:solution -- <solution.sln|solution.slnx> [options]

Convert local NuGet restore assets to a Glow configuration.
Run dotnet restore yourself first. No builds, restores, or network calls are made.

Options:
  -o, --output <file>  Output path (default: glow.config.yaml); refuses to overwrite
  -t, --target <key>   Exact project.assets.json target key; required if ambiguous
  -h, --help           Show this help
`;

try {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: 'string', short: 'o', default: 'glow.config.yaml' },
      target: { type: 'string', short: 't' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(help);
  } else {
    if (positionals.length !== 1) throw new Error('Provide exactly one .sln or .slnx path. Use --help for usage.');
    const yaml = await convertSolution(positionals[0], { target: values.target });
    await writeFile(values.output, yaml, { flag: 'wx' });
    process.stdout.write(`Created ${values.output}. Import this file with Glow's Import config button.\n`);
  }
} catch (error) {
  process.stderr.write(`Glow conversion failed: ${error.message}\n`);
  process.exitCode = 1;
}
