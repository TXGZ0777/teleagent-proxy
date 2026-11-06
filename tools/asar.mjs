// Minimal asar reader: list / extract entries without @electron/asar.
// Usage:
//   node asar.mjs list  <app.asar> [regex]
//   node asar.mjs cat   <app.asar> <innerPath> <outFile>
import fs from 'node:fs';
process.noAsar = true; // this node may be Electron-hosted; bypass its asar fs shim

function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // pickle: [u32 4][u32 size][u32 jsonLen][json...]
  const jsonLen = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonLen);
  fs.readSync(fd, jsonBuf, 0, jsonLen, 16);
  fs.closeSync(fd);
  const baseOffset = 16 + jsonLen;
  return { header: JSON.parse(jsonBuf.toString('utf8')), baseOffset };
}

function walk(node, prefix, out) {
  for (const [name, meta] of Object.entries(node.files ?? {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (meta.files) walk(meta, full, out);
    else if (meta.link) out.push({ path: full, link: meta.link });
    else out.push({ path: full, offset: Number(meta.offset), size: meta.size });
  }
}

const [cmd, asarPath, ...rest] = process.argv.slice(2);
const { header, baseOffset } = readHeader(asarPath);
const entries = [];
walk(header, '', entries);

if (cmd === 'list') {
  const re = rest[0] ? new RegExp(rest[0], 'i') : null;
  const hit = entries.filter((e) => (re ? re.test(e.path) : true));
  hit.sort((a, b) => b.size - a.size);
  for (const e of hit.slice(0, 400)) {
    console.log(`${String(e.size).padStart(10)}  ${e.path}`);
  }
  console.log(`# total ${entries.length}, matched ${hit.length}`);
} else if (cmd === 'cat') {
  const inner = rest[0].replace(/\\/g, '/').replace(/^\//, '');
  const outFile = rest[1];
  const e = entries.find((x) => x.path === inner);
  if (!e) throw new Error(`not found: ${inner}`);
  const fd = fs.openSync(asarPath, 'r');
  const buf = Buffer.alloc(e.size);
  fs.readSync(fd, buf, 0, e.size, baseOffset + e.offset);
  fs.closeSync(fd);
  fs.writeFileSync(outFile, buf);
  console.log(`wrote ${e.size} bytes -> ${outFile}`);
} else {
  console.error('usage: list|cat');
  process.exit(1);
}
