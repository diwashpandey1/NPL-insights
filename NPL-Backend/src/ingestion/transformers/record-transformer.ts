import type { DeliveryRecord, MatchRecord } from '../types/index.js';

export interface CanonicalDeliveryRecord {
  matchId: string;
  seasonKey: string;
  inning: number;
  battingTeam: string;
  bowlingTeam: string;
  ballOver: string;
  batter: string;
  bowler: string;
  totalRuns: number | null;
}

export function transformDeliveryRecord(record: DeliveryRecord): CanonicalDeliveryRecord {
  return {
    matchId: record.match_id,
    seasonKey: record.season,
    inning: record.inning,
    battingTeam: record.batting_team,
    bowlingTeam: record.bowling_team,
    ballOver: record.ball_over,
    batter: record.batsman,
    bowler: record.bowler,
    totalRuns: record.total_runs,
  };
}

export function transformMatchRecord(record: MatchRecord): Record<string, unknown> {
  return {
    id: record.id,
    season: record.season,
    teamA: record.team_1,
    teamB: record.team_2,
    winner: record.winner,
    tossWinner: record.toss_winner,
    result: record.result,
    winByRuns: record.win_by_runs,
    winByWickets: record.win_by_wickets,
  };
}
