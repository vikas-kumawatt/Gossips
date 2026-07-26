import { useState } from "react";
import { Crosshair, MapPin, Search, X } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { attachmentAPI } from "../services/api";

/**
 * Tags a post with a place.
 *
 * Search goes through our own server, which proxies OpenStreetMap's Nominatim
 * — their policy needs an identifying User-Agent a browser can't send, and
 * proxying keeps every keystroke out of a third party's logs.
 *
 * Typing a place name freehand is always available. Geocoders don't know about
 * "my kitchen", and a location tag is a label, not a coordinate.
 */

const LocationPickerSheet = ({ value, onDone, onClose }) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const search = async () => {
    const term = query.trim();
    if (term.length < 2 || loading) return;
    setLoading(true);
    try {
      const data = await attachmentAPI.searchPlaces(term);
      setResults(data?.data?.places || []);
      setError("");
    } catch {
      setError("Place search isn't available right now");
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setError("This device can't share its location");
      return;
    }
    setLocating(true);
    setError("");

    navigator.geolocation.getCurrentPosition(
      async ({ coords }) => {
        try {
          const data = await attachmentAPI.reverseGeocode(coords.latitude, coords.longitude);
          const place = data?.data?.place;
          if (place) {
            setResults([place]);
            setQuery("");
          } else {
            setError("Couldn't find a place there");
          }
        } catch {
          setError("Couldn't look up where you are");
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        // A refusal isn't an error state to apologise for — just say what
        // still works.
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location access was blocked. You can still search or type a place name."
            : "Couldn't get your location"
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  };

  const typedPlace = query.trim();

  return (
    <ResponsiveSheet title="Add location" onClose={onClose} scrollBody={false}>
      {(close) => (
        <div className="flex h-full flex-col">
          <div className="shrink-0 px-4 pt-3 pb-2">
            <form
              className="flex items-center gap-2 rounded-xl bg-neutral-800 px-3 py-2"
              onSubmit={(event) => {
                event.preventDefault();
                search();
              }}
            >
              <Search className="h-4 w-4 shrink-0 text-neutral-400" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setError("");
                }}
                placeholder="Search for a place"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-white outline-none placeholder:text-neutral-500"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setResults([]);
                    setError("");
                  }}
                  className="shrink-0 rounded-full p-1 text-neutral-400 hover:bg-neutral-700 hover:text-white cursor-pointer"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="submit"
                disabled={loading || query.trim().length < 2}
                className="shrink-0 text-[13px] font-semibold text-white disabled:cursor-not-allowed disabled:text-neutral-600 cursor-pointer"
              >
                Search
              </button>
            </form>

            <button
              type="button"
              onClick={useMyLocation}
              disabled={locating}
              className="mt-2 flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-neutral-800 disabled:opacity-50 cursor-pointer"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800">
                {locating ? (
                  <Icons.spinner className="h-4 w-4 animate-spin text-neutral-300" />
                ) : (
                  <Crosshair className="h-4 w-4 text-neutral-300" />
                )}
              </span>
              <span className="text-[15px] font-medium text-white">Use my current location</span>
            </button>

            {value && (
              <button
                type="button"
                onClick={() => {
                  onDone(null);
                  close();
                }}
                className="mt-1 flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-neutral-800 cursor-pointer"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800">
                  <X className="h-4 w-4 text-rose-400" />
                </span>
                <span className="text-[15px] font-medium text-rose-400">Remove location</span>
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain custom-scrollbar px-4 pb-4">
            {error && <p className="px-2 py-3 text-[13px] text-neutral-500">{error}</p>}

            {loading && (
              <div className="flex justify-center py-6">
                <Icons.spinner className="h-6 w-6 animate-spin text-neutral-400" />
              </div>
            )}

            {results.map((place) => (
              <button
                key={place.placeId || `${place.lat},${place.lng}`}
                type="button"
                onClick={() => {
                  onDone(place);
                  close();
                }}
                className="flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-neutral-800 cursor-pointer"
              >
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800">
                  <MapPin className="h-4 w-4 text-neutral-300" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium text-white">
                    {place.name}
                  </span>
                  {place.address && (
                    <span className="block truncate text-[13px] text-neutral-500">
                      {place.address}
                    </span>
                  )}
                </span>
              </button>
            ))}

            {/* Anything you can name, you can tag — the geocoder doesn't get
                the final say on where you are. */}
            {typedPlace.length >= 2 && !loading && (
              <button
                type="button"
                onClick={() => {
                  onDone({ name: typedPlace.slice(0, 120) });
                  close();
                }}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-neutral-800 cursor-pointer"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-dashed border-neutral-700">
                  <MapPin className="h-4 w-4 text-neutral-400" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[15px] text-neutral-300">
                  Use “{typedPlace}”
                </span>
              </button>
            )}

            {!loading && !results.length && typedPlace.length < 2 && !error && (
              <p className="px-2 py-6 text-center text-[13px] text-neutral-500">
                Search for a place, or type any name you like.
              </p>
            )}
          </div>
          <p className="shrink-0 border-t border-neutral-800 px-4 py-2 text-center text-[11px] text-neutral-500">
            Search data ©{" "}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              OpenStreetMap contributors
            </a>
          </p>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default LocationPickerSheet;
