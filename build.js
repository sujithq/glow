import { build, context } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of ['index.html', 'examples', 'skill-manifest.json']) {
  await cp(file, `dist/${file}`, { recursive: true });
}
const options = {
  entryPoints: ['src/visualizer.js', 'src/iso-glow-adapter.js'],
  bundle: true,
  format: 'esm',
  outdir: 'dist/assets',
  minify: true,
  sourcemap: true,
  target: ['es2022'],
};
if (process.argv.includes('--serve')) {
  const ctx = await context(options);
  await ctx.watch();
  const server = await ctx.serve({ servedir: 'dist', host: '127.0.0.1', port: 4173 });
  console.log(`Glow: http://${server.hosts[0]}:${server.port}`);
} else {
  await build(options);
  const skill = 'dist/skill/glow';
  await mkdir(skill, { recursive: true });
  for (const file of ['index.html', 'assets', 'examples', 'skill-manifest.json']) {
    await cp(`dist/${file}`, `${skill}/${file}`, { recursive: true });
  }
  for (const file of ['README.md', 'docs', 'LICENSE']) {
    await cp(file, `${skill}/${file}`, { recursive: true });
  }
  const manifest = JSON.parse(await readFile('skill-manifest.json', 'utf8'));
  await writeFile(`${skill}/SKILL.md`, `---\nname: ${manifest.name}\ndescription: ${manifest.description}\n---\n\n${manifest.instructions.join('\n\n')}\n`);
}
