import { useState } from 'react'
import type { Team } from '../../constants/teams'

type Props = { team: Pick<Team, 'name' | 'logo'>; size?: 'small' | 'medium' | 'large'; className?: string }

export function TeamLogo({ team, size = 'medium', className = '' }: Props) {
  const [failed, setFailed] = useState(false)
  const initials = team.name.split(' ').slice(-1)[0]?.slice(0, 2).toUpperCase() ?? 'NPL'
  return <span className={`team-logo team-logo--${size} ${className}`} aria-label={`${team.name} logo`}>
    {failed ? <span className="team-logo-fallback" aria-hidden="true">{initials}</span> : <img src={team.logo} alt="" loading="lazy" onError={() => setFailed(true)} />}
  </span>
}
