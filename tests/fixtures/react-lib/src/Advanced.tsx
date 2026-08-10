import * as React from 'react'
import type { BaseProps } from './types'

/**
 * Props for the forwarded input.
 */
export interface InputProps extends BaseProps {
  /** Current value. */
  value: string
  /** Placeholder shown when empty. */
  placeholder?: string
}

/**
 * A text input that forwards its ref to the underlying element.
 */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { value, placeholder, className },
  ref,
) {
  return <input ref={ref} className={className} value={value} placeholder={placeholder} />
})

/**
 * Props for the memoized badge.
 */
export interface BadgeProps {
  /** Text inside the badge. */
  text: string
  /** Tone of the badge. */
  tone?: 'info' | 'warning'
}

/**
 * A badge that only re-renders when its props change.
 */
export const Badge = React.memo(function Badge({ text, tone = 'info' }: BadgeProps) {
  return <span data-tone={tone}>{text}</span>
})

/**
 * A component that takes no props at all.
 */
export function Divider() {
  return <hr style={{ borderColor: 'var(--color-border-subtle)' }} />
}

/**
 * A component whose props are declared inline rather than as a named type.
 */
export function Spacer({ size = 8 }: { size?: number }) {
  return <div style={{ height: size }} />
}

/**
 * A legacy class component.
 */
export class Legacy extends React.Component<BadgeProps> {
  render() {
    return <span>{this.props.text}</span>
  }
}

/**
 * Props for the banner.
 */
export interface BannerProps {
  /** Message shown to the user. */
  message: string
  /** Severity of the banner. */
  level?: string
}

/**
 * A component that declares defaults the old way.
 */
export function Banner({ message, level }: BannerProps) {
  return <div data-level={level}>{message}</div>
}

Banner.defaultProps = {
  level: 'info',
}
