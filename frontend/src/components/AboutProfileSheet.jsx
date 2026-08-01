import { useEffect, useState } from "react";
import { CalendarDays, ChevronRight, MapPin, AtSign, BadgeCheck } from "lucide-react";
import ResponsiveSheet from "./ui/responsive-sheet";
import { Icons } from "./icons";
import { userAPI } from "../services/api";
import { countryName } from "../lib/countries";

/**
 * About this profile.
 *
 * Every row is here to answer one question: is this account who it says it is?
 * An account created last week, based somewhere that doesn't match its claims,
 * that has changed handle three times, is a different proposition from one
 * that has been in the same place under the same name for two years — and
 * neither fact is visible anywhere else.
 *
 * The old usernames themselves are never shown, only how many there have been.
 * Someone may have changed their name to get away from a person who knew the
 * old one; publishing the trail would hand that person the thread back.
 */

/** "July 2025" — month precision, the same as Instagram and X. */
const monthYear = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
};

/** "12 April 2026" for the last-change date, where the exact day matters. */
const fullDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
};

/*
 * The explainers, reached by tapping a row.
 *
 * A caption under each value can only be a few words, and neither of these
 * facts is honestly summarisable in a few words — "based in" moves with travel,
 * and what a badge does or doesn't attest to takes a paragraph. So the row says
 * the fact and the panel behind it does the explaining, which is also where
 * Instagram put this.
 */
const EXPLAINERS = {
  country: {
    title: "Based in",
    body: [
      "The country or region that an account is based can be impacted by recent travel or temporary relocation. This data may not be accurate and can change periodically.",
    ],
  },
  verified: {
    title: "Verified badge",
    body: [
      "The verified badge means an account has been verified based on their activity across our products and information or documents they provide. Some verified accounts are owned by a notable person, brand or entity, while others subscribe to Gossips Premium.",
      "With a Gossips Premium subscription, you get a verified badge, proactive account protection, access to direct account support and more.",
    ],
  },
};

/**
 * One fact. `onOpen` makes it a button with a chevron; without it the row is
 * static, so nothing looks tappable that isn't.
 */
const Row = ({ icon, label, value, hint, onOpen }) => {
  const body = (
    <>
      <span className="mt-0.5 shrink-0 text-neutral-400">{icon}</span>
      <div className="min-w-0 flex-1 text-left">
        <p className="text-[13px] text-neutral-400">{label}</p>
        <p className="text-[15px] text-white break-words">{value}</p>
        {hint && <p className="mt-0.5 text-[12px] text-neutral-500">{hint}</p>}
      </div>
      {onOpen && (
        <ChevronRight className="mt-2.5 h-4 w-4 shrink-0 text-neutral-500" aria-hidden="true" />
      )}
    </>
  );

  if (!onOpen) {
    return <div className="flex items-start gap-3.5 px-5 py-3.5">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-start gap-3.5 px-5 py-3.5 text-left transition-colors hover:bg-neutral-800/50"
    >
      {body}
    </button>
  );
};

const AboutProfileSheet = ({ username, onClose }) => {
  const [about, setAbout] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  /*
   * A step inside this sheet rather than a second sheet stacked on top. The
   * sheet already supports a back chevron, and two overlapping sheets means two
   * backdrops, two scroll locks and an Escape that closes the wrong one.
   */
  const [explainer, setExplainer] = useState(null);

  useEffect(() => {
    let cancelled = false;

    userAPI
      .getProfileAbout(username)
      .then((data) => {
        if (!cancelled) setAbout(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.response?.data?.error || "Couldn't load these details");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [username]);

  const changes = about?.usernameChanges;
  const country = countryName(about?.country);
  const open = explainer ? EXPLAINERS[explainer] : null;

  return (
    <ResponsiveSheet
      title={open ? open.title : "About this profile"}
      onClose={onClose}
      onBack={open ? () => setExplainer(null) : undefined}
    >
      {open ? (
        <div className="px-5 py-6">
          {open.body.map((paragraph, i) => (
            <p
              key={i}
              className={`text-[14px] leading-relaxed text-neutral-300 ${i > 0 ? "mt-4" : ""}`}
            >
              {paragraph}
            </p>
          ))}
        </div>
      ) : loading ? (
        <div className="flex justify-center py-16">
          <Icons.spinner className="h-7 w-7 animate-spin text-neutral-400" />
        </div>
      ) : error ? (
        <p className="py-16 text-center text-sm text-neutral-500">{error}</p>
      ) : (
        <div className="pb-4">
          <div className="flex flex-col items-center gap-2 px-5 pb-5 pt-6">
            <img
              src={about.profilePic}
              alt={about.name || about.username}
              className="h-20 w-20 rounded-full border-2 border-neutral-700 object-cover"
              referrerPolicy="no-referrer"
            />
            {/* Falling back to the username here would print it twice, once
                with an @ and once without. */}
            {about.name && (
              <div className="flex min-w-0 max-w-full items-center gap-1.5">
                {/* The name truncates; the badge never does. */}
                <p className="min-w-0 truncate text-[17px] font-bold text-white">
                  {about.name}
                </p>
                {about.isVerified && (
                  <span className="shrink-0">
                    <Icons.verified2 />
                  </span>
                )}
              </div>
            )}
            <div className="flex min-w-0 max-w-full items-center gap-1.5">
              <p
                className={`min-w-0 truncate ${
                  about.name
                    ? "text-[14px] text-neutral-400"
                    : "text-[17px] font-bold text-white"
                }`}
              >
                @{about.username}
              </p>
              {about.isVerified && !about.name && (
                <span className="shrink-0">
                  <Icons.verified2 />
                </span>
              )}
            </div>
          </div>

          <p className="px-5 pb-4 text-center text-[13px] leading-relaxed text-neutral-500">
            To help keep our community authentic, we're sharing information
            about accounts on Gossips.
          </p>

          <div className="divide-y divide-neutral-800 border-y border-neutral-800">
            <Row
              icon={<CalendarDays className="h-[18px] w-[18px]" />}
              label="Date joined"
              value={monthYear(about.dateJoined) || "Unknown"}
            />

            {/*
              Only shown when we actually know. "Based in Unknown" is worse
              than no row at all — and behind a host with no geo header, that's
              every account.
            */}
            {country && (
              <Row
                icon={<MapPin className="h-[18px] w-[18px]" />}
                label="Based in"
                value={country}
                onOpen={() => setExplainer("country")}
              />
            )}

            {about.isVerified && (
              <Row
                icon={<BadgeCheck className="h-[18px] w-[18px]" />}
                label="Verified"
                value={
                  about.verifiedAt
                    ? `Since ${monthYear(about.verifiedAt)}`
                    : "This account is verified"
                }
                onOpen={() => setExplainer("verified")}
              />
            )}

            {/* Only when there's something to say. Almost nobody has ever
                changed their handle, and "Never changed" on every profile
                trains people to skip the row that matters on the few where it
                isn't zero. */}
            {changes?.count > 0 && (
              <Row
                icon={<AtSign className="h-[18px] w-[18px]" />}
                label="Username changes"
                value={`Changed ${changes.count} time${changes.count === 1 ? "" : "s"}`}
                hint={
                  changes.lastChangedAt ? `Last on ${fullDate(changes.lastChangedAt)}` : null
                }
              />
            )}
          </div>
        </div>
      )}
    </ResponsiveSheet>
  );
};

export default AboutProfileSheet;
