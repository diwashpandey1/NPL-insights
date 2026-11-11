export type IngestionSeverity = 'warning' | 'error' | 'blocking';

export interface IngestionIssue {
  severity: IngestionSeverity;
  code: string;
  message: string;
  sourceFile?: string;
  rowNumber?: number;
  entityName?: string;
  columnName?: string;
}

export interface SourceRowRecord {
  sourceRowNumber: number;
  sourceFile: string;
  [key: string]: string | number | boolean | null | undefined;
}

export interface DeliveryRecord extends SourceRowRecord {
  match_id: string;
  season: string;
  match_number: string;
  inning: number;
  batting_team: string;
  bowling_team: string;
  ball_over: string;
  ball_result: string;
  bowler: string;
  batsman: string;
  non_striker: string;
  shot_direction: string;
  player_out: string;
  dismissal_kind: string;
  fielders: string;
  batsman_runs: number | null;
  wide_runs: number | null;
  bye_runs: number | null;
  legbye_runs: number | null;
  noball_runs: number | null;
  extra_runs: number | null;
  total_runs: number | null;
}

export interface MatchRecord extends SourceRowRecord {
  id: string;
  season: string;
  date: string;
  city: string;
  venue: string;
  stage: string;
  team_1: string;
  team_2: string;
  toss_winner: string;
  toss_decision: string;
  result: string;
  dls_applied: boolean | null;
  super_over: boolean | null;
  winner: string;
  player_of_the_match: string;
  win_by_runs: number | null;
  win_by_wickets: number | null;
}

export interface IngestionReport {
  totalSourceRows: number;
  validRecords: number;
  successfullyInserted: number;
  updatedRecords: number;
  skippedRecords: number;
  failedRecords: number;
  unresolvedTeams: number;
  unresolvedPlayers: number;
  duplicateRecords: number;
  warnings: number;
  fatalErrors: number;
  issues: IngestionIssue[];
  files: Array<{
    path: string;
    sha256: string;
    rowCount: number;
    sourceType: 'ball-by-ball' | 'match' | 'unknown';
  }>;
  sourceSet: string;
  dryRun: boolean;
}
