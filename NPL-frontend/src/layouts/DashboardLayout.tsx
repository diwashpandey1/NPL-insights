import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Activity, Menu, X } from 'lucide-react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { SeasonSelector } from '../components/ui/SeasonSelector'

const links = [
  { label: 'Overview', to: '/', mark: '01' },
  { label: 'Players', to: '/players', mark: '02' },
  { label: 'Teams', to: '/teams', mark: '03' },
  { label: 'Matches', to: '/matches', mark: '04' },
  { label: 'Points Table', to: '/standings', mark: '05' },
  { label: 'Head-to-Head', to: '/head-to-head', mark: '06' },
]

export function DashboardLayout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()
  return <div className="site-frame">
    <header className="site-header">
      <div className="masthead wrap">
        <Link to="/" className="brand-home" aria-label="NPL Cricket Analytics home"><img src="/assets/branding/npl-can-brand.png" alt="Nepal Premier League with Cricket Association of Nepal governing association" /></Link>
        <div className="masthead-tools"><span className="masthead-caption"><Activity size={14} /> CRICKET ANALYTICS</span><SeasonSelector compact /><button className="mobile-menu-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={19} /> : <Menu size={19} />}</button></div>
      </div>
      <nav className={`league-nav ${menuOpen ? 'league-nav--open' : ''}`} aria-label="Main navigation">
        <div className="league-nav-inner wrap">{links.map(({ label, to, mark }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMenuOpen(false)} className={({ isActive }) => `league-nav-link ${isActive ? 'active' : ''}`}><span className="nav-mark">{mark}</span>{label}</NavLink>)}<span className="nav-side-label">NEPAL PREMIER LEAGUE <b>·</b> EST. 2024</span></div>
      </nav>
    </header>
    <main className="site-main wrap">
      <AnimatePresence mode="wait" initial={false}><motion.div key={pathname} initial={{ opacity: 0, y: 7 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: .18 }}><Outlet /></motion.div></AnimatePresence>
    </main>
    <footer className="site-footer">
      <div className="footer-inner wrap"><div className="footer-brand"><img src="/assets/branding/npl-can-brand.png" alt="NPL and Cricket Association of Nepal" /><p>A clearer view of Nepal Premier League cricket.</p></div><div className="footer-links"><span>EXPLORE</span><Link to="/matches">Match centre</Link><Link to="/standings">Points table</Link><Link to="/teams">Teams</Link></div><div className="footer-note"><span>DATA NOTE</span><p>Statistics and match feeds are not connected in this visual prototype. Placeholder values are shown as dashes.</p><small>Team and association marks remain the property of their respective owners.</small></div></div>
      <div className="footer-bottom wrap"><span>© NPL Cricket Analytics</span><Link to="/teams">Brand asset sources</Link><span>Built for the love of the game in Nepal.</span></div>
    </footer>
  </div>
}
