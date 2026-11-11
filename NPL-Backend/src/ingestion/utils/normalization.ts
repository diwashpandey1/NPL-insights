import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { knownTeamAliases } from '../config/ingestion.config.js';

export function normalizeText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

export function normalizeAlias(value: unknown): string {
  return normalizeText(value).toLowerCase().replace(/\s+/g, ' ');
}

export function canonicalizeTeamName(value: unknown): string {
  const normalized = normalizeAlias(value);

  if (!normalized) {
    return '';
  }

  const directMatch = knownTeamAliases[normalized];
  if (directMatch) {
    return directMatch;
  }

  return normalizeText(value);
}

export function parseInteger(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return null;
}

export async function computeFileSha256(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function formatIssueCode(prefix: string, suffix: string): string {
  return `${prefix}:${suffix}`;
}
