import * as React from 'react'
import { useToggle } from './hooks/useToggle'
import type { BaseProps, Variant } from './types'

/**
 * Props accepted by {@link Button}.
 */
export interface ButtonProps extends BaseProps {
  /** Visible label. */
  label: string
  /** Visual emphasis. */
  variant?: Variant
  /** Disables interaction. */
  disabled?: boolean
  /** Invoked on click. */
  onPress?: () => void
}

/**
 * Primary call-to-action button.
 */
export const Button: React.FC<ButtonProps> = ({
  label,
  variant = 'primary',
  disabled = false,
  className,
  onPress,
}) => {
  const [pressed, toggle] = useToggle(false)

  return (
    <button
      className={className}
      disabled={disabled}
      data-variant={variant}
      data-pressed={pressed}
      style={{ background: 'var(--color-brand-primary)', padding: 'var(--spacing-md)' }}
      onClick={() => {
        toggle()
        onPress?.()
      }}
    >
      {label}
    </button>
  )
}
