import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const projectRoot = path.resolve(__dirname, '..', '..', '..');
export const processingRoot = path.resolve(projectRoot, '..', 'NPL - Stats Processing');

export const defaultDataPaths = {
  ballByBallCsv: path.join(processingRoot, 'data', 'processed', 'combined', 'merged_npl_2024_2025.csv'),
  matchCsv: path.join(processingRoot, 'data', 'raw', 'source', 'csv_data', 'NPL-matches.csv'),
  manifest: path.join(processingRoot, 'data', 'raw', 'source_manifest.json'),
  rawCricsheetDirectory: path.join(processingRoot, 'data', 'raw', 'cricsheet', 'npl_json'),
};

export const supportedSeasonSelections = ['2024', '2024/25', '2025', '2025/26', 'all'];

export const sourceSeasonMappings: Record<string, { sourceYear: string; canonicalSeasonKey: string; matchIdOffset: number }> = {
  '2024': { sourceYear: '2024', canonicalSeasonKey: '2024/25', matchIdOffset: 0 },
  '2025': { sourceYear: '2025', canonicalSeasonKey: '2025/26', matchIdOffset: 32 },
};

export const knownTeamAliases: Record<string, string> = {
  gorkhas: 'Kathmandu Gorkhas',
  gurkhas: 'Kathmandu Gorkhas',
  'kathmandu gorkhas': 'Kathmandu Gorkhas',
  'kathmandu gurkhas': 'Kathmandu Gorkhas',
  'janakpur bolts': 'Janakpur Bolts',
  'janakpur boltes': 'Janakpur Bolts',
  'biratnagar kings': 'Biratnagar Kings',
  'chitwan rhinos': 'Chitwan Rhinos',
  'karnali yaks': 'Karnali Yaks',
  'sudurpaschim royals': 'Sudurpaschim Royals',
  'lumbini lions': 'Lumbini Lions',
  'pokhara avengers': 'Pokhara Avengers',
};

export const canonicalTeamNames = new Set<string>([
  'Kathmandu Gorkhas',
  'Janakpur Bolts',
  'Biratnagar Kings',
  'Chitwan Rhinos',
  'Karnali Yaks',
  'Sudurpaschim Royals',
  'Lumbini Lions',
  'Pokhara Avengers',
]);

export function seasonSelectionToValues(seasonSelection: string): Set<string> {
  const target = seasonSelection.trim().toLowerCase().replace(/-/g, '/');
  if (target === 'all') {
    return new Set(Object.keys(sourceSeasonMappings));
  }
  const sourceYear = target === '2024/25' ? '2024' : target === '2025/26' ? '2025' : target;
  if (!sourceSeasonMappings[sourceYear]) {
    throw new Error(`Unsupported season selection: ${seasonSelection}`);
  }
  return new Set([sourceYear]);
}

export function canonicalSeasonForSourceYear(sourceYear: string): { seasonKey: string; label: string } {
  const mapping = sourceSeasonMappings[sourceYear];
  if (!mapping) {
    throw new Error(`Unsupported source season year: ${sourceYear}`);
  }
  return { seasonKey: mapping.canonicalSeasonKey, label: mapping.canonicalSeasonKey };
}

export function logicalSourcePath(filePath: string): string {
  return path.relative(processingRoot, filePath).split(path.sep).join('/');
}
