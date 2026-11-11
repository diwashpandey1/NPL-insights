import fs from 'node:fs/promises';
import path from 'node:path';

export function parseCsvRecords(contents: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = '';
  let isInsideQuotes = false;

  for (let i = 0; i < contents.length; i += 1) {
    const ch = contents[i];
    const next = contents[i + 1];

    if (ch === '"') {
      if (isInsideQuotes && next === '"') {
        currentValue += '"';
        i += 1;
      } else {
        isInsideQuotes = !isInsideQuotes;
      }
      continue;
    }

    if (ch === ',' && !isInsideQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !isInsideQuotes) {
      if (ch === '\r' && next === '\n') {
        i += 1;
      }

      currentRow.push(currentValue);
      if (currentRow.some((cell) => cell !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentValue = '';
      continue;
    }

    currentValue += ch;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    if (currentRow.some((cell) => cell !== '')) {
      rows.push(currentRow);
    }
  }

  return rows;
}

export async function readCsvFile<T extends Record<string, string>>(filePath: string): Promise<T[]> {
  const contents = await fs.readFile(filePath, 'utf8');
  const rows = parseCsvRecords(contents);

  if (rows.length === 0) {
    return [];
  }

  const [header, ...body] = rows;
  if (!header) {
    return [];
  }

  const mappedHeader = header.map((value) => value.trim());

  return body.map((row) => {
    const record = Object.fromEntries(mappedHeader.map((column, index) => [column, row[index] ?? ''])) as T;
    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key.trim(), String(value).trim()]),
    ) as T;
  });
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

export function hasCsvExtension(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.csv';
}
