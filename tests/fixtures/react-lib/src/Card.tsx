import * as React from 'react'
import { Button } from './Button'
import type { BaseProps } from './types'

/**
 * Props for the card container.
 */
export interface CardProps extends BaseProps {
  /** Heading shown at the top of the card. */
  title: string
  /** Body content. */
  children?: React.ReactNode
  /** Elevation step, mapped onto a shadow token. */
  elevation?: number
}

/**
 * A titled surface that groups related content.
 */
export function Card({ title, children, elevation = 1, className }: CardProps) {
  return (
    <section className={className} style={{ boxShadow: `var(--shadow-${elevation})` }}>
      <CardHeader title={title} />
      {children}
      <Button label="Dismiss" variant="secondary" />
    </section>
  )
}

/**
 * Props for the card header.
 */
export interface CardHeaderProps {
  /** Heading text. */
  title: string
  /** Heading level. */
  level?: 1 | 2 | 3
}

/**
 * The heading region of a {@link Card}.
 */
export const CardHeader = ({ title, level = 2 }: CardHeaderProps) => (
  <header style={{ color: 'var(--color-text-heading)' }} data-level={level}>
    {title}
  </header>
)

export default Card
