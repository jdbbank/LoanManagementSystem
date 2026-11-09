#!/usr/bin/env node
// Generates the mechanical part of the pre-production evidence pack: TEST-REPORT-CASES.md,
// one row per E2E case, straight from scripts/test/results.json.
// The analysis (verdict, findings, severity, reproduction) lives in the hand-written TEST-REPORT.md,
// which links here — rerunning this script must never overwrite that prose.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const results = JSON.parse(fs.readFileSync(path.join(HERE, 'results.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'seed-manifest.json'), 'utf8'));

const cell = (v) => String(v ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const ORDER = Object.keys(results.summary.byCat);

const lines = [];
lines.push('# TEST-REPORT-CASES — ตารางทุกเคส (ไฟล์นี้ generate อัตโนมัติ อย่าแก้ด้วยมือ)');
lines.push('');
lines.push(`- แหล่งข้อมูล: \`scripts/test/results.json\` (run เมื่อ ${results.generatedAt}) · backend \`${results.base}\``);
lines.push(`- สร้างใหม่ด้วย: \`npm run test:e2e:report\` หรือ \`node scripts/test/report.mjs\``);
lines.push(`- บทวิเคราะห์/บั๊ก/severity อยู่ใน [TEST-REPORT.md](TEST-REPORT.md) — ตารางนี้อ้าง reference จากคอลัมน์ ผล`);
lines.push(`- ข้อมูลในฐานข้อมูลตอนรัน: ชุดจำลอง deterministic seed ${manifest.seed} (\`scripts/test/seed-manifest.json\` สร้างเมื่อ ${manifest.generatedAt})`);
lines.push('');
lines.push('| หมวด (suite) | เคส | ผ่าน | ไม่ผ่าน |');
lines.push('|---|---:|---:|---:|');
for (const cat of ORDER) {
  const v = results.summary.byCat[cat];
  lines.push(`| ${cat} | ${v.pass + v.fail} | ${v.pass} | ${v.fail ? `**${v.fail}**` : 0} |`);
}
const t = results.summary.total;
const f = results.cases.filter((c) => !c.pass).length;
lines.push(`| **รวม** | **${t}** | **${t - f}** | **${f}** |`);
lines.push('');
lines.push('## ทุกเคส เรียงตาม ID');
lines.push('');
lines.push('| ID | หมวด | สิ่งที่ทดสอบ | input | ผล |');
lines.push('|---|---|---|---|---|');
for (const c of results.cases) {
  const verdict = c.pass ? 'ผ่าน' : `**ไม่ผ่าน**${/F-[A-Z]+-\d+/.test(c.note ?? '') ? ` (${c.note.match(/F-[A-Z]+-\d+/)[0]})` : ''}`;
  lines.push(`| ${c.id} | ${c.category} | ${cell(c.name)} | ${cell(c.input).slice(0, 160)} | ${verdict} |`);
}
lines.push('');

const outFile = path.join(ROOT, 'TEST-REPORT-CASES.md');
fs.writeFileSync(outFile, lines.join('\n'));
console.log(`[report] wrote ${path.relative(ROOT, outFile)}: ${t} cases, ${f} failed, ${lines.length} lines`);
