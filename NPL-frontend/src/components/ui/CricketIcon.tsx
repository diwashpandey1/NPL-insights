export type CricketIconName =
  | 'runs' | 'wickets' | 'six' | 'four' | 'batter' | 'bowler' | 'overs'
  | 'strike-rate' | 'economy' | 'catches' | 'matches' | 'toss' | 'win' | 'loss' | 'points' | 'nrr'

type Props = { name: CricketIconName; size?: number; className?: string; label?: string }

/** Lightweight cricket-specific line art; all glyphs share the same 48px viewbox. */
export function CricketIcon({ name, size = 22, className, label }: Props) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.3, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  let art
  switch (name) {
    case 'runs': art = <><rect x="7" y="11" width="34" height="26" rx="4" /><path d="M13 19h8M13 26h5M28 20h7M28 27h7M13 32h22" /></>; break
    case 'wickets': art = <><path d="M14 10v27M24 8v29M34 10v27M11 37h26M13 8h4M23 6h3M32 8h4" /><path d="M17 5h7" /></>; break
    case 'six': art = <><circle cx="22" cy="27" r="8" /><path d="M15 23l14 8M17 32l10-11M28 12c5 1 8 4 10 8M29 7c7 1 12 6 14 12" /></>; break
    case 'four': art = <><circle cx="18" cy="27" r="7" /><path d="M13 23l10 8M28 12v24M34 12v24M28 18h6" /></>; break
    case 'batter': art = <><circle cx="31" cy="10" r="4" /><path d="M28 15l-8 9 8 6M20 24l-7 1M28 30l-3 9M20 24l-1 14M13 14l18 21M30 13l8-6" /></>; break
    case 'bowler': art = <><circle cx="17" cy="10" r="4" /><path d="M17 15l4 11 10-5M21 26l-8 6-5-5M21 26l6 12M15 17l-8 3M29 13l8-7M38 6l3 3" /></>; break
    case 'overs': art = <><circle cx="24" cy="24" r="15" /><path d="M24 9v15l9 6M19 4h10M38 11l3 4" /><circle cx="18" cy="23" r="1" fill="currentColor" /><circle cx="24" cy="23" r="1" fill="currentColor" /><circle cx="30" cy="23" r="1" fill="currentColor" /></>; break
    case 'strike-rate': art = <><path d="M8 31h8l5-8 5 5 7-14" /><path d="M28 14h5v5M10 38h28M12 10v5M7 15l5-5 5 5" /></>; break
    case 'economy': art = <><path d="M8 34h32M13 34l5-14h12l5 14M18 20l6-8 6 8M24 12V7M24 7l8 4" /><circle cx="24" cy="28" r="3" /></>; break
    case 'catches': art = <><path d="M8 30c4-1 7 0 10 3l5 5c2 2 5 2 7 0l9-9c2-2-1-5-3-3l-8 6M11 29l-3-2-4 4 5 6 4-3" /><circle cx="28" cy="13" r="5" /><path d="M28 8c-3 4-3 7 0 10M24 13h8" /></>; break
    case 'matches': art = <><path d="M7 37V23l8-7 9 7 9-7 8 7v14M4 37h40M13 37v-8h7v8M29 37v-8h7v8M19 16l5-5 5 5" /></>; break
    case 'toss': art = <><ellipse cx="24" cy="24" rx="15" ry="19" transform="rotate(-28 24 24)" /><path d="M17 12l14 24M19 12l14 24M22 10l14 24" /></>; break
    case 'win': art = <><path d="M15 8h18v9c0 8-4 12-9 12s-9-4-9-12V8ZM24 29v8M16 39h16M15 13H8v4c0 6 4 9 9 9M33 13h7v4c0 6-4 9-9 9" /></>; break
    case 'loss': art = <><path d="M10 11h28v26H10zM16 18h16M16 24h8M16 31h16" /><path d="M30 23l7 8M37 23l-7 8" /></>; break
    case 'points': art = <><path d="M8 12h32v24H8zM15 18h18M15 24h7M15 30h18" /><circle cx="32" cy="25" r="5" /></>; break
    case 'nrr': art = <><path d="M9 16h27M31 11l5 5-5 5M39 32H12M17 27l-5 5 5 5" /><path d="M24 18v12M20 21l4-3 4 3" /></>; break
  }
  return <svg className={className} width={size} height={size} viewBox="0 0 48 48" role={label ? 'img' : 'presentation'} aria-label={label} aria-hidden={label ? undefined : true} {...common}>{art}</svg>
}
