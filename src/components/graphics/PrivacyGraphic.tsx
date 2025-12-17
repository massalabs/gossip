import { GraphicProps } from './types';

export function PrivacyGraphic({
  size = 300,
  className = '',
  loading = false,
  outerColor = 'fill-graphic-accent',
  innerColor = 'fill-card',
  detailColor = 'fill-foreground',
}: GraphicProps) {
  return (
    <div
      className={`relative w-full flex items-center justify-center py-8 ${className}`}
    >
      {/* Glow effect background */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={`rounded-full blur-3xl ${
            loading ? 'animate-pulse-loading' : 'animate-pulse-slow'
          } bg-black/10 dark:bg-white/5`}
          style={{
            width: `${size}px`,
            height: `${size}px`,
          }}
        />
      </div>

      <svg
        viewBox="0 0 393 405"
        className={`${
          loading ? 'animate-float-loading' : 'animate-float'
        } text-gray-900 dark:text-white drop-shadow-[0_0_18px_rgba(0,0,0,0.12)] dark:drop-shadow-[0_0_30px_rgba(255,255,255,0.3)] overflow-visible`}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          overflow: 'visible',
        }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <g className={loading ? 'animate-tilt-loading' : 'animate-tilt'}>
          {/* Outer body (brand shape) */}
          <path
            d="M277.355 124.64C258.156 107.568 230.871 98.9 196.269 98.9C178.979 98.9 163.484 101.061 149.899 105.372C136.303 109.672 124.616 116.11 114.919 124.663C95.7313 141.61 86 166.321 86 198.111C86 217.07 89.5334 233.571 96.486 247.122C103.358 260.512 113.776 271.124 127.498 278.648L130.185 280.124V293.663L130.025 297.173C135.811 295.447 143.107 294.589 152.095 294.589H196.269C230.883 294.589 258.178 286.093 277.401 269.34C296.372 252.782 306 228.814 306 198.111C306 167.408 296.36 141.587 277.355 124.64Z"
            className={`${outerColor} opacity-90`}
          />
          {/* Inner face */}
          <path
            d="M259.322 137.082C245.154 124.686 223.942 118.408 196.269 118.408C168.596 118.408 147.315 124.675 132.998 137.059C118.453 149.58 111.054 169.215 111.054 195.355V199.781C111.054 225.91 118.43 245.521 133.01 258.077C147.338 270.45 168.619 276.716 196.269 276.716C223.919 276.716 245.154 270.45 259.322 258.065C273.684 245.475 280.98 225.864 280.98 199.781V195.355C280.98 169.26 273.684 149.649 259.322 137.082ZM148.584 225.761C137.195 225.761 127.967 216.533 127.967 205.155C127.967 193.777 137.195 184.538 148.584 184.538C159.974 184.538 169.19 193.766 169.19 205.155C169.19 216.544 159.962 225.761 148.584 225.761ZM203.061 225.761C191.672 225.761 182.444 216.533 182.444 205.155C182.444 193.777 191.672 184.538 203.061 184.538C214.451 184.538 223.667 193.766 223.667 205.155C223.667 216.544 214.439 225.761 203.061 225.761Z"
            className={innerColor}
          />
          {/* Left eye with blink animation */}
          <g
            className={`${
              loading ? 'animate-blink-loading' : 'animate-blink'
            } origin-center`}
            style={{ transformOrigin: '148.584px 205.155px' }}
          >
            <circle
              cx="148.584"
              cy="205.155"
              r="21.617"
              className={detailColor}
            />
          </g>
          {/* Right eye with blink animation */}
          <g
            className={`${
              loading ? 'animate-blink-loading' : 'animate-blink'
            } origin-center`}
            style={{ transformOrigin: '203.061px 205.155px' }}
          >
            <circle
              cx="203.061"
              cy="205.155"
              r="21.617"
              className={detailColor}
            />
          </g>
        </g>
      </svg>
    </div>
  );
}
