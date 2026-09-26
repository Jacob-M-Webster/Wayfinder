import { createElement } from 'react'
import type { IconNode } from 'lucide'

type IconProps = {
  icon: IconNode
  className?: string
}

export function Icon({ icon, className }: IconProps) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icon.map(([tag, attrs], index) => createElement(tag, { ...attrs, key: index }))}
    </svg>
  )
}
