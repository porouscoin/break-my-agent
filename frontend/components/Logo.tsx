// The mark: a shield cracked down the middle. Same drawing as app/icon.svg.
export default function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="bma-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8B8AFF" />
          <stop offset="1" stopColor="#5B57E8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#bma-logo)" />
      <path d="M16 5.5 L7.5 8.8 V15.2 C7.5 20.6 11 24.6 15.6 26.4 L14.6 21.4 L17 16.6 L14.4 11.6 Z" fill="#fff" />
      <path d="M17.6 5.9 L25.4 8.9 V15.2 C25.4 20.5 22.1 24.4 17.6 26.3 L16.8 21.6 L19.2 16.8 L16.6 11.9 Z" fill="#fff" fillOpacity=".72" />
    </svg>
  );
}
