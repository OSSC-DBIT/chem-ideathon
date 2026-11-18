// Fails when a setting exists in the code but is missing from the places people look for it.
// Run by `npm test`. This is what keeps .env.example, docker-compose.yml and the docs from going stale.
//
// Every environment variable the app reads must be:
//   1. passed into the container by docker-compose.yml (or set by the Dockerfile),
//   2. listed in .env.example, when it is meant to be set by the person running the site,
//   3. described in docs/configuration.md.

import fs from 'node:fs';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// Set by the Dockerfile or by docker-compose.yml itself; nobody puts these in .env.
const FIXED_BY_DOCKER = new Set(['NODE_ENV', 'PORT', 'DATA_DIR', 'TRUST_PROXY', 'CLAMAV_HOST']);
// Has a sensible default and never needs setting under Docker.
const DEFAULT_IS_ENOUGH = new Set(['CLAMAV_PORT']);
// Development and test switches. Documented, but deliberately kept out of Docker and .env.example.
const DEVELOPMENT_ONLY = new Set(['CAPTCHA_TEST_CODE', 'MAIL_TEST_FILE']);
// Read by docker-compose.yml only (they shape the containers, the app never sees them).
const COMPOSE_ONLY = ['HOST_PORT', 'HOST_BIND', 'SMTP_ON_THIS_HOST'];

const sources = ['server.js', ...fs.readdirSync(new URL('../src', import.meta.url)).map((f) => `src/${f}`)];
const used = new Set();
for (const file of sources) {
  const text = read(file);
  for (const match of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) used.add(match[1]);
  for (const match of text.matchAll(/\bmb\('([A-Z][A-Z0-9_]*)'/g)) used.add(match[1]); // size limits in uploads.js
}

const compose = read('docker-compose.yml');
const example = read('.env.example');
const docs = read('docs/configuration.md');
const dockerfile = read('Dockerfile');
const problems = [];

const mentions = (text, name) => new RegExp(`(^|[^A-Z0-9_])${name}([^A-Z0-9_]|$)`).test(text);
const inExample = (name) => new RegExp(`^#?\\s*${name}=`, 'm').test(example);

for (const name of [...used].sort()) {
  const optional = DEVELOPMENT_ONLY.has(name) || DEFAULT_IS_ENOUGH.has(name);
  const inDocker = new RegExp(`^\\s+${name}:`, 'm').test(compose) || new RegExp(`(^|\\s)${name}=`, 'm').test(dockerfile);
  if (!optional && !inDocker) problems.push(`${name} is read by the code but docker-compose.yml does not pass it to the app.`);
  if (!optional && !FIXED_BY_DOCKER.has(name) && !inExample(name)) problems.push(`${name} can be set by the operator but is missing from .env.example.`);
  if (!mentions(docs, name)) problems.push(`${name} is not described in docs/configuration.md.`);
}

for (const name of COMPOSE_ONLY) {
  if (!compose.includes('${' + name)) problems.push(`${name} is expected in docker-compose.yml but is not used there.`);
  if (!inExample(name)) problems.push(`${name} is missing from .env.example.`);
  if (!mentions(docs, name)) problems.push(`${name} is not described in docs/configuration.md.`);
}

// The other direction: nothing in .env.example that nothing reads.
for (const match of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) {
  const name = match[1];
  if (!used.has(name) && !COMPOSE_ONLY.includes(name)) problems.push(`${name} is in .env.example but nothing reads it.`);
}

if (problems.length) {
  console.log(problems.map((p) => `FAIL ${p}`).join('\n'));
  console.log(`\n0 passed, ${problems.length} failed`);
  process.exit(1);
}
console.log(`ok   ${used.size + COMPOSE_ONLY.length} settings are consistent across the code, docker-compose.yml, .env.example and the docs`);
console.log('\n1 passed, 0 failed');
