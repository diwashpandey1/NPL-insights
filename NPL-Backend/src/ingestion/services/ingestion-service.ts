import { defaultDataPaths, logicalSourcePath, sourceSeasonMappings, seasonSelectionToValues, canonicalSeasonForSourceYear } from '../config/ingestion.config.js';
import { readDeliverySource, readMatchSource, filterSourceRowsBySeason } from '../parsers/delivery-parser.js';
import { buildReport, validateDeliveryRecord, validateMatchRecord, validateSeasonSelection } from '../validators/data-validator.js';
import { canonicalizeTeamName, computeFileSha256, normalizeAlias, splitFielders } from '../utils/normalization.js';
import { SupabaseIngestionRepository, type DeliveryPersistenceInput, type IngestionRepository } from '../repositories/supabase-repository.js';
import type { DeliveryRecord, IngestionIssue, IngestionReport, MatchRecord, PersistenceAction, PersistenceOutcome } from '../types/index.js';

const DELIVERY_BATCH_SIZE = 250;
const MATCH_SOURCE_SYSTEM = 'npl-match-feed';
const DELIVERY_SOURCE_SYSTEM = 'npl-master';
const INGESTION_PIPELINE_VERSION = 'phase-2-final-integrity-audit-v1';

/** Minutes after which a 'running' ingestion run is considered abandoned. */
const STALE_RUN_THRESHOLD_MINUTES = 60;

export interface IngestionDataPaths {
  ballByBallCsv: string;
  matchCsv: string;
}

export interface IngestionServiceOptions {
  dryRun?: boolean;
  repository?: IngestionRepository;
  dataPaths?: IngestionDataPaths;
}

interface SequencedDelivery {
  record: DeliveryRecord;
  matchId: string;
  deliveryNumber: number;
}

interface ResolvedTeam {
  id: string;
  canonicalName: string;
}

interface ResolvedMatch {
  id: string;
}

export async function inspectSourceFiles(dataPaths: IngestionDataPaths = defaultDataPaths): Promise<{
  files: IngestionReport['files'];
  summary: Record<string, number>;
}> {
  const files = await Promise.all([
    (async () => {
      const rows = await readDeliverySource(dataPaths.ballByBallCsv);
      return {
        path: logicalSourcePath(dataPaths.ballByBallCsv),
        sha256: await computeFileSha256(dataPaths.ballByBallCsv),
        rowCount: rows.length,
        sourceType: 'ball-by-ball' as const,
      };
    })(),
    (async () => {
      const rows = await readMatchSource(dataPaths.matchCsv);
      return {
        path: logicalSourcePath(dataPaths.matchCsv),
        sha256: await computeFileSha256(dataPaths.matchCsv),
        rowCount: rows.length,
        sourceType: 'match' as const,
      };
    })(),
  ]);
  return { files, summary: { deliveries: files[0]?.rowCount ?? 0, matches: files[1]?.rowCount ?? 0 } };
}

export async function validateSourceData(
  seasonSelection = '2024/25',
  options: IngestionServiceOptions = {},
): Promise<IngestionReport> {
  if (!validateSeasonSelection(seasonSelection)) {
    throw new Error(`Unsupported season selection: ${seasonSelection}`);
  }
  const dataPaths = options.dataPaths ?? defaultDataPaths;
  const issues: IngestionIssue[] = [];
  const inspected = await inspectSourceFiles(dataPaths);
  const sourceYears = [...seasonSelectionToValues(seasonSelection)].sort();
  const processedSeasons = sourceYears.map((year) => canonicalSeasonForSourceYear(year).seasonKey);
  const deliveryRows = filterSourceRowsBySeason(await readDeliverySource(dataPaths.ballByBallCsv), seasonSelection);
  const matchRows = filterSourceRowsBySeason(await readMatchSource(dataPaths.matchCsv), seasonSelection);
  const validDeliveryRows = deliveryRows.filter((record) => validateDeliveryRecord(record, issues));
  const validMatchRows = matchRows.filter((record) => validateMatchRecord(record, issues));
  const crosswalkAudit = validateStaticCrosswalks(validMatchRows, validDeliveryRows);
  issues.push(...crosswalkAudit.issues);
  const totalRows = deliveryRows.length + matchRows.length;
  const validCount = validDeliveryRows.length + validMatchRows.length;
  const report = buildReport(issues, totalRows, validCount, options.dryRun ?? true, inspected.files, seasonSelection);

  return {
    ...report,
    validRecords: validCount,
    failedRecords: totalRows - validCount + crosswalkAudit.failedRows,
    duplicateRecords: crosswalkAudit.duplicateRecords,
    unresolvedTeams: 0,
    unresolvedPlayers: 0,
    processedSeasons,
    sourceYears,
    identityResolutionPerformed: false,
  };
}

export async function dryRunIngestion(seasonSelection = '2024/25', options: IngestionServiceOptions = {}): Promise<IngestionReport> {
  return validateSourceData(seasonSelection, { ...options, dryRun: true });
}

export async function runSeasonIngestion(
  seasonSelection = '2024/25',
  options: IngestionServiceOptions = {},
): Promise<IngestionReport> {
  if (!validateSeasonSelection(seasonSelection)) {
    throw new Error(`Unsupported season selection: ${seasonSelection}`);
  }
  const dryRun = options.dryRun ?? false;
  if (dryRun) {
    return validateSourceData(seasonSelection, { ...options, dryRun: true });
  }
  const repository = options.repository ?? new SupabaseIngestionRepository();
  const dataPaths = options.dataPaths ?? defaultDataPaths;
  if (!dryRun && !repository.isAvailable()) {
    throw new Error('Supabase is not configured or unavailable. Database ingestion cannot proceed.');
  }

  const issues: IngestionIssue[] = [];
  const inspected = await inspectSourceFiles(dataPaths);
  const sourceYears = [...seasonSelectionToValues(seasonSelection)].sort();
  const processedSeasons = sourceYears.map((year) => canonicalSeasonForSourceYear(year).seasonKey);
  const rawDeliveryRows = filterSourceRowsBySeason(await readDeliverySource(dataPaths.ballByBallCsv), seasonSelection);
  const rawMatchRows = filterSourceRowsBySeason(await readMatchSource(dataPaths.matchCsv), seasonSelection);
  if (rawDeliveryRows.length === 0 && rawMatchRows.length === 0) {
    throw new Error(`No matching records found for season selection: ${seasonSelection}`);
  }

  const deliveryRows = rawDeliveryRows.filter((record) => validateDeliveryRecord(record, issues));
  const matchRows = rawMatchRows.filter((record) => validateMatchRecord(record, issues));
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let failed = rawDeliveryRows.length + rawMatchRows.length - deliveryRows.length - matchRows.length;
  let duplicateRecords = 0;
  let unresolvedTeams = 0;
  let unresolvedPlayers = 0;
  let ingestionRunId: string | null = null;
  const counters = (): Record<string, number> => ({
    rowsRead: rawDeliveryRows.length + rawMatchRows.length,
    rowsInserted: inserted,
    rowsUpdated: updated,
    rowsUnchanged: unchanged,
    rowsRejected: failed,
  });
  const report = (): IngestionReport => ({
    totalSourceRows: rawDeliveryRows.length + rawMatchRows.length,
    validRecords: deliveryRows.length + matchRows.length,
    successfullyInserted: inserted,
    updatedRecords: updated,
    skippedRecords: unchanged,
    failedRecords: failed,
    unresolvedTeams,
    unresolvedPlayers,
    duplicateRecords,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
    fatalErrors: issues.filter((issue) => issue.severity === 'error' || issue.severity === 'blocking').length,
    issues,
    files: inspected.files,
    sourceSet: seasonSelection,
    processedSeasons,
    sourceYears,
    identityResolutionPerformed: !dryRun,
    dryRun,
  });

  try {
    const ingestionRun = await repository.createIngestionRun({
      pipelineVersion: INGESTION_PIPELINE_VERSION,
      sourceSet: seasonSelection,
      // Pass the delivery source path so the repository can atomically check for
      // concurrent runs and refuse to create a new one if another is already running.
      sourceSystem: DELIVERY_SOURCE_SYSTEM,
      logicalPath: logicalSourcePath(dataPaths.ballByBallCsv),
      staleThresholdMinutes: STALE_RUN_THRESHOLD_MINUTES,
    });
    ingestionRunId = ingestionRun.id;

    const [deliverySourceFile, matchSourceFile] = await Promise.all([
      repository.registerSourceFile({
        ingestionRunId,
        sourceSystem: DELIVERY_SOURCE_SYSTEM,
        logicalPath: logicalSourcePath(dataPaths.ballByBallCsv),
        contentSha256: inspected.files[0]!.sha256,
        format: 'csv',
        seasonId: null,
        rowCount: inspected.files[0]!.rowCount,
      }),
      repository.registerSourceFile({
        ingestionRunId,
        sourceSystem: MATCH_SOURCE_SYSTEM,
        logicalPath: logicalSourcePath(dataPaths.matchCsv),
        contentSha256: inspected.files[1]!.sha256,
        format: 'csv',
        seasonId: null,
        rowCount: inspected.files[1]!.rowCount,
      }),
    ]);

    const previousDeliveryRowCount = deliverySourceFile.previousSourceRowCount;
    if (deliverySourceFile.previousSourceSha256
      && deliverySourceFile.previousSourceSha256 !== inspected.files[0]!.sha256
      && previousDeliveryRowCount !== null
      && previousDeliveryRowCount !== undefined
      && inspected.files[0]!.rowCount < previousDeliveryRowCount) {
      throw new Error(
        `Changed delivery source ${logicalSourcePath(dataPaths.ballByBallCsv)} has fewer rows `
        + `(${inspected.files[0]!.rowCount}) than its last successful version (${previousDeliveryRowCount}). `
        + 'Deletion reconciliation is not implemented; refusing to persist this file.',
      );
    }
    // Known limitation: same-count changed content is allowed through. Without a stable
    // per-row identifier it is impossible to distinguish a legitimate field-value update
    // from a silent record replacement (remove one row, add a different one). Deliveries
    // are reconciled by their (match_id, innings_no, delivery_no) sequence identity.
    // See README: "same-count delivery file replacements remain ambiguous".

    const deliveryFileUnchanged = sourceFileWasCompletedFor(deliverySourceFile, processedSeasons);
    const matchFileUnchanged = sourceFileWasCompletedFor(matchSourceFile, processedSeasons);
    if (deliveryFileUnchanged) unchanged += rawDeliveryRows.length;
    if (matchFileUnchanged) unchanged += rawMatchRows.length;

    const seasonIds = new Map<string, string>();
    for (const sourceYear of sourceYears) {
      const canonicalSeason = canonicalSeasonForSourceYear(sourceYear);
      const outcome = await repository.ensureSeason(canonicalSeason.seasonKey, canonicalSeason.label);
      if (outcome.outcome === 'rejected' || !outcome.data?.id) {
        throw new Error(outcome.reason ?? `Canonical season ${canonicalSeason.seasonKey} was rejected.`);
      }
      seasonIds.set(sourceYear, outcome.data.id);
    }

    const sourceFileIds = new Map<string, string>([
      [logicalSourcePath(dataPaths.ballByBallCsv), deliverySourceFile.id],
      [logicalSourcePath(dataPaths.matchCsv), matchSourceFile.id],
    ]);
    const issueKeys = new Set<string>();
    const teamCache = new Map<string, ResolvedTeam | null>();
    const playerCache = new Map<string, string | null>();
    const matchBySourceIdentity = new Map<string, ResolvedMatch>();
    const matchRowsByIdentity = groupMatchesBySourceIdentity(matchRows);

    const addIssue = (issue: IngestionIssue, dedupeKey?: string): void => {
      if (dedupeKey && issueKeys.has(dedupeKey)) return;
      if (dedupeKey) issueKeys.add(dedupeKey);
      issues.push({
        ...issue,
        sourceFileId: issue.sourceFile ? sourceFileIds.get(issue.sourceFile) : undefined,
      });
    };

    const resolveTeam = async (
      name: string,
      sourceSystem: string,
      context: { sourceFile: string; rowNumber: number; entityName: string },
    ): Promise<ResolvedTeam | null> => {
      if (!name.trim()) return null;
      const key = `${sourceSystem}\u001f${normalizeAlias(name)}`;
      if (teamCache.has(key)) return teamCache.get(key) ?? null;
      try {
        const outcome = await repository.ensureTeam(name, sourceSystem);
        if (outcome.outcome !== 'rejected' && outcome.data) {
          const value = { id: outcome.data.id, canonicalName: outcome.data.canonicalName };
          teamCache.set(key, value);
          return value;
        }
        teamCache.set(key, null);
        unresolvedTeams += 1;
        addIssue({
          severity: 'warning',
          code: 'team:identity-unresolved',
          message: outcome.reason ?? `Team alias ${name} is not resolved to a canonical team.`,
          ...context,
        }, `team:${key}`);
        return null;
      } catch (error) {
        teamCache.set(key, null);
        unresolvedTeams += 1;
        addIssue({
          severity: 'error',
          code: 'team:alias-persistence-failed',
          message: errorMessage(error),
          ...context,
        }, `team-error:${key}`);
        return null;
      }
    };

    const resolvePlayer = async (
      name: string,
      sourceSystem: string,
      context: { sourceFile: string; rowNumber: number; entityName: string },
    ): Promise<string | null> => {
      if (!name.trim()) return null;
      const key = `${sourceSystem}\u001f${normalizeAlias(name)}`;
      if (playerCache.has(key)) return playerCache.get(key) ?? null;
      try {
        const outcome = await repository.resolvePlayer(name, sourceSystem);
        if (outcome.outcome !== 'rejected' && outcome.data) {
          playerCache.set(key, outcome.data.id);
          return outcome.data.id;
        }
        playerCache.set(key, null);
        unresolvedPlayers += 1;
        addIssue({
          severity: 'warning',
          code: 'player:identity-unresolved',
          message: outcome.reason ?? `Player identity ${name} requires manual review.`,
          ...context,
        }, `player:${key}`);
        return null;
      } catch (error) {
        playerCache.set(key, null);
        unresolvedPlayers += 1;
        addIssue({
          severity: 'error',
          code: 'player:alias-lookup-failed',
          message: errorMessage(error),
          ...context,
        }, `player-error:${key}`);
        return null;
      }
    };

    if (!matchFileUnchanged) {
      const validMatchSet = new Set(matchRows);
      for (const record of rawMatchRows) {
        if (!validMatchSet.has(record) && record.id.trim()) {
          await persistUnresolvedKey(repository, matchSourceFile.id, MATCH_SOURCE_SYSTEM, record);
        }
      }
    }

    if (!matchFileUnchanged) {
      for (const [identity, records] of matchRowsByIdentity) {
        if (records.length !== 1) {
          duplicateRecords += records.length;
          for (const record of records) {
            addIssue({
              severity: 'blocking',
              code: 'match:duplicate-source-identity',
              message: `Source match identity ${identity} appears ${records.length} times; no candidate was persisted.`,
              sourceFile: record.sourceFile,
              rowNumber: record.sourceRowNumber,
              entityName: 'match',
            });
            await persistUnresolvedKey(repository, matchSourceFile.id, MATCH_SOURCE_SYSTEM, record);
            failed += 1;
          }
          continue;
        }

        const record = records[0]!;
        const mapping = sourceSeasonMappings[record.season];
        const sourceIdNumber = Number(record.id);
        const matchNumber = sourceIdNumber - (mapping?.matchIdOffset ?? 0);
        const seasonId = seasonIds.get(record.season);
        if (!mapping || !Number.isInteger(matchNumber) || matchNumber <= 0 || !seasonId) {
          addIssue({
            severity: 'blocking',
            code: 'match:source-mapping-invalid',
            message: `Match ${record.id} cannot be mapped to a supported canonical season and match number.`,
            sourceFile: record.sourceFile,
            rowNumber: record.sourceRowNumber,
            entityName: 'match',
          });
          await persistUnresolvedKey(repository, matchSourceFile.id, MATCH_SOURCE_SYSTEM, record);
          failed += 1;
          continue;
        }

        const teamA = await resolveTeam(record.team_1, MATCH_SOURCE_SYSTEM, issueContext(record, 'match'));
        const teamB = await resolveTeam(record.team_2, MATCH_SOURCE_SYSTEM, issueContext(record, 'match'));
        if (!teamA || !teamB || teamA.id === teamB.id) {
          addIssue({
            severity: 'error',
            code: 'match:required-team-unresolved',
            message: `Match ${record.id} was not persisted because its two canonical teams could not be resolved.`,
            sourceFile: record.sourceFile,
            rowNumber: record.sourceRowNumber,
            entityName: 'match',
          });
          await persistUnresolvedKey(repository, matchSourceFile.id, MATCH_SOURCE_SYSTEM, record);
          failed += 1;
          continue;
        }

        const tossWinner = record.toss_winner
          ? await resolveTeam(record.toss_winner, MATCH_SOURCE_SYSTEM, issueContext(record, 'match'))
          : null;
        const winner = record.winner
          ? await resolveTeam(record.winner, MATCH_SOURCE_SYSTEM, issueContext(record, 'match'))
          : null;
        const playerOfMatchId = await resolvePlayer(record.player_of_the_match, MATCH_SOURCE_SYSTEM, issueContext(record, 'match'));

        try {
          const outcome = await repository.persistMatch({
            record,
            sourceFileId: matchSourceFile.id,
            seasonId,
            matchNumber,
            teamAId: teamA.id,
            teamBId: teamB.id,
            tossWinnerTeamId: tossWinner?.id ?? null,
            winnerTeamId: winner?.id ?? null,
            playerOfMatchId,
          });
          if (!applyOutcome(outcome.outcome, () => { inserted += 1; }, () => { updated += 1; }, () => { unchanged += 1; })) {
            addIssue({
              severity: 'error',
              code: 'match:persistence-rejected',
              message: outcome.reason ?? `Match ${record.id} was rejected by the repository.`,
              sourceFile: record.sourceFile,
              rowNumber: record.sourceRowNumber,
              entityName: 'match',
            });
            failed += 1;
            continue;
          }
          if (outcome.data) matchBySourceIdentity.set(identity, { id: outcome.data.id });
        } catch (error) {
          addIssue({
            severity: 'error',
            code: 'match:persistence-failed',
            message: errorMessage(error),
            sourceFile: record.sourceFile,
            rowNumber: record.sourceRowNumber,
            entityName: 'match',
          });
          await persistUnresolvedKey(repository, matchSourceFile.id, MATCH_SOURCE_SYSTEM, record);
          failed += 1;
        }
      }
    }

    if (matchFileUnchanged && !deliveryFileUnchanged) {
      for (const [identity, records] of matchRowsByIdentity) {
        if (records.length !== 1) continue;
        const record = records[0]!;
        try {
          const outcome = await repository.resolveMatchSourceKey({
            sourceSystem: MATCH_SOURCE_SYSTEM,
            sourceSeasonKey: record.season,
            externalMatchKey: record.id,
          });
          if (outcome.outcome !== 'rejected' && outcome.data) {
            matchBySourceIdentity.set(identity, { id: outcome.data.id });
          } else {
            addIssue({
              severity: 'error',
              code: 'match:source-key-unresolved',
              message: outcome.reason ?? `Previously processed match key ${record.id} is unresolved.`,
              sourceFile: record.sourceFile,
              rowNumber: record.sourceRowNumber,
              entityName: 'match',
            });
            failed += 1;
          }
        } catch (error) {
          addIssue({
            severity: 'error',
            code: 'match:source-key-lookup-failed',
            message: errorMessage(error),
            sourceFile: record.sourceFile,
            rowNumber: record.sourceRowNumber,
            entityName: 'match',
          });
          failed += 1;
        }
      }
    }

    if (!deliveryFileUnchanged) {
      const deliveryGroups = groupDeliveriesBySourceMatch(deliveryRows);
      const sequenceInputs: Array<{ record: DeliveryRecord; matchId: string }> = [];
      const deliveryMetadata = new Map<number, {
        battingTeamId: string;
        bowlingTeamId: string;
        bowlerId: string | null;
        batterId: string | null;
        nonStrikerId: string | null;
        playerOutId: string | null;
        fielders: Array<{ name: string; playerId: string | null }>;
      }>();
      for (const [sourceIdentity, records] of deliveryGroups) {
        const first = records[0]!;
        const matchNo = parseDeliveryMatchNumber(first);
        const sourceMatchIdentity = mapDeliveryMatchToSourceIdentity(first.season, matchNo);
        const candidates = sourceMatchIdentity ? matchRowsByIdentity.get(sourceMatchIdentity) ?? [] : [];
        const candidateResolution = resolveUniqueSourceMatch(candidates);
        const sourceMatch = candidateResolution.record;
        const teamPairMatches = sourceMatch !== null && records.every((record) =>
          sameTeamPair(sourceMatch.team_1, sourceMatch.team_2, record.batting_team, record.bowling_team));

        if (!sourceMatchIdentity || !sourceMatch || !teamPairMatches) {
          const ambiguous = candidateResolution.status === 'ambiguous';
          const message = ambiguous
            ? `Delivery source match ${first.match_id} maps to duplicate match-feed IDs and cannot be resolved.`
            : !sourceMatch
              ? `Delivery source match ${first.match_id} has no unique match-feed crosswalk.`
              : `Delivery source match ${first.match_id} has a team-pair mismatch with match-feed row ${sourceMatch.sourceRowNumber}.`;
          addIssue({
            severity: 'blocking',
            code: ambiguous ? 'match:crosswalk-ambiguous' : 'match:crosswalk-unresolved',
            message,
            sourceFile: first.sourceFile,
            rowNumber: first.sourceRowNumber,
            entityName: 'match',
          }, `crosswalk:${sourceIdentity}`);
          await repository.persistUnresolvedMatchKey({
            sourceFileId: deliverySourceFile.id,
            sourceSystem: DELIVERY_SOURCE_SYSTEM,
            sourceSeasonKey: first.season,
            externalMatchKey: first.match_id,
            sourceRowNumber: first.sourceRowNumber,
          });
          failed += records.length;
          if (ambiguous) duplicateRecords += records.length;
          continue;
        }

        const canonical = matchBySourceIdentity.get(sourceMatchIdentity);
        if (!canonical) {
          addIssue({
            severity: 'error',
            code: 'delivery:parent-match-unavailable',
            message: `Delivery source match ${first.match_id} was not processed because its canonical match record failed.`,
            sourceFile: first.sourceFile,
            rowNumber: first.sourceRowNumber,
            entityName: 'delivery',
          }, `delivery-parent:${sourceIdentity}`);
          failed += records.length;
          continue;
        }

        let sourceKeyOutcome: PersistenceOutcome;
        try {
          sourceKeyOutcome = await repository.persistMatchSourceKey({
            matchId: canonical.id,
            sourceFileId: deliverySourceFile.id,
            sourceSystem: DELIVERY_SOURCE_SYSTEM,
            sourceSeasonKey: first.season,
            externalMatchKey: first.match_id,
            sourceRowNumber: first.sourceRowNumber,
          });
        } catch (error) {
          addIssue({
            severity: 'error',
            code: 'delivery:source-key-persistence-failed',
            message: errorMessage(error),
            sourceFile: first.sourceFile,
            rowNumber: first.sourceRowNumber,
            entityName: 'match',
          });
          failed += records.length;
          continue;
        }
        if (sourceKeyOutcome.outcome === 'rejected') {
          addIssue({
            severity: 'error',
            code: 'delivery:source-key-conflict',
            message: sourceKeyOutcome.reason ?? `Delivery source key ${first.match_id} conflicts with an existing canonical match.`,
            sourceFile: first.sourceFile,
            rowNumber: first.sourceRowNumber,
            entityName: 'match',
          });
          failed += records.length;
          continue;
        }

        for (const record of records) {
          const context = issueContext(record, 'delivery');
          const battingTeam = await resolveTeam(record.batting_team, DELIVERY_SOURCE_SYSTEM, context);
          const bowlingTeam = await resolveTeam(record.bowling_team, DELIVERY_SOURCE_SYSTEM, context);
          if (!battingTeam || !bowlingTeam || battingTeam.id === bowlingTeam.id) {
            addIssue({
              severity: 'error',
              code: 'delivery:required-team-unresolved',
              message: 'Delivery was not persisted because its innings teams could not be resolved.',
              ...context,
            });
            failed += 1;
            continue;
          }
          const [bowlerId, batterId, nonStrikerId, playerOutId] = await Promise.all([
            resolvePlayer(record.bowler, DELIVERY_SOURCE_SYSTEM, context),
            resolvePlayer(record.batsman, DELIVERY_SOURCE_SYSTEM, context),
            resolvePlayer(record.non_striker, DELIVERY_SOURCE_SYSTEM, context),
            resolvePlayer(record.player_out, DELIVERY_SOURCE_SYSTEM, context),
          ]);
          const fielders = await Promise.all(splitFielders(record.fielders).map(async (name) => ({
            name,
            playerId: await resolvePlayer(name, DELIVERY_SOURCE_SYSTEM, context),
          })));
          deliveryMetadata.set(record.sourceRowNumber, {
            battingTeamId: battingTeam.id,
            bowlingTeamId: bowlingTeam.id,
            bowlerId,
            batterId,
            nonStrikerId,
            playerOutId,
            fielders,
          });
          sequenceInputs.push({ record, matchId: canonical.id });
        }
      }

      const sequenced = assignDeliverySequences(sequenceInputs);
      for (let offset = 0; offset < sequenced.length; offset += DELIVERY_BATCH_SIZE) {
        const batch = sequenced.slice(offset, offset + DELIVERY_BATCH_SIZE);
        const persistenceRecords = batch.map(({ record, matchId, deliveryNumber }) => {
          const details = deliveryMetadata.get(record.sourceRowNumber);
          if (!details) throw new Error(`Missing prepared identity data for delivery source row ${record.sourceRowNumber}.`);
          return {
            delivery: record,
            matchId,
            deliveryNumber,
            sourceFileId: deliverySourceFile.id,
            battingTeamId: details.battingTeamId,
            bowlingTeamId: details.bowlingTeamId,
            bowlerId: details.bowlerId,
            batterId: details.batterId,
            nonStrikerId: details.nonStrikerId,
            playerOutId: details.playerOutId,
            fielders: details.fielders.map((fielder) => ({ playerId: fielder.playerId, name: fielder.name })),
          } satisfies DeliveryPersistenceInput;
        });

        try {
          const outcomes = await repository.persistDeliveryBatch(persistenceRecords);
          for (let index = 0; index < outcomes.length; index += 1) {
            const outcome = outcomes[index]!;
            if (!applyOutcome(outcome.outcome, () => { inserted += 1; }, () => { updated += 1; }, () => { unchanged += 1; })) {
              const record = batch[index]!.record;
              addIssue({
                severity: 'error',
                code: 'delivery:persistence-rejected',
                message: outcome.reason ?? 'Delivery was rejected by the repository.',
                sourceFile: record.sourceFile,
                rowNumber: record.sourceRowNumber,
                entityName: 'delivery',
              });
              failed += 1;
            }
          }
        } catch (error) {
          for (const { record } of batch) {
            addIssue({
              severity: 'error',
              code: 'delivery:batch-persistence-failed',
              message: `Atomic delivery batch ${offset + 1}-${offset + batch.length} failed: ${errorMessage(error)}`,
              sourceFile: record.sourceFile,
              rowNumber: record.sourceRowNumber,
              entityName: 'delivery',
            });
            failed += 1;
          }
        }
      }
    }

    for (const issue of issues) {
      if (!issue.sourceFileId && issue.sourceFile) {
        issue.sourceFileId = sourceFileIds.get(issue.sourceFile);
      }
    }
    await repository.persistIssues(issues, ingestionRunId);
    await repository.completeIngestionRun(
      ingestionRunId,
      issues.filter((issue) => issue.severity === 'error' || issue.severity === 'blocking').length,
      counters(),
      {
        processedSeasons,
        sourceYears,
        sourceSet: seasonSelection,
        pipelineVersion: INGESTION_PIPELINE_VERSION,
        issueCount: issues.length,
      },
    );
    return report();
  } catch (error) {
    const message = errorMessage(error);
    if (ingestionRunId) {
      const failureIssue: IngestionIssue = {
        severity: 'error',
        code: 'ingestion:run-failed',
        message,
        entityName: 'ingestion_run',
      };
      const finalizationErrors: string[] = [];
      try {
        await repository.persistIssues([failureIssue], ingestionRunId);
      } catch (issueError) {
        finalizationErrors.push(`failed to persist failure issue: ${errorMessage(issueError)}`);
      }
      try {
        await repository.failIngestionRun(ingestionRunId, message, counters());
      } catch (finalizeError) {
        finalizationErrors.push(`failed to finalize ingestion run: ${errorMessage(finalizeError)}`);
      }
      if (finalizationErrors.length) {
        throw new Error(`${message}; ${finalizationErrors.join('; ')}`);
      }
    }
    throw error;
  }
}

export async function runAllIngestion(options: IngestionServiceOptions = {}): Promise<IngestionReport> {
  return runSeasonIngestion('all', options);
}

export function createReportSummary(report: IngestionReport): Record<string, unknown> {
  return {
    totalSourceRows: report.totalSourceRows,
    validRecords: report.validRecords,
    successfullyInserted: report.successfullyInserted,
    updatedRecords: report.updatedRecords,
    skippedRecords: report.skippedRecords,
    failedRecords: report.failedRecords,
    unresolvedTeams: report.unresolvedTeams,
    unresolvedPlayers: report.unresolvedPlayers,
    duplicateRecords: report.duplicateRecords,
    warnings: report.warnings,
    fatalErrors: report.fatalErrors,
    processedSeasons: report.processedSeasons,
    sourceYears: report.sourceYears,
    identityResolutionPerformed: report.identityResolutionPerformed,
  };
}

export async function generateIngestionReport(
  seasonSelection = '2024/25',
  options: IngestionServiceOptions = {},
): Promise<IngestionReport> {
  return validateSourceData(seasonSelection, { ...options, dryRun: true });
}

export function assignDeliverySequences(records: Array<{ record: DeliveryRecord; matchId: string }>): SequencedDelivery[] {
  const grouped = new Map<string, Array<{ record: DeliveryRecord; matchId: string; originalIndex: number }>>();
  records.forEach(({ record, matchId }, originalIndex) => {
    const key = `${matchId}\u001f${record.inning}`;
    const group = grouped.get(key) ?? [];
    group.push({ record, matchId, originalIndex });
    grouped.set(key, group);
  });

  const result: SequencedDelivery[] = [];
  for (const group of grouped.values()) {
    group.sort((left, right) => left.record.sourceRowNumber - right.record.sourceRowNumber || left.originalIndex - right.originalIndex);
    group.forEach(({ record, matchId }, index) => {
      result.push({ record, matchId, deliveryNumber: index + 1 });
    });
  }
  return result;
}

function sourceFileWasCompletedFor(
  sourceFile: { previousRunStatus: string | null; previousSummary: Record<string, unknown> | null },
  processedSeasons: string[],
): boolean {
  if (sourceFile.previousRunStatus !== 'succeeded'
    || sourceFile.previousSummary?.pipelineVersion !== INGESTION_PIPELINE_VERSION
    || !Array.isArray(sourceFile.previousSummary.processedSeasons)) {
    return false;
  }
  const previousSeasons = sourceFile.previousSummary.processedSeasons;
  return processedSeasons.every((season) => previousSeasons.includes(season));
}

export function groupMatchesBySourceIdentity(records: MatchRecord[]): Map<string, MatchRecord[]> {
  const result = new Map<string, MatchRecord[]>();
  for (const record of records) {
    const key = `${record.season}\u001f${record.id}`;
    const group = result.get(key) ?? [];
    group.push(record);
    result.set(key, group);
  }
  return result;
}

function groupDeliveriesBySourceMatch(records: DeliveryRecord[]): Map<string, DeliveryRecord[]> {
  const result = new Map<string, DeliveryRecord[]>();
  for (const record of records) {
    const key = `${record.season}\u001f${record.match_id}`;
    const group = result.get(key) ?? [];
    group.push(record);
    result.set(key, group);
  }
  return result;
}

export function parseDeliveryMatchNumber(record: DeliveryRecord): number | null {
  const sourceId = record.match_id.split('_').at(-1);
  const matchNumber = Number(sourceId);
  return Number.isInteger(matchNumber) && matchNumber > 0 ? matchNumber : null;
}

export function mapDeliveryMatchToSourceIdentity(sourceYear: string, deliveryMatchNumber: number | null): string | null {
  const mapping = sourceSeasonMappings[sourceYear];
  if (!mapping || deliveryMatchNumber === null) return null;
  return `${sourceYear}\u001f${deliveryMatchNumber + mapping.matchIdOffset}`;
}

export function resolveUniqueSourceMatch(records: MatchRecord[]): {
  status: 'resolved' | 'missing' | 'ambiguous';
  record: MatchRecord | null;
} {
  if (records.length === 1) return { status: 'resolved', record: records[0] ?? null };
  if (records.length > 1) return { status: 'ambiguous', record: null };
  return { status: 'missing', record: null };
}

export function sameTeamPair(matchTeamA: string, matchTeamB: string, battingTeam: string, bowlingTeam: string): boolean {
  const matchPair = [normalizeAlias(canonicalizeTeamName(matchTeamA)), normalizeAlias(canonicalizeTeamName(matchTeamB))].sort();
  const deliveryPair = [normalizeAlias(canonicalizeTeamName(battingTeam)), normalizeAlias(canonicalizeTeamName(bowlingTeam))].sort();
  return matchPair[0] === deliveryPair[0] && matchPair[1] === deliveryPair[1];
}

async function persistUnresolvedKey(
  repository: IngestionRepository,
  sourceFileId: string,
  sourceSystem: string,
  record: MatchRecord,
): Promise<void> {
  await repository.persistUnresolvedMatchKey({
    sourceFileId,
    sourceSystem,
    sourceSeasonKey: record.season,
    externalMatchKey: record.id,
    sourceRowNumber: record.sourceRowNumber,
  });
}

function issueContext(record: DeliveryRecord | MatchRecord, entityName: string): {
  sourceFile: string;
  rowNumber: number;
  entityName: string;
} {
  return { sourceFile: record.sourceFile, rowNumber: record.sourceRowNumber, entityName };
}

function applyOutcome(
  outcome: PersistenceAction,
  onInserted: () => void,
  onUpdated: () => void,
  onUnchanged: () => void,
): boolean {
  if (outcome === 'inserted') onInserted();
  else if (outcome === 'updated') onUpdated();
  else if (outcome === 'unchanged') onUnchanged();
  else return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateStaticCrosswalks(
  matches: MatchRecord[],
  deliveries: DeliveryRecord[],
): { issues: IngestionIssue[]; failedRows: number; duplicateRecords: number } {
  const issues: IngestionIssue[] = [];
  let failedRows = 0;
  let duplicateRecords = 0;
  const matchesByIdentity = groupMatchesBySourceIdentity(matches);

  for (const [identity, records] of matchesByIdentity) {
    if (records.length < 2) continue;
    duplicateRecords += records.length;
    failedRows += records.length;
    for (const record of records) {
      issues.push({
        severity: 'blocking',
        code: 'match:duplicate-source-identity',
        message: `Source match identity ${identity} appears ${records.length} times; no candidate was persisted.`,
        sourceFile: record.sourceFile,
        rowNumber: record.sourceRowNumber,
        entityName: 'match',
      });
    }
  }

  for (const records of groupDeliveriesBySourceMatch(deliveries).values()) {
    const first = records[0]!;
    const candidateIdentity = mapDeliveryMatchToSourceIdentity(
      first.season,
      parseDeliveryMatchNumber(first),
    );
    const candidates = candidateIdentity ? matchesByIdentity.get(candidateIdentity) ?? [] : [];
    const resolution = resolveUniqueSourceMatch(candidates);
    const candidate = resolution.record;
    const teamPairMatches = candidate !== null && records.every((record) =>
      sameTeamPair(candidate.team_1, candidate.team_2, record.batting_team, record.bowling_team));
    if (candidateIdentity && candidate && teamPairMatches) continue;

    failedRows += records.length;
    const ambiguous = resolution.status === 'ambiguous';
    if (ambiguous) duplicateRecords += records.length;
    issues.push({
      severity: 'blocking',
      code: ambiguous ? 'match:crosswalk-ambiguous' : 'match:crosswalk-unresolved',
      message: ambiguous
        ? `Delivery source match ${first.match_id} maps to duplicate match-feed IDs and cannot be resolved.`
        : !candidate
          ? `Delivery source match ${first.match_id} has no unique match-feed crosswalk.`
          : `Delivery source match ${first.match_id} has a team-pair mismatch with match-feed row ${candidate.sourceRowNumber}.`,
      sourceFile: first.sourceFile,
      rowNumber: first.sourceRowNumber,
      entityName: 'match',
    });
  }
  return { issues, failedRows, duplicateRecords };
}
