// The mark: a pair of brackets with the payload slipping out through a gap,
// which is what prompt injection does. Same drawing as app/icon.svg; in the
// app it sits on the page with no tile behind it.
export default function Logo({ size = 24 }: { size?: number }) {
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2.6, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg width={size} height={size} viewBox="4 4 24 24" aria-hidden="true" className="logo">
      <path d="M12.5 8H9.5v16h3" {...stroke} />
      <path d="M19.5 8h3v6" {...stroke} />
      <path d="M22.5 21v3h-3" {...stroke} />
      <rect x="21" y="15.5" width="5" height="3" rx="1.5" fill="#ff5a36" />
    </svg>
  );
}
