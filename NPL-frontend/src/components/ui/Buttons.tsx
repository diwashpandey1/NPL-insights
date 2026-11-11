import type { ButtonHTMLAttributes, PropsWithChildren } from 'react'

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>>
export function PrimaryButton({ children, className = '', ...props }: Props) { return <button className={`button button-primary ${className}`} {...props}>{children}</button> }
export function SecondaryButton({ children, className = '', ...props }: Props) { return <button className={`button button-secondary ${className}`} {...props}>{children}</button> }
