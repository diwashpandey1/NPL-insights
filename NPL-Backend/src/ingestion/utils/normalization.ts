import crypto from 'node:crypto';
import fs from 'node:fs/promises';

import { knownTeamAliases } from '../config/ingestion.config.js';

export function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeAlias(value: unknown): string {
  return normalizeText(value).toLowerCase().replace(/\s+/g, ' ');
}

export function normalizeSeasonValue(value: unknown): string {
  const text = normalizeText(value).replace(/[^0-9/\-]/g, '');
  if (!text) {
    return '';
  }

  if (text === '2024/25' || text === '2024-25' || text === '202425') {
    return '2024/25';
  }
  if (text === '2025/26' || text === '2025-26' || text === '202526') {
    return '2025/26';
  }
  if (text === '2024') {
    return '2024';
  }
  if (text === '2025') {
    return '2025';
  }

  return text;
}

export function canonicalizeTeamName(value: unknown): string {
  const raw = normalizeText(value);
  if (!raw) {
    return '';
  }

  const normalized = normalizeAlias(raw);
  const directMatch = knownTeamAliases[normalized];
  return directMatch ?? raw;
}

export function canonicalizePlayerName(value: unknown): string {
  const raw = normalizeText(value);
  return raw;
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

export function splitFielders(value: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;,|/]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
