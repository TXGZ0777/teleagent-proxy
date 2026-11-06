// Extract a text window around the first occurrence of a needle inside a (binary) file.
// Usage: node slice.mjs <file> <needle> <beforeBytes> <afterBytes> <outFile>
import fs from 'node:fs';
process.noAsar = true;

const [file, needle, before, after, out] = process.argv.slice(2);
const beforeN = Number(before) || 8000;
const afterN = Number(after) || 8000;

const fd = fs.openSync(file, 'r');
const size = fs.fstatSync(fd).size;
const CHUNK = 8 * 1024 * 1024;
const needleBuf = Buffer.from(needle, 'utf8');
let pos = 0;
let carry = Buffer.alloc(0);
let found = -1;
while (pos < size) {
  const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
  fs.readSync(fd, buf, 0, buf.length, pos);
  const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
  const idx = hay.indexOf(needleBuf);
  if (idx !== -1) {
    found = pos - carry.length + idx;
    break;
  }
  carry = hay.subarray(Math.max(0, hay.length - needleBuf.length));
  pos += buf.length;
}
if (found === -1) {
  console.error('needle not found');
  process.exit(2);
}
const start = Math.max(0, found - beforeN);
const end = Math.min(size, found + needleBuf.length + afterN);
const outBuf = Buffer.alloc(end - start);
fs.readSync(fd, outBuf, 0, outBuf.length, start);
fs.closeSync(fd);
fs.writeFileSync(out, outBuf.toString('utf8'));
console.log(`offset=${found} window=[${start},${end}) -> ${out}`);
