import React from 'react';

interface UserProfileAvatarProps {
  size?: number; // allowed: 8, 10, 12, 14, 16 (maps to w-*/h-*)
  className?: string;
}

const SIZE_CLASS_MAP: Record<number, string> = {
  8: 'w-8 h-8',
  10: 'w-10 h-10',
  12: 'w-12 h-12',
  14: 'w-14 h-14',
  16: 'w-16 h-16',
};

/**
 * User profile avatar component using the ghost SVG design
 * Adapts to light and dark mode automatically
 */
const UserProfileAvatar: React.FC<UserProfileAvatarProps> = ({
  size = 10,
  className = '',
}) => {
  const sizeClass = SIZE_CLASS_MAP[size] ?? SIZE_CLASS_MAP[10];
  const pixelSize = size * 4; // Convert Tailwind size to pixels (size 10 = 40px, etc.)

  return (
    <div className={`${sizeClass} ${className} shrink-0`}>
      <svg
        width={pixelSize}
        height={pixelSize}
        viewBox="0 0 116 116"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
      >
        <g clipPath="url(#clip0_91_2915)">
          <mask
            id="mask0_91_2915"
            style={{ maskType: 'luminance' }}
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width="116"
            height="116"
          >
            <path
              d="M58 116C90.0325 116 116 90.0325 116 58C116 25.9675 90.0325 0 58 0C25.9675 0 0 25.9675 0 58C0 90.0325 25.9675 116 58 116Z"
              fill="white"
            />
          </mask>
          <g mask="url(#mask0_91_2915)">
            {/* Background circle - uses primary color (teal/cyan) */}
            <path
              d="M58 116C90.0325 116 116 90.0325 116 58C116 25.9675 90.0325 0 58 0C25.9675 0 0 25.9675 0 58C0 90.0325 25.9675 116 58 116Z"
              fill="var(--primary)"
            />
            {/* Ghost body - uses background color (white in light, dark in dark mode) */}
            <path
              d="M31.7708 41.0026C34.9035 38.2393 38.6828 36.1594 43.0715 34.7704C47.4603 33.3777 52.4661 32.6794 58.0555 32.6794C69.2343 32.6794 78.0452 35.4797 84.2478 40.9989C90.3877 46.4738 93.5057 54.4535 93.5057 64.7346C93.5057 75.0157 90.3951 82.3969 84.2626 87.7462C78.0563 93.1583 69.238 95.9031 58.0555 95.9031H43.7808C40.8808 95.9031 38.5202 96.1802 36.6509 96.7343L36.7026 95.6039V91.2262L35.8382 90.7496C31.405 88.3188 28.0359 84.8905 25.8156 80.5645C23.5695 76.1831 22.428 70.856 22.428 64.7309C22.428 54.4608 25.5718 46.4738 31.7708 41.0026ZM30.5221 65.2703C30.5221 73.7117 32.9049 80.0473 37.6151 84.1073C42.244 88.1045 49.1228 90.129 58.0518 90.129C66.9808 90.129 73.8448 88.1045 78.4183 84.1036C83.062 80.0363 85.4152 73.7006 85.4152 65.274V63.848C85.4152 55.414 83.062 49.0783 78.4183 45.022C73.8411 41.0174 66.9882 38.9856 58.0518 38.9856C49.1154 38.9856 42.2366 41.01 37.6077 45.0109C32.9086 49.0598 30.5221 55.3992 30.5221 63.848V65.274V65.2703Z"
              fill="var(--background)"
            />
            {/* Eyes - uses foreground color */}
            <path
              d="M60.2462 73.6672C63.9249 73.6672 66.907 70.6851 66.907 67.0065C66.907 63.3278 63.9249 60.3457 60.2462 60.3457C56.5676 60.3457 53.5854 63.3278 53.5854 67.0065C53.5854 70.6851 56.5676 73.6672 60.2462 73.6672Z"
              fill="var(--foreground)"
            />
            <path
              d="M42.6466 73.6672C46.3252 73.6672 49.3074 70.6851 49.3074 67.0065C49.3074 63.3278 46.3252 60.3457 42.6466 60.3457C38.968 60.3457 35.9858 63.3278 35.9858 67.0065C35.9858 70.6851 38.968 73.6672 42.6466 73.6672Z"
              fill="var(--foreground)"
            />
            {/* Bottom wavy part - uses foreground color */}
            <path
              d="M68.5914 99.7451C73.5491 99.7451 77.5795 103.779 77.5795 108.733V116.369H43.2228V108.733C43.2228 103.776 47.257 99.7451 52.211 99.7451H68.5877M68.5914 93.4648H52.2147C43.8176 93.4648 36.9463 100.336 36.9463 108.733V122.65H83.8635V108.733C83.8635 100.336 76.9921 93.4648 68.5951 93.4648H68.5914Z"
              fill="var(--foreground)"
            />
          </g>
        </g>
        <defs>
          <clipPath id="clip0_91_2915">
            <rect width="116" height="116" fill="white" />
          </clipPath>
        </defs>
      </svg>
    </div>
  );
};

export default UserProfileAvatar;
