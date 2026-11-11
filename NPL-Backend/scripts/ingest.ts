import fs from 'node:fs/promises';
import path from 'node:path';

import {
  dryRunIngestion,
  generateIngestionReport,
  inspectSourceFiles,
  runAllIngestion,
  runSeasonIngestion,
  validateSourceData,
} from '../src/ingestion/services/ingestion-service.js';

const projectRoot = path.resolve(process.cwd());
const outputDir = path.join(projectRoot, '.ingestion');

async function ensureOutputDir(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });
}

async function saveReport(name: string, payload: unknown): Promise<void> {
  await ensureOutputDir();
  await fs.writeFile(path.join(outputDir, `${name}.json`), JSON.stringify(payload, null, 2), 'utf8');
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'inspect': {
      const inspection = await inspectSourceFiles();
      console.log(JSON.stringify(inspection, null, 2));
      break;
    }
    case 'validate': {
      const report = await validateSourceData(false);
      console.log(JSON.stringify(report, null, 2));
      await saveReport('ingestion-validation', report);
      break;
    }
    case 'dry-run': {
      const report = await dryRunIngestion();
      console.log(JSON.stringify(report, null, 2));
      await saveReport('ingestion-dry-run', report);
      break;
    }
    case 'season': {
      const season = args[0] ?? '2024/25';
      const report = await runSeasonIngestion(season);
      console.log(JSON.stringify(report, null, 2));
      await saveReport(`ingestion-${season.replace(/\//g, '-')}`, report);
      break;
    }
    case 'all': {
      const report = await runAllIngestion();
      console.log(JSON.stringify(report, null, 2));
      await saveReport('ingestion-all', report);
      break;
    }
    case 'reprocess': {
      const file = args[0] ?? path.join(process.cwd(), '..', 'NPL - Stats Processing', 'data', 'processed', 'combined', 'merged_npl_2024_2025.csv');
      const report = await validateSourceData(true);
      const hash = await fs.readFile(file, 'utf8');
      console.log(JSON.stringify({ file, sha256: (await import('node:crypto')).createHash('sha256').update(hash).digest('hex'), report }, null, 2));
      await saveReport('ingestion-reprocess', { file, sha256: (await import('node:crypto')).createHash('sha256').update(hash).digest('hex'), report });
      break;
    }
    case 'report': {
      const report = await generateIngestionReport();
      console.log(JSON.stringify(report, null, 2));
      await saveReport('ingestion-report', report);
      break;
    }
    case 'help':
    case undefined:
    default: {
      console.log('Usage: npm run ingest:inspect | ingest:validate | ingest:dry-run | ingest:season -- <season> | ingest:all | ingest:reprocess -- <source-file> | ingest:report');
      break;
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
