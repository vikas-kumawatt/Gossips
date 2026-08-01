import { useMemo } from "react";
import { buildProfileQr } from "../lib/profileQr";

/**
 * A scannable QR code for a profile, in the app's dot style with the logo in the
 * middle. Geometry comes from lib/profileQr, which the download path also uses,
 * so the saved image is the same code that was on screen.
 */
const ProfileQRCode = ({ value, label, className }) => {
  const qr = useMemo(() => buildProfileQr(value), [value]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      className={className}
      role="img"
      aria-label={label || "Profile QR code"}
    >
      <g fill="white">
        {qr.modules.map((module) => (
          <rect
            key={`${module.x}-${module.y}`}
            x={module.x}
            y={module.y}
            width={module.size}
            height={module.size}
            rx={module.r}
          />
        ))}

        {qr.finders.map((finder, index) => (
          <g key={index}>
            <path d={finder.ring} fillRule="evenodd" />
            <path d={finder.dot} />
          </g>
        ))}

        {/* Sits in a hole cleared from the matrix — see buildProfileQr. */}
        <g transform={qr.logo.transform}>
          {qr.logo.paths.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </g>
      </g>
    </svg>
  );
};

export default ProfileQRCode;
