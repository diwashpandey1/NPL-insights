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

export const supportedSeasons = ['2024/25', '2025/26'];
