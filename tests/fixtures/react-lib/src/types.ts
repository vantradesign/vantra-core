/**
 * Props shared by every interactive element in the fixture library.
 */
export interface BaseProps {
  /** Extra class names appended to the root element. */
  className?: string
  /** Test hook id. */
  testId?: string
}

/**
 * Visual emphasis of a control.
 */
export type Variant = 'primary' | 'secondary' | 'danger'

/**
 * Supported control sizes.
 */
export enum Size {
  Small = 'sm',
  Medium = 'md',
  Large = 'lg',
}

/** Default size applied when none is given. */
export const DEFAULT_SIZE = 'md'
