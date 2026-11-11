import fs from 'node:fs/promises';
import path from 'node:path';

export function parseCsvRecords(contents: string): string[][] {
  return parseCsvRecordsWithLineNumbers(contents).map((record) => record.cells);
}

export interface CsvRecord {
  rowNumber: number;
  cells: string[];
}

export function parseCsvRecordsWithLineNumbers(contents: string): CsvRecord[] {
  const rows: CsvRecord[] = [];
  let currentRow: string[] = [];
  let currentValue = '';
  let isInsideQuotes = false;
  let lineNumber = 1;
  let rowStartLine = 1;

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
        rows.push({ rowNumber: rowStartLine, cells: currentRow });
      }
      currentRow = [];
      currentValue = '';
      lineNumber += 1;
      rowStartLine = lineNumber;
      continue;
    }

    if ((ch === '\n' || ch === '\r') && isInsideQuotes) {
      if (ch === '\r' && next === '\n') {
        i += 1;
      }
      currentValue += '\n';
      lineNumber += 1;
      continue;
    }

    currentValue += ch;
  }

  if (currentValue.length > 0 || currentRow.length > 0) {
    currentRow.push(currentValue);
    if (currentRow.some((cell) => cell !== '')) {
      rows.push({ rowNumber: rowStartLine, cells: currentRow });
    }
  }

  if (isInsideQuotes) {
    throw new Error('Malformed CSV: unterminated quoted field.');
  }

  return rows;
}

export async function readCsvFileWithLineNumbers<T extends Record<string, string>>(filePath: string): Promise<Array<{ rowNumber: number; record: T }>> {
  const contents = await fs.readFile(filePath, 'utf8');
  const rows = parseCsvRecordsWithLineNumbers(contents);

  if (rows.length === 0) {
    return [];
  }

  const [header, ...body] = rows;
  if (!header) {
    return [];
  }

  const mappedHeader = header.cells.map((value, index) => (index === 0 ? value.replace(/^\uFEFF/, '') : value).trim());

  return body.map(({ rowNumber, cells }) => {
    if (cells.length !== mappedHeader.length) {
      throw new Error(`Malformed CSV at physical row ${rowNumber}: expected ${mappedHeader.length} columns, received ${cells.length}.`);
    }
    const record = Object.fromEntries(mappedHeader.map((column, index) => [column, cells[index] ?? ''])) as T;
    return {
      rowNumber,
      record: Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key.trim(), String(value).trim()]),
      ) as T,
    };
  });
}

export async function readCsvFile<T extends Record<string, string>>(filePath: string): Promise<T[]> {
  return (await readCsvFileWithLineNumbers<T>(filePath)).map(({ record }) => record);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    return JSON.parse(contents) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export function hasCsvExtension(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.csv';
}
