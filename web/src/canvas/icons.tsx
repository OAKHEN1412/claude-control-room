// Simple mono line icons for canvas nodes. Decorative (aria-hidden); the node carries the label.
import type { ReactNode } from 'react';

function Svg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function ComputerIcon({ size = 26 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Svg>
  );
}

/** Session / AI agent: a rounded face with two eyes and an antenna. */
export function AgentIcon({ size = 28 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 7V4M9.5 12v1.5M14.5 12v1.5" />
      <circle cx="12" cy="3.5" r="1" />
    </Svg>
  );
}

export function ChipIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </Svg>
  );
}

export function BranchIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 8v8M18 11c0 4-6 3-10 6" />
    </Svg>
  );
}

export function FitIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </Svg>
  );
}

export function RearrangeIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <path d="M13 16.5h7M16.5 13v7" />
    </Svg>
  );
}

export function LinkIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  );
}

export function SlidersIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M5 6h8M17 6h2M5 12h2M11 12h8M5 18h10" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </Svg>
  );
}

export function BoltIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M13 3L5 13h6l-1 8 8-10h-6z" />
    </Svg>
  );
}

export function ExpandIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
    </Svg>
  );
}

export function StopIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </Svg>
  );
}

/** "ยึดมาคุม": a window with an arrow pulling into it. */
export function TakeoverIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M12 8v6M9 11.5l3 3 3-3M8 21h8" />
    </Svg>
  );
}

export function PowerIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M12 3v8M7 6.5a8 8 0 1 0 10 0" />
    </Svg>
  );
}

export function TerminalIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 10l3 2.5L7 15M12.5 15H17" />
    </Svg>
  );
}

export function PaneAddIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 9v6M9 12h6" />
    </Svg>
  );
}

export function PinIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />
    </Svg>
  );
}

export function CloseIcon({ size = 14 }: { size?: number }) {
  return (
    <Svg size={size}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}

export function ClockIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg size={size}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}
