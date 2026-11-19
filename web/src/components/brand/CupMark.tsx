interface CupMarkProps {
  className?: string;
}

export function CupMark({ className = 'size-5' }: CupMarkProps) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path
        d="M5 7.5 7.5 19.2c.25 1.05 1.15 1.8 2.2 1.8h3.6c1.05 0 1.95-.75 2.2-1.8L18 7.5H5Z"
        className="fill-sheet stroke-ink"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M4 7.5h15"
        className="stroke-ink"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
      <path
        d="M11.5 21c0 2.7 3.8 3.6 7.8 2.7 2.8-.65 4.8-2.3 5.5-5.3"
        className="stroke-string"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="24.9" cy="17.8" r="1.5" className="fill-string" />
    </svg>
  );
}
