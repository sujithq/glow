import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseInput, normalizeConfig, affectedBy, health } from '../src/parser.js';

test('all shipped examples parse with valid relationships', async () => {
  for (const file of ['glow.config.yaml', 'healthy.config.yaml', 'vulnerable.config.yaml', 'package.json-example', 'requirements.txt-example', 'sample.csproj', 'packages.config']) {
    const graph = parseInput(await readFile(new URL(`../examples/${file}`, import.meta.url), 'utf8'), file);
    assert.ok(graph.nodes.length > 0);
    assert.ok(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.target)));
  }
});
test('package manifests preserve version ranges and deduplicate groups', () => {
  const graph = parseInput(JSON.stringify({ dependencies: { react: '^18.0.0' }, devDependencies: { react: '18.2.0', test: '1.0.0' } }), 'package.json');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].version, '^18.0.0');
});
test('npm optional dependencies override regular dependencies', () => {
  const graph = parseInput(JSON.stringify({
    dependencies: { foo: '1.0.0' },
    optionalDependencies: { foo: '2.0.0' },
  }), 'package.json');
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].version, '2.0.0');
  assert.equal(graph.nodes[0].type, 'optionalDependencies');
});
test('requirements pins, extras, normalized names, and ranges', () => {
  const graph = parseInput('My_Package[extra]==1.2.3 # pin\nFlask>=2.0,<4.0\nrequests', 'requirements.txt');
  assert.deepEqual(graph.nodes.map(node => [node.name, node.version]), [
    ['my-package', '1.2.3'], ['flask', '>=2.0,<4.0'], ['requests', '*'],
  ]);
  for (const source of ['-r secrets.txt', 'foo @ https://example.com/foo', 'foo==1.0; python_version>"3"']) {
    assert.throws(() => parseInput(source, 'requirements.txt'), /Unsupported requirement/);
  }
});
test('rejects malformed configs, duplicate names, unknown edges, and YAML aliases', () => {
  for (const source of ['[a, b]', 'dependencies: nope', 'dependencies:\n- name: a\n- name: a', 'dependencies:\n- name: a\n  dependencies: [missing]', 'dependencies:\n- name: a\n  status: bogus', 'dependencies: &a [*a]']) {
    assert.throws(() => parseInput(source));
  }
  assert.throws(() => parseInput('a'.repeat(1_000_001)), /1 MB/);
  assert.throws(() => normalizeConfig({ dependencies: Array.from({ length: 301 }, (_, i) => ({ name: `${i}` })) }), /300/);
  assert.throws(() => parseInput('project: one\nproject: two'), /unique/);
});
test('impact traversal handles cycles and finds transitive dependents', () => {
  const graph = normalizeConfig({ dependencies: [
    { name: 'a', dependencies: ['b'] }, { name: 'b', dependencies: ['a'] },
  ], services: [{ name: 'api', dependencies: ['a'] }] });
  assert.deepEqual(affectedBy(graph, 'b').sort(), ['a', 'api']);
});
test('security never treats unscanned components as cleared', () => {
  const [node] = normalizeConfig({ dependencies: [{ name: 'test' }] }).nodes;
  assert.equal(health(node), 'healthy');
  assert.equal(health(node, 'security'), 'warning');
  assert.equal(health({ ...node, scan: 'clean' }, 'security'), 'healthy');
  assert.equal(health({ ...node, vulnerabilityCount: 1 }), 'critical');
  assert.equal(health({ ...node, errors: ['offline'] }), 'warning');
});
test('JSON snapshots retain findings but never reuse previous scan clearance', () => {
  const graph = normalizeConfig({ dependencies: [
    { name: 'a', vulnerabilities: [{ id: 'CVE-2025-12345' }] },
    { name: 'b', vulnerabilities: 3 },
  ] });
  graph.nodes[0].scan = 'clean';
  graph.nodes[0].vulnerabilityCount = 2;
  const restored = parseInput(JSON.stringify(graph), 'glow-report.json');
  assert.equal(restored.nodes[0].scan, 'not checked');
  assert.equal(restored.nodes[0].advisories[0].id, 'CVE-2025-12345');
  assert.equal(restored.nodes[0].vulnerabilityCount, 2);
  assert.equal(restored.nodes[1].vulnerabilityCount, 3);
});

const csproj = content => `<Project Sdk="Microsoft.NET.Sdk">${content}</Project>`;
const references = content => csproj(`<ItemGroup>${content}</ItemGroup>`);
const parseProject = content => parseInput(references(content), 'sample.csproj');

test('NuGet config canonicalizes package identities and only known NuGet graph references', () => {
  const graph = normalizeConfig({
    dependencies: [
      { name: 'Newtonsoft.Json', ecosystem: 'NuGet', version: '13.0.3' },
      { name: 'UPPER_npm', dependencies: ['NEWTONSOFT.JSON', 'newtonsoft.json'] },
      { name: 'Python-Package', ecosystem: 'PyPI' },
    ],
    services: [{ name: 'API', dependencies: ['Newtonsoft.Json', 'UPPER_npm', 'Python-Package'] }],
  });
  assert.deepEqual(graph.nodes.map(node => node.name), ['newtonsoft.json', 'UPPER_npm', 'Python-Package', 'API']);
  assert.equal(graph.nodes[0].packageName, 'Newtonsoft.Json');
  assert.ok(graph.nodes.slice(1).every(node => !Object.hasOwn(node, 'packageName')));
  assert.deepEqual(graph.nodes[1].dependencies, ['newtonsoft.json']);
  assert.deepEqual(graph.edges, [
    { source: 'UPPER_npm', target: 'newtonsoft.json' },
    { source: 'API', target: 'newtonsoft.json' },
    { source: 'API', target: 'UPPER_npm' },
    { source: 'API', target: 'Python-Package' },
  ]);
  assert.throws(() => normalizeConfig({
    dependencies: [{ name: 'Foo', ecosystem: 'npm' }],
    services: [{ name: 'api', dependencies: ['FOO'] }],
  }), /unknown component FOO/);
  assert.throws(() => normalizeConfig({
    dependencies: [{ name: 'foo', ecosystem: 'NuGet' }],
    services: [{ name: 'api', dependencies: ['MISSING'] }],
  }), /unknown component MISSING/);
});

test('exact existing non-NuGet identities take precedence over case-insensitive NuGet references', () => {
  const graph = normalizeConfig({
    dependencies: [{ name: 'Foo', ecosystem: 'npm' }, { name: 'foo', ecosystem: 'NuGet' }],
    services: [{ name: 'api', dependencies: ['Foo', 'FOO'] }],
  });
  assert.deepEqual(graph.nodes[2].dependencies, ['Foo', 'foo']);
});

test('NuGet IDs allow only ASCII letters, digits, underscores, dots, and hyphens up to 100 characters', () => {
  for (const name of ['A', '0123', 'A_B.C-1', 'a'.repeat(100)]) {
    assert.equal(normalizeConfig({ dependencies: [{ name, ecosystem: 'NuGet' }] }).nodes[0].name, name.toLowerCase());
  }
  for (const name of ['bad name', ' leading', 'trailing ', 'a/b', '@scope/name', 'café', 'a'.repeat(101), '$(Name)']) {
    assert.throws(() => normalizeConfig({ dependencies: [{ name, ecosystem: 'NuGet' }] }), /Invalid NuGet package ID/);
  }
  assert.throws(() => normalizeConfig({ dependencies: [{ name: 'a', ecosystem: 'nuget' }] }), /Unsupported ecosystem/);
});

test('NuGet duplicate case variants and canonical cross-ecosystem collisions are rejected', () => {
  for (const dependencies of [
    [{ name: 'Foo', ecosystem: 'NuGet' }, { name: 'FOO', ecosystem: 'NuGet' }],
    [{ name: 'foo' }, { name: 'FOO', ecosystem: 'NuGet' }],
  ]) assert.throws(() => normalizeConfig({ dependencies }), /Duplicate component: foo/);
  assert.throws(() => normalizeConfig({
    dependencies: [{ name: 'FOO', ecosystem: 'NuGet' }],
    services: [{ name: 'foo' }],
  }), /Duplicate component: foo/);
});

test('NuGet registry spelling is preserved but cannot redirect lookup to a different package', () => {
  const graph = normalizeConfig({
    dependencies: [
      { name: 'newtonsoft.json', ecosystem: 'NuGet', packageName: 'Newtonsoft.Json', version: '12.0.1' },
      { name: 'npm-package', packageName: 'ignored' },
      { name: 'python-package', ecosystem: 'PyPI', packageName: 'ignored' },
    ],
  });
  assert.equal(graph.nodes[0].name, 'newtonsoft.json');
  assert.equal(graph.nodes[0].packageName, 'Newtonsoft.Json');
  assert.ok(graph.nodes.slice(1).every(node => !Object.hasOwn(node, 'packageName')));
  for (const packageName of ['Different.Package', ' Newtonsoft.Json', 'Newtonsoft.Json ', 'Newtonsoft/Json', 42, {}, ['Newtonsoft.Json']]) {
    assert.throws(() => normalizeConfig({
      dependencies: [{ name: 'newtonsoft.json', ecosystem: 'NuGet', packageName }],
    }), /packageName must match/);
  }
});

test('NuGet snapshots restore mixed-case identity counts and references without scan clearance', () => {
  const graph = parseInput(JSON.stringify({
    nodes: [
      { name: 'Newtonsoft.Json', ecosystem: 'NuGet', kind: 'package', version: '13.0.3', vulnerabilityCount: 4, scan: 'clean' },
      { name: 'API', kind: 'service', dependencies: ['NEWTONSOFT.JSON'] },
    ],
  }), 'report.json');
  assert.equal(graph.nodes[0].name, 'newtonsoft.json');
  assert.equal(graph.nodes[0].packageName, 'Newtonsoft.Json');
  assert.equal(graph.nodes[0].vulnerabilityCount, 4);
  assert.equal(graph.nodes[0].scan, 'not checked');
  assert.deepEqual(graph.edges, [{ source: 'API', target: 'newtonsoft.json' }]);
  assert.throws(() => parseInput(JSON.stringify({
    nodes: [{ name: 'Foo', ecosystem: 'NuGet', vulnerabilityCount: -1 }],
  }), 'report.json'), /vulnerabilities/);
  const restored = parseInput(JSON.stringify(graph), 'report.json');
  assert.equal(restored.nodes[0].name, 'newtonsoft.json');
  assert.equal(restored.nodes[0].packageName, 'Newtonsoft.Json');
  assert.equal(restored.nodes[0].vulnerabilityCount, 4);
  assert.throws(() => parseInput(JSON.stringify({
    nodes: [{ name: 'newtonsoft.json', ecosystem: 'NuGet', packageName: 'Other.Package' }],
  }), 'report.json'), /packageName must match/);
});

test('csproj parses direct PackageReference attributes and nested string versions as minimum constraints', () => {
  const graph = parseInput(`<?xml version="1.0" encoding="utf-8"?>
    <Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><TargetFramework>net8.0</TargetFramework><MyVersion>1.0.0</MyVersion></PropertyGroup>
      <ItemGroup>
        <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
        <PackageReference Include="Other.Package"><Version> 1.0 </Version><PrivateAssets>all</PrivateAssets></PackageReference>
        <PackageReference Include="Missing.Version" />
      </ItemGroup>
    </Project>`, 'SAMPLE.CSPROJ');
  assert.deepEqual(graph.nodes.map(node => [node.name, node.ecosystem, node.version]), [
    ['newtonsoft.json', 'NuGet', '>=13.0.3'], ['other.package', 'NuGet', '>=1.0'], ['missing.version', 'NuGet', '*'],
  ]);
  assert.equal(graph.nodes[0].packageName, 'Newtonsoft.Json');
  assert.ok(graph.nodes.every(node => node.scan === 'not checked'));
  assert.deepEqual(graph.edges, []);
});

test('csproj explicit exact brackets, ranges, floating versions, and properties retain their meaning', () => {
  const versions = ['[1.2.3]', '[ 1.2.3 ]', '[1.0,2.0)', '(,2.0]', '[1.0,)', '1.*', '*', '1.2.3-*', '$(PackageVersion)', '1.$(Patch)', '0', '1.2.3-beta.1+build'];
  const graph = parseProject(versions.map((version, i) => `<PackageReference Include="Package${i}" Version="${version}" />`).join(''));
  assert.deepEqual(graph.nodes.map(node => node.version), [
    '1.2.3', '1.2.3', '[1.0,2.0)', '(,2.0]', '[1.0,)', '1.*', '*', '1.2.3-*', '$(PackageVersion)', '1.$(Patch)', '>=0', '>=1.2.3-beta.1+build',
  ]);
});

test('VersionOverride takes precedence without resolving properties or losing minimum semantics', () => {
  const graph = parseProject(`
    <PackageReference Include="A" Version="1.0" VersionOverride="2.0" />
    <PackageReference Include="B"><Version>1.0</Version><VersionOverride>[2.0]</VersionOverride></PackageReference>
    <PackageReference Include="C" Version="1.0"><VersionOverride>$(Override)</VersionOverride></PackageReference>
    <PackageReference Include="D" VersionOverride="3.*" />
  `);
  assert.deepEqual(graph.nodes.map(node => node.version), ['>=2.0', '2.0', '$(Override)', '3.*']);
});

test('PackageReference supports harmless metadata attributes and child metadata', () => {
  const graph = parseProject(`
    <PackageReference Include="A" Version="[1.0]" PrivateAssets="all"
      IncludeAssets="runtime; build" ExcludeAssets="contentFiles" Aliases="global"
      GeneratePathProperty="true" NoWarn="NU1605" />
    <PackageReference Include="B" Version="[2.0]">
      <PrivateAssets>all</PrivateAssets><IncludeAssets>runtime; build</IncludeAssets>
      <ExcludeAssets>contentFiles</ExcludeAssets><Aliases>global</Aliases>
      <GeneratePathProperty>true</GeneratePathProperty><NoWarn>NU1605</NoWarn>
    </PackageReference>
  `);
  assert.deepEqual(graph.nodes.map(node => [node.name, node.version]), [['a', '1.0'], ['b', '2.0']]);
  assert.throws(() => parseProject('<PackageReference Include="A" Version="[1]" UnknownMetadata="all" />'), /Unsupported XML attribute/);
  assert.throws(() => parseProject('<PackageReference Include="A" Version="[1]" PrivateAssets="all" Condition="true" />'), /Conditional/);
});

test('packages.config installed versions remain exact and case-normalized', () => {
  const graph = parseInput(`<?xml version="1.0"?>
    <packages>
      <package id="Newtonsoft.Json" version="13.0.3" targetFramework="net48" />
      <package id="Other" version="01.02.03" developmentDependency="true" allowedVersions="[1,2)" requireReinstallation="false" />
    </packages>`, 'packages.config');
  assert.deepEqual(graph.nodes.map(node => [node.name, node.version]), [['newtonsoft.json', '13.0.3'], ['other', '01.02.03']]);
  assert.equal(graph.nodes[0].packageName, 'Newtonsoft.Json');
});

test('XML manifest dispatch supports example suffixes and file paths', () => {
  for (const filename of ['sample.csproj-example', 'dir/SAMPLE.CSPROJ', 'dir\\sample.csproj']) {
    assert.equal(parseInput(references('<PackageReference Include="A" Version="1" />'), filename).nodes[0].version, '>=1');
  }
  for (const filename of ['packages.config-example', 'dir/PACKAGES.CONFIG', 'dir\\packages.config-example']) {
    assert.equal(parseInput('<packages><package id="A" version="1" /></packages>', filename).nodes[0].version, '1');
  }
});

test('legacy csproj default XML namespaces are supported without evaluating MSBuild', () => {
  const graph = parseInput(`
    <Project ToolsVersion="15.0" DefaultTargets="Build" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
      <ItemGroup><PackageReference Include="A" Version="1.0" /></ItemGroup>
    </Project>`, 'sample.csproj');
  assert.equal(graph.nodes[0].version, '>=1.0');
  assert.throws(() => parseInput(`
    <msb:Project xmlns:msb="http://schemas.microsoft.com/developer/msbuild/2003">
      <msb:ItemGroup><msb:PackageReference Include="A" Version="1.0" /></msb:ItemGroup>
    </msb:Project>`, 'sample.csproj'), /single Project XML root/);
});

test('malformed XML, unexpected structure, and empty manifests are rejected', () => {
  for (const source of [
    '', '   ', '<!-- no root -->', '<?xml version="1.0"?>',
    '<Project><ItemGroup></Project>', '<Project', '<Project/><Project/>',
    '<packages/>', '<Project>unexpected text</Project>',
    csproj('<PackageReference Include="A" Version="1" />'),
    csproj('<Wrapper><ItemGroup><PackageReference Include="A" Version="1" /></ItemGroup></Wrapper>'),
    references('<PackageReference Include="A"><Version><Other>1</Other></Version></PackageReference>'),
    references('<PackageReference Include="A" Version="1" Version="2" />'),
    references('<PackageReference Include="bad name" Version="1" />'),
    csproj('<PropertyGroup><PackageReference Include="A" /></PropertyGroup>'),
    csproj('<ItemGroup><ItemGroup Condition="true"><PackageReference Include="A" Version="[1]" /></ItemGroup></ItemGroup>'),
  ]) assert.throws(() => parseInput(source, 'sample.csproj'));
  for (const source of ['<Project/>', csproj('<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>')]) {
    assert.throws(() => parseInput(source, 'sample.csproj'), /at least one/);
  }
  for (const source of [
    '<packages/>', '<Project/>', '<packages><package id="A" /></packages>',
    '<packages><package version="1" /></packages>',
    '<packages><package id="A" version="1"><version>2</version></package></packages>',
    '<packages><wrapper><package id="A" version="1" /></wrapper></packages>',
    '<packages><package id="A" version="1" condition="true" /></packages>',
  ]) assert.throws(() => parseInput(source, 'packages.config'));
});

test('XML entities, DTDs, and external processing instructions cannot be evaluated', () => {
  for (const source of [
    '<!DOCTYPE Project SYSTEM "https://example.com/evil.dtd"><Project/>',
    '<!DOCTYPE Project [<!ENTITY secret SYSTEM "file:///etc/passwd">]><Project>&secret;</Project>',
    '<!ENTITY a "expanded"><Project/>',
    '<?xml-stylesheet href="https://example.com/evil.xsl"?><Project/>',
    '<?external target="anything"?><Project/>',
    references('<PackageReference Include="A" Version="&unknown;" />'),
  ]) assert.throws(() => parseInput(source, 'sample.csproj'), /DOCTYPE|ENTITY|processing instructions|entity reference/);
  const graph = parseProject('<PackageReference Include="A" Version="&#49;.0" />');
  assert.equal(graph.nodes[0].version, '>=1.0');
});

test('XML comments and CDATA permit literal ampersands and inert declaration-looking text', () => {
  const literal = 'runtime & logging &unknown; <!DOCTYPE Project SYSTEM "https://example.com/evil.dtd"> <!ENTITY secret SYSTEM "file:///etc/passwd"> <?external target="anything"?>';
  for (const content of [
    '<!-- runtime & logging -->',
    `<PropertyGroup><Description><![CDATA[A & B]]></Description></PropertyGroup>`,
    `<!-- ${literal} -->`,
    `<PropertyGroup><Description><![CDATA[${literal}]]></Description></PropertyGroup>`,
  ]) {
    const graph = parseInput(csproj(`${content}<ItemGroup><PackageReference Include="A" Version="[1.0]" /></ItemGroup>`), 'sample.csproj');
    assert.deepEqual(graph.nodes.map(node => [node.name, node.version]), [['a', '1.0']]);
  }
  const graph = parseInput(`<packages><!-- ${literal} --><package id="A" version="1.0" /></packages>`, 'packages.config');
  assert.equal(graph.nodes[0].version, '1.0');
  for (const source of [
    `<!-- harmless & text --><?external target="anything"?>${references('<PackageReference Include="A" Version="[1]" />')}`,
    `<!-- harmless & text --><!DOCTYPE Project SYSTEM "https://example.com/evil.dtd"><Project/>`,
    csproj('<PropertyGroup><Description><![CDATA[A & B]]>&unknown;</Description></PropertyGroup>'),
    csproj('<PropertyGroup><Description><![CDATA[A & B]]></Description></PropertyGroup><ItemGroup><PackageReference Include="A" Version="&unknown;" /></ItemGroup>'),
  ]) assert.throws(() => parseInput(source, 'sample.csproj'), /DOCTYPE|processing instructions|entity reference/);
  for (const source of [
    '<Project><!-- unfinished & text</Project>',
    '<Project><PropertyGroup><Description><![CDATA[unfinished & text</Description></PropertyGroup></Project>',
  ]) assert.throws(() => parseInput(source, 'sample.csproj'), /Invalid XML/);
});

test('conditional packages, groups, properties, versions, and overrides are rejected rather than scanned as exact', () => {
  for (const source of [
    '<Project Condition="true"><ItemGroup><PackageReference Include="A" Version="1" /></ItemGroup></Project>',
    csproj('<ItemGroup Condition="true"><PackageReference Include="A" Version="1" /></ItemGroup>'),
    csproj('<PropertyGroup Condition="true"><Version>1</Version></PropertyGroup><ItemGroup><PackageReference Include="A" Version="[1]" /></ItemGroup>'),
    csproj('<PropertyGroup><Version Condition="true">1</Version></PropertyGroup><ItemGroup><PackageReference Include="A" Version="[1]" /></ItemGroup>'),
    references('<PackageReference Include="A" Version="[1]" Condition="true" />'),
    references('<PackageReference Include="A"><Version Condition="true">[1]</Version></PackageReference>'),
    references('<PackageReference Include="A"><VersionOverride Condition="true">[1]</VersionOverride></PackageReference>'),
    references('<PackageReference Include="A" Version="[1]"><PrivateAssets Condition="true">all</PrivateAssets></PackageReference>'),
  ]) assert.throws(() => parseInput(source, 'sample.csproj'), /Conditional/);
});

test('imports, central versions, Update, and unsupported MSBuild evaluation are rejected', () => {
  for (const source of [
    csproj('<Import Project="versions.props" />'),
    csproj('<ImportGroup><Import Project="versions.props" /></ImportGroup>'),
    csproj('<Choose><When Condition="true"><ItemGroup><PackageReference Include="A" Version="1" /></ItemGroup></When></Choose>'),
    csproj('<Target Name="Build"><ItemGroup><PackageReference Include="A" Version="1" /></ItemGroup></Target>'),
    csproj('<PropertyGroup><ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally></PropertyGroup>'),
    csproj('<PropertyGroup><PackageVersion>1</PackageVersion></PropertyGroup>'),
    references('<PackageVersion Include="A" Version="1" />'),
    references('<PackageReference Update="A" Version="1" />'),
    references('<PackageReference Include="A" Update="A" Version="1" />'),
    references('<PackageReference Include="A"><UnknownMetadata>1</UnknownMetadata></PackageReference>'),
  ]) assert.throws(() => parseInput(source, 'sample.csproj'), /Unsupported/);
});

test('project references recommend explicit YAML service nodes rather than becoming packages', () => {
  assert.throws(() => parseInput(references('<ProjectReference Include="../Other.csproj" />'), 'sample.csproj'), /ProjectReference.*explicit YAML service nodes/);
});

test('conflicting and duplicate NuGet manifest package entries are never silently merged', () => {
  for (const source of [
    '<PackageReference Include="A" Version="1" /><PackageReference Include="a" Version="2" />',
    '<PackageReference Include="A" Version="1" /><PackageReference Include="A" Version="1" />',
    '<PackageReference Include="A" Version="1"><Version>2</Version></PackageReference>',
    '<PackageReference Include="A"><Version>1</Version><Version>2</Version></PackageReference>',
    '<PackageReference Include="A" VersionOverride="1"><VersionOverride>2</VersionOverride></PackageReference>',
  ]) assert.throws(() => parseProject(source), /Duplicate/);
  assert.throws(() => parseInput('<packages><package id="A" version="1" /><package id="a" version="2" /></packages>', 'packages.config'), /Duplicate/);
});
