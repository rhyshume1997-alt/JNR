'use strict';
// Checks the live Buffer GraphQL schema against what api/_lib/buffer.js sends, WITHOUT creating or changing anything.
// Read-only: it runs introspection queries and (optionally) lists channels so you can find the channel id.
//   BUFFER_API_TOKEN=... npm run buffer:check
//   BUFFER_API_TOKEN=... npm run buffer:check -- --channels <organizationId>
const { gql, QUERIES, listChannels } = require('../api/_lib/buffer');

const TYPE = 'query T($n: String!) { __type(name: $n) { name kind fields { name } inputFields { name type { name kind ofType { name kind } } } enumValues { name } possibleTypes { name } } }';
const names = (t) => (t ? (t.fields || t.inputFields || t.enumValues || t.possibleTypes || []).map((f) => f.name) : []);

async function main() {
  let failed = 0;
  const need = async (typeName, wanted) => {
    const data = await gql(TYPE, { n: typeName });
    const have = names(data.__type);
    if (!data.__type) { console.log('MISSING type ' + typeName); failed++; return; }
    const missing = wanted.filter((w) => !have.includes(w));
    console.log((missing.length ? 'DIFFERS ' : 'ok      ') + typeName + (missing.length ? '  missing: ' + missing.join(', ') + '  (has: ' + have.join(', ') + ')' : ''));
    if (missing.length) failed++;
  };
  await need('CreatePostInput', ['channelId', 'text', 'saveToDraft', 'assets', 'schedulingType', 'mode', 'dueAt']);
  await need('Post', ['id', 'text', 'status', 'dueAt', 'sentAt', 'channelId', 'assets']);
  await need('Query', ['post', 'channels']);
  await need('SchedulingType', ['automatic']);
  const asset = await gql(TYPE, { n: 'Asset' });
  if (asset.__type) console.log('info    Asset (' + asset.__type.kind + ') fields: ' + names(asset.__type).join(', '));
  const i = process.argv.indexOf('--channels');
  if (i > 0) {
    const ch = await listChannels(process.argv[i + 1]);
    ch.forEach((c) => console.log('channel ' + c.id + '  ' + c.service + '  ' + c.name + (c.isDisconnected ? '  (disconnected)' : '')));
  }
  console.log(failed ? '\n' + failed + ' difference(s). Fix QUERIES / draftInput in api/_lib/buffer.js, then run this again.' : '\nSchema matches what this site sends.');
  console.log('Queries in use:\n' + Object.keys(QUERIES).map((k) => '  ' + k).join('\n'));
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
