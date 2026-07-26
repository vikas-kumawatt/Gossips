import { MapPin } from "lucide-react";
import { mapLinkFor } from "../lib/attachments";

/**
 * The place a post was tagged with.
 *
 * Opens OpenStreetMap in a new tab rather than embedding a map: no map library
 * is loaded anywhere in the app, and pulling one in to render a static pin on
 * every card in the feed would cost far more than it's worth.
 */
const LocationChip = ({ location }) => {
  if (!location?.name) return null;

  const href = mapLinkFor(location);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={location.address || location.name}
      className="mb-2 inline-flex max-w-full items-center gap-1 text-[13px] text-neutral-400 transition-colors hover:text-blue-400 hover:underline"
    >
      <MapPin className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{location.name}</span>
    </a>
  );
};

export default LocationChip;
