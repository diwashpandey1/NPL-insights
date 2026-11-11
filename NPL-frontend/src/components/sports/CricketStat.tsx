import { CricketIcon, type CricketIconName } from '../ui/CricketIcon'

type Props = { icon: CricketIconName; label: string; value: string; note?: string }
export function CricketStat({ icon, label, value, note }: Props) {
  return <div className="cricket-stat"><span className="cricket-stat-icon"><CricketIcon name={icon} size={22} /></span><div><span className="cricket-stat-label">{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div></div>
}
