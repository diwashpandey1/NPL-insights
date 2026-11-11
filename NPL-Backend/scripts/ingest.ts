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

async function parseSeasonArg(args: string[]): Promise<string> {
  const value = args[0] ?? '2024/25';
  if (value.startsWith('--')) {
    return args[1] ?? '2024/25';
  }
  return value;
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
      const season = await parseSeasonArg(args);
      const report = await validateSourceData(season, { dryRun: true });
      console.log(JSON.stringify(report, null, 2));
      await saveReport('ingestion-validation', report);
      break;
    }
    case 'dry-run': {
      const season = await parseSeasonArg(args);
      const report = await dryRunIngestion(season);
      console.log(JSON.stringify(report, null, 2));
      await saveReport('ingestion-dry-run', report);
      break;
    }
    case 'season': {
      const season = await parseSeasonArg(args);
      const report = await runSeasonIngestion(season, { dryRun: false });
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
    case 'report': {
      const season = await parseSeasonArg(args);
      const report = await generateIngestionReport(season);
      console.log(JSON.stringify(report, null, 2));
      await saveReport('ingestion-report', report);
      break;
    }
    case 'help':
    case undefined:
    default: {
      console.log('Usage: npm run ingest:inspect | npm run ingest:validate -- 2024/25 | npm run ingest:dry-run -- 2024/25 | npm run ingest:season -- 2024/25 | npm run ingest:all | npm run ingest:report -- 2024/25');
      break;
    }
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
