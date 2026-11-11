import { CricketIcon, type CricketIconName } from '../ui/CricketIcon'
import { TeamLogo } from '../ui/TeamLogo'
import { teams } from '../../constants/teams'

export type PlayerSummary = { name: string; role: string; teamId: string; highlight: string; icon: CricketIconName }

export function PlayerCard({ player, title, subtitle, icon = 'batter' }: { player?: PlayerSummary; title?: string; subtitle?: string; icon?: CricketIconName }) {
  const playerTeam = player ? teams.find((team) => team.id === player.teamId) : undefined
  return <article className="player-card">
    <span className="player-card-icon"><CricketIcon name={player?.icon ?? icon} size={24} /></span>
    {player ? <><div className="player-role">{player.role}</div><h3>{player.name}</h3><div className="player-team">{playerTeam && <TeamLogo team={playerTeam} size="small" />}{playerTeam?.name ?? 'Team not listed'}</div><strong className="player-highlight">{player.highlight}</strong></> : <><div className="player-role">PERFORMANCE WATCH</div><h3>{title ?? 'Player data pending'}</h3><p>{subtitle ?? 'Player statistics will appear here when a verified data feed is connected.'}</p></>}
  </article>
}
