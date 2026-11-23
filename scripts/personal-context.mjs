// Fixed native strip-types bridge. No provider, filesystem snapshot or environment data.
import { createHash } from 'node:crypto';
import { buildPersonalContext } from '../src/modules/personalContextCore.ts';
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) process.exit(1);
let bytes = 0;
const chunks = [];
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 262144) process.exit(1);
  chunks.push(chunk);
}
try {
  const snapshot = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(snapshot.performedSets) || snapshot.performedSets.length > 1024) process.exit(1);
  const context = buildPersonalContext(snapshot);
  context.revision = createHash('sha256').update(context.revision).digest('hex');
  const result = JSON.stringify(context);
  if (Buffer.byteLength(result) > 65536) process.exit(1);
  process.stdout.write(result);
} catch { process.exit(1); }
