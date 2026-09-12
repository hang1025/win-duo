'use strict';

/**
 * Explains a saved recon session: one block per cycle, one line per phase.
 *
 * What "tracks the lid" looks like on paper: during `close` the value walks one
 * way, during `reopen` it walks back, and the deltas in between are far larger
 * than the wobble during the two holds.
 *
 *   node tools/lid-recon/inspect.js [path-to.json]
 */
const fs = require('fs');
const path = require('path');
const { analyze } = require('./analyze');

const DIR = path.join(__dirname, '..', '..', 'lid-recon-output');

function latest() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) throw new Error(`no .json report in ${DIR}`);
  files.sort((a, b) => fs.statSync(path.join(DIR, b)).mtimeMs - fs.statSync(path.join(DIR, a)).mtimeMs);
  return path.join(DIR, files[0]);
}

const PHASES = ['open', 'close', 'shut', 'reopen'];

function describe(values) {
  if (!values.length) return null;
  const first = values[0];
  const last = values[values.length - 1];
  let up = 0;
  let down = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta > 0.05) up += 1;
    else if (delta < -0.05) down += 1;
  }
  return {
    n: values.length,
    first,
    last,
    min: Math.min(...values),
    max: Math.max(...values),
    up,
    down,
  };
}

function main() {
  const file = process.argv[2] || latest();
  const session = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(`file   : ${path.basename(file)}`);
  console.log(`window : ${session.startedAt} -> ${session.endedAt}`);
  console.log(`cycles : ${session.cycles.length}`);

  for (const [name, samples] of Object.entries(session.series)) {
    if (!samples.length) continue;
    console.log(`\n================ ${name} (${samples.length} samples) ================`);

    for (const [index, cycle] of session.cycles.entries()) {
      const p = cycle.phases || {};
      console.log(`--- cycle ${index + 1} ---`);
      for (const phase of PHASES) {
        const from = p[`${phase}From`];
        const to = p[`${phase}To`];
        if (from === undefined || to === undefined) {
          console.log(`  ${phase.padEnd(7)} (phase never completed)`);
          continue;
        }
        const values = samples.filter((s) => s.t >= from && s.t < to).map((s) => s.v);
        const d = describe(values);
        if (!d) {
          console.log(`  ${phase.padEnd(7)} (no samples)`);
          continue;
        }
        const pad = (v) => v.toFixed(1).padStart(7);
        console.log(
          `  ${phase.padEnd(7)} n=${String(d.n).padStart(3)}`
          + `  ${pad(d.first)} -> ${pad(d.last)}`
          + `   min ${pad(d.min)}  max ${pad(d.max)}  travel ${pad(d.max - d.min)}`
          + `   steps up ${String(d.up).padStart(3)} / down ${String(d.down).padStart(3)}`,
        );
      }
    }
  }

  console.log('\n================ re-scored with the current rules ================');
  const report = analyze({ series: session.series, cycles: session.cycles });
  for (const result of Object.values(report).sort((a, b) => (b.score || 0) - (a.score || 0))) {
    console.log(
      `${result.name.padEnd(7)} ${String(result.verdict).padEnd(22)}`
      + ` snr ${Number.isFinite(result.snr) ? result.snr.toFixed(1).padStart(7) : '    n/a'}`
      + `   hold drift ${Number.isFinite(result.holdDriftRatio) ? (result.holdDriftRatio * 100).toFixed(0).padStart(4) : ' n/a'}%`
      + `   monotone ${result.monotone || 0}/${result.cycles || 0}`
      + `   reversing ${result.reversing || 0}/${result.cycles || 0}`,
    );
  }
}

main();
