import type { Team } from '../../constants/teams'
import { TeamLogo } from './TeamLogo'

export function TeamBadge({ team, compact = false }: { team: Team; compact?: boolean }) {
  return <span className={`team-badge ${compact ? 'team-badge--compact' : ''}`}><TeamLogo team={team} size="small" /><span>{compact ? team.shortName : team.name}</span></span>
}
