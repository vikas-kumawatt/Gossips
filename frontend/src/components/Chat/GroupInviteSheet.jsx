import React, { useEffect, useState } from "react";
import { Link2, QrCode, RefreshCw, Share2 } from "lucide-react";
import { toast } from "react-hot-toast";
import ResponsiveSheet from "../ui/responsive-sheet";
import { Icons } from "../icons";
import ConfirmDialog from "../ui/ConfirmDialog";
import GroupQrSheet from "./GroupQrSheet";
import { groupAPI } from "../../services/api";
import { buildGroupInviteUrl } from "../../lib/groupLink";
import {
  EXTERNAL_TARGETS,
  canUseNativeShare,
  nativeShare,
  openShareTarget,
} from "../../lib/shareTargets";

/**
 * A group's invite link, and the ways out of it.
 *
 * Fetches the token on open rather than with the group: most groups are never shared,
 * and the server only mints a token when one is asked for — so opening this sheet is
 * what creates the link.
 *
 * The external row is the app's existing `EXTERNAL_TARGETS`, which already includes
 * Instagram. Instagram has no web share intent, so that entry is `copyOnly`: the link
 * goes to the clipboard and the app opens. That's a limitation of Instagram, not
 * something to work around here.
 */

const ActionRow = ({ icon, label, hint, onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-neutral-800 disabled:opacity-50"
  >
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-800 text-white">
      {icon}
    </span>
    <span className="min-w-0">
      <span className="block text-[14px] font-medium text-white">{label}</span>
      {hint && <span className="block text-xs text-neutral-500">{hint}</span>}
    </span>
  </button>
);

const GroupInviteSheet = ({ groupId, group, memberCount, onClose }) => {
  const [token, setToken] = useState(null);
  const [canRotate, setCanRotate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showExternal, setShowExternal] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await groupAPI.getInvite(groupId);
        if (cancelled) return;
        setToken(res.token);
        setCanRotate(!!res.canRotate);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const inviteUrl = buildGroupInviteUrl(token);
  const shareText = `Join ${group?.name || "this group"} on Gossips`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  };

  const rotate = async () => {
    setRotating(true);
    try {
      const res = await groupAPI.rotateInvite(groupId);
      setToken(res.token);
      setConfirmRotate(false);
      toast.success("New link created");
    } catch (err) {
      toast.error(err?.response?.data?.error || "Couldn't reset the link");
    } finally {
      setRotating(false);
    }
  };

  const openExternal = async (target) => {
    /*
     * Copy first, then open. `copyOnly` targets (Instagram, Threads) can't accept a
     * URL, so the clipboard *is* the mechanism — and doing it before `window.open`
     * matters because the clipboard write needs the user activation the click gave us,
     * which opening a tab can consume.
     */
    try {
      await navigator.clipboard.writeText(inviteUrl);
    } catch {
      // A refused clipboard shouldn't stop the app from opening.
    }
    openShareTarget(target, inviteUrl, shareText);
    if (target.note) toast.success(target.note);
  };

  // The QR sheet replaces this one rather than stacking on it — two sheets deep on a
  // phone leaves neither fully visible.
  if (showQr) {
    return (
      <GroupQrSheet
        group={group}
        inviteUrl={inviteUrl}
        memberCount={memberCount}
        onClose={() => setShowQr(false)}
      />
    );
  }

  return (
    <>
      <ResponsiveSheet title="Invite link" onClose={onClose}>
        <div className="px-3 pb-4">
          <p className="px-2 pt-1 pb-3 text-sm text-neutral-400">
            Anyone can join your group chat with this link.
          </p>

          {loading ? (
            <p className="px-2 py-6 text-center text-sm text-neutral-500">Loading…</p>
          ) : failed ? (
            <p className="px-2 py-6 text-center text-sm text-neutral-500">
              Couldn't load the invite link. Try again.
            </p>
          ) : (
            <>
              {/* The link itself, visible. A "Copy" button with nothing to look at
                  gives no way to check what you're about to send. */}
              <p className="mx-2 mb-3 px-3 py-2.5 rounded-xl bg-neutral-900 border border-neutral-800 text-xs text-neutral-300 break-all">
                {inviteUrl}
              </p>

              <ActionRow
                icon={<Link2 className="w-[18px] h-[18px]" strokeWidth={2.1} />}
                label="Copy link"
                onClick={copy}
              />

              {canUseNativeShare() && (
                <ActionRow
                  icon={<Share2 className="w-[18px] h-[18px]" strokeWidth={2.1} />}
                  label="Share"
                  onClick={() => nativeShare(inviteUrl, shareText)}
                />
              )}

              <ActionRow
                icon={<QrCode className="w-[18px] h-[18px]" strokeWidth={2.1} />}
                label="QR code"
                onClick={() => setShowQr(true)}
              />

              <ActionRow
                icon={<Icons.shareTo className="w-[18px] h-[18px]" />}
                label="Send in an app"
                hint="Instagram, WhatsApp, and more"
                onClick={() => setShowExternal((v) => !v)}
              />

              {showExternal && (
                /* Horizontal scroll, not a 4-column grid: the target list grows and a
                   grid reflows into rows that push the Reset row off the sheet. Same
                   treatment ShareSheet gives the same list. */
                <div className="flex gap-1 overflow-x-auto custom-scrollbar px-1 pt-2 pb-1">
                  {EXTERNAL_TARGETS.map((target) => {
                    // `Icons[target.icon]` — the per-app glyphs already exist.
                    const Icon = Icons[target.icon];
                    return (
                      <button
                        key={target.id}
                        type="button"
                        onClick={() => openExternal(target)}
                        className="flex flex-col items-center gap-1.5 p-2 rounded-xl hover:bg-neutral-800 shrink-0 w-[68px]"
                      >
                        <span className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center">
                          {Icon ? <Icon /> : null}
                        </span>
                        <span className="text-[11px] text-neutral-400 text-center leading-tight truncate w-full">
                          {target.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Rotating is the only way to revoke a link that has spread, so it's
                  admin-only and behind a confirmation — everyone's copy stops working. */}
              {canRotate && (
                <>
                  <div className="h-px bg-neutral-800 my-2 mx-2" />
                  <ActionRow
                    icon={<RefreshCw className="w-[18px] h-[18px]" strokeWidth={2.1} />}
                    label="Reset link"
                    hint="The current link stops working"
                    onClick={() => setConfirmRotate(true)}
                  />
                </>
              )}
            </>
          )}
        </div>
      </ResponsiveSheet>

      {confirmRotate && (
        <ConfirmDialog
          title="Reset the invite link?"
          confirmLabel="Reset"
          busy={rotating}
          onConfirm={rotate}
          onCancel={() => setConfirmRotate(false)}
        >
          The current link will stop working for everyone you've sent it to. You'll get a
          new one to share instead.
        </ConfirmDialog>
      )}
    </>
  );
};

export default GroupInviteSheet;
