import React, { useState } from "react";

/**
 * Standardized Avatar component with graceful fallback handling.
 */
const Avatar = ({
  src,
  alt = "User Avatar",
  name = "",
  size = "md", // "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | number
  className = "",
  fallbackSrc = "/default-avatar.png",
}) => {
  const [hasError, setHasError] = useState(false);

  const sizeClasses = {
    xs: "w-5 h-5 text-[10px]",
    sm: "w-8 h-8 text-xs",
    md: "w-10 h-10 text-sm",
    lg: "w-12 h-12 text-base",
    xl: "w-16 h-16 text-lg",
    "2xl": "w-20 h-20 text-xl",
  };

  const currentSizeClass = sizeClasses[size] || (typeof size === "string" ? size : "");

  const initial = (name || alt || "?").trim().charAt(0).toUpperCase();

  if (!src || hasError) {
    return (
      <div
        className={`relative inline-flex shrink-0 items-center justify-center rounded-full overflow-hidden border border-neutral-800 bg-neutral-800 text-neutral-300 font-medium select-none ${currentSizeClass} ${className}`}
      >
        {fallbackSrc ? (
          <img
            src={fallbackSrc}
            alt={alt}
            className="w-full h-full object-cover"
            onError={(e) => {
              // If default avatar also fails, show initial
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <span>{initial}</span>
        )}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setHasError(true)}
      className={`inline-block shrink-0 rounded-full object-cover border border-neutral-800 bg-neutral-900 ${currentSizeClass} ${className}`}
    />
  );
};

export default Avatar;
