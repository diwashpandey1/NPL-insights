import { motion } from 'framer-motion'
import type { ReactNode } from 'react'

type Props = { eyebrow: string; title: string; description: string; action?: ReactNode }

export function SectionHeader({ eyebrow, title, description, action }: Props) {
  return <motion.header className="section-header" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: .24 }}>
    <div><div className="section-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="section-header-action">{action}</div>}
  </motion.header>
}
